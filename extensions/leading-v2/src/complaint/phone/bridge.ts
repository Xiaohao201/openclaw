import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

export const quoteDeviceArgument = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const rpcResponse = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: z.number(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
/** A bounded ADB client; no host shell, Python process, APK or keyboard installation. */
export class PhoneBridge {
  private port?: number;
  private process?: ChildProcess;
  private sequence = 0;
  private readonly deadline: number;
  constructor(
    private readonly options: {
      adbPath: string;
      serial: string;
      jarPath: string;
      signal: AbortSignal;
      timeoutMs?: number;
    },
  ) {
    this.deadline = Date.now() + (options.timeoutMs ?? 110000);
  }
  async run(args: string[], cleanup = false): Promise<Buffer> {
    const remaining = this.deadline - Date.now();
    if (!cleanup && (remaining <= 0 || this.options.signal.aborted)) {
      throw new Error("Phone interrupted");
    }
    return new Promise((resolve, reject) =>
      execFile(
        this.options.adbPath,
        ["-s", this.options.serial, ...args],
        {
          encoding: "buffer",
          windowsHide: true,
          shell: false,
          timeout: cleanup ? 10000 : Math.min(10000, remaining),
          maxBuffer: 10 * 1024 * 1024,
          ...(cleanup ? {} : { signal: this.options.signal }),
        },
        (error, stdout) => (error ? reject(new Error("ADB operation failed")) : resolve(stdout)),
      ),
    );
  }
  async shell(...args: string[]) {
    return (await this.run(["shell", args.map(quoteDeviceArgument).join(" ")])).toString("utf8");
  }
  private async http(path: string, body?: unknown): Promise<unknown> {
    if (this.options.signal.aborted || Date.now() >= this.deadline) {
      throw new Error("Phone interrupted");
    }
    if (!this.port) {
      throw new Error("Phone bridge is not connected");
    }
    const response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.any([
        this.options.signal,
        AbortSignal.timeout(Math.max(1, Math.min(10000, this.deadline - Date.now()))),
      ]),
    });
    if (!response.ok) {
      throw new Error("Phone bridge HTTP error");
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Missing bridge response");
    }
    let text = "";
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        text += decoder.decode(chunk.value, { stream: true });
        if (text.length > 2000000) {
          throw new Error("Phone response too large");
        }
      }
    } finally {
      await reader.cancel();
    }
    return body ? JSON.parse(text) : text;
  }
  async start() {
    const output = (await this.run(["forward", "tcp:0", "tcp:9008"])).toString().trim();
    if (!/^\d+$/.test(output) || Number(output) < 1 || Number(output) > 65535) {
      throw new Error("Invalid ADB forward port");
    }
    this.port = Number(output);
    try {
      if ((await this.http("/ping")) === "pong") {
        return;
      }
    } catch {
      /* Start only if no server responds. */
    }
    const jar = await readFile(this.options.jarPath);
    this.options.signal.throwIfAborted();
    if (
      createHash("sha256").update(jar).digest("hex") !==
      "0b74e83c55f443539a9f76f5ce023a51466b764b1100e4097a897053fdfc0eb6"
    ) {
      throw new Error("Phone server integrity mismatch");
    }
    const remote = "/data/local/tmp/openclaw-u2-3.7.0.jar";
    await this.run(["push", this.options.jarPath, remote]);
    this.process = spawn(
      this.options.adbPath,
      [
        "-s",
        this.options.serial,
        "shell",
        `CLASSPATH=${quoteDeviceArgument(remote)} app_process / com.wetest.uia2.Main -p 9008`,
      ],
      { shell: false, windowsHide: true, stdio: "ignore" },
    );
    let failed = false;
    this.process.on("error", () => {
      failed = true;
    });
    for (let attempt = 0; attempt < 30; attempt++) {
      if (failed || this.options.signal.aborted || Date.now() >= this.deadline) {
        break;
      }
      try {
        if ((await this.http("/ping")) === "pong") {
          return;
        }
      } catch {
        /* Bounded startup probe, never a submission retry. */
      }
      await sleep(250);
    }
    throw new Error("Phone service failed to start");
  }
  async call(method: string, ...params: unknown[]): Promise<unknown> {
    const id = ++this.sequence;
    const response = rpcResponse.parse(
      await this.http("/jsonrpc/0", { jsonrpc: "2.0", id, method, params }),
    );
    if (response.id !== id || response.error || !("result" in response)) {
      throw new Error("Phone RPC failed");
    }
    return response.result;
  }
  async close() {
    this.process?.kill();
    if (this.port) {
      await this.run(["forward", "--remove", `tcp:${this.port}`], true);
    }
    this.port = undefined;
  }
}
