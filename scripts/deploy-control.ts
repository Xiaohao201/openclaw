import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const commandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("status") }).strict(),
  z.object({ command: z.literal("stop") }).strict(),
  z.object({ command: z.literal("recover") }).strict(),
  z
    .object({
      command: z.literal("deploy"),
      release: z.string().refine(path.isAbsolute),
      compatibleState: z.literal(true),
    })
    .strict(),
]);
export type DeploymentCommand = z.infer<typeof commandSchema>;
const responseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

/** This directory is an administrative capability. Windows deployments must restrict its ACL. */
export async function startDeploymentControl(
  directory: string,
  handle: (command: DeploymentCommand) => Promise<unknown>,
  intervalMs = 250,
) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  const commands = new Set<Promise<void>>();
  const poll = async () => {
    // Claim each request once. A .processing file left by a crash is never replayed.
    const files = (await fs.readdir(directory))
      .filter((name) => /^[a-f0-9-]{36}\.request$/.test(name))
      .toSorted();
    for (const file of files.slice(0, 20)) {
      if (stopped) {
        return;
      }
      const request = path.join(directory, file);
      const processing = request.replace(/\.request$/, ".processing");
      const response = request.replace(/\.request$/, ".response");
      await fs.rename(request, processing);
      const task = (async () => {
        let result: z.infer<typeof responseSchema>;
        try {
          const stat = await fs.lstat(processing);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) {
            throw new Error("Invalid command file");
          }
          const command = commandSchema.parse(JSON.parse(await fs.readFile(processing, "utf8")));
          result = { ok: true, result: await handle(command) };
        } catch (error) {
          result = { ok: false, error: error instanceof Error ? error.message : "Command failed" };
        }
        const temporary = `${response}.tmp`;
        await fs.writeFile(temporary, JSON.stringify(result), { mode: 0o600 });
        await fs.rename(temporary, response);
        await fs.unlink(processing);
      })();
      commands.add(task);
      void task
        .catch((error) => console.error("[deploy] Command failed", error))
        .finally(() => commands.delete(task));
    }
  };
  const schedule = () => {
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      pending = poll()
        .catch((error) => console.error("[deploy] Control channel failed", error))
        .finally(schedule);
    }, intervalMs);
  };
  schedule();
  return {
    async close() {
      stopped = true;
      clearTimeout(timer);
      await pending;
      await Promise.allSettled(commands);
    },
  };
}

export async function sendDeploymentCommand(
  directory: string,
  command: DeploymentCommand,
  timeoutMs = 300_000,
) {
  commandSchema.parse(command);
  const id = randomUUID();
  const request = path.join(directory, `${id}.request`);
  const temporary = `${request}.tmp`;
  const response = path.join(directory, `${id}.response`);
  await fs.writeFile(temporary, JSON.stringify(command), { flag: "wx", mode: 0o600 });
  await fs.rename(temporary, request);
  const expires = Date.now() + timeoutMs;
  while (Date.now() < expires) {
    let raw: string;
    try {
      raw = await fs.readFile(response, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await delay(100);
      continue;
    }
    const reply = responseSchema.parse(JSON.parse(raw));
    await fs.unlink(response);
    if (!reply.ok) {
      throw new Error(reply.error);
    }
    return reply.result;
  }
  throw new Error(
    `Command ${id} timed out; outcome unknown. Inspect status and command files before retrying.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [configFile, action, release, confirmation] = process.argv.slice(2);
  if (!configFile) {
    throw new Error(
      "Usage: deploy-control.ts <supervisor.json> status|stop|recover|deploy [release --compatible-state]",
    );
  }
  const config = z
    .object({ journal: z.string().refine(path.isAbsolute) })
    .parse(JSON.parse(await fs.readFile(configFile, "utf8")));
  const command = commandSchema.parse(
    action === "deploy"
      ? { command: action, release, compatibleState: confirmation === "--compatible-state" }
      : { command: action },
  );
  console.log(JSON.stringify(await sendDeploymentCommand(`${config.journal}.commands`, command)));
}
