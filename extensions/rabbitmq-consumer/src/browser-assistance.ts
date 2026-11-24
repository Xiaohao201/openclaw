import { createHmac, randomUUID } from "node:crypto";
import {
  registerBrowserAssistanceSession,
  type BrowserAssistanceControl,
  type BrowserAssistanceNotice,
} from "openclaw/plugin-sdk/browser-assistance";
import WebSocket from "ws";

type Options = {
  sessionKey: string;
  userId: string;
  historyId: number;
  signal?: AbortSignal;
  publish: (notice: BrowserAssistanceNotice) => Promise<void>;
};

/** Feature is opt-in. Neither the relay URL nor its credential comes from a chat message. */
export function browserAssistanceConfig(env = process.env) {
  const url = env.LOBSTER_BROWSER_RELAY_URL;
  const secret = env.LOBSTER_BROWSER_RELAY_SECRET;
  if (!url && !secret) {
    return null;
  }
  if (!url || !secret || secret.length < 32) {
    throw new Error("Browser relay requires a URL and a secret of at least 32 characters");
  }
  const parsed = new URL(url);
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !(
      parsed.protocol === "wss:" ||
      (parsed.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname))
    )
  ) {
    throw new Error("Browser relay must use WSS (WS is allowed only on loopback)");
  }
  return { url, secret };
}

export function signBrowserWorkerTicket(
  secret: string,
  options: Options,
  notice: BrowserAssistanceNotice,
) {
  const body = Buffer.from(
    JSON.stringify({
      version: 1,
      role: "worker",
      userId: options.userId,
      historyId: options.historyId,
      requestId: notice.requestId,
      expiresAt: notice.expiresAt,
      nonce: randomUUID(),
    }),
  ).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

export function startBrowserAssistance(options: Options): (() => Promise<void>) | undefined {
  const config = browserAssistanceConfig();
  if (!config) {
    return undefined;
  }
  let socket: WebSocket | undefined;
  let current: BrowserAssistanceControl | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let serial = Promise.resolve();
  let controllerId = "";
  let sequence = 0;
  let pendingControls = 0;
  const send = (value: unknown) => {
    if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 2_000_000) {
      socket.send(JSON.stringify(value));
    }
  };
  const connect = (control: BrowserAssistanceControl): Promise<void> =>
    new Promise((resolve, reject) => {
      if (stopped || Date.now() >= control.notice.expiresAt) {
        reject(new Error("Browser request expired"));
        return;
      }
      // Keep relay traffic independent of the model runner's global HTTP dispatcher.
      const ws = new WebSocket(config.url, {
        handshakeTimeout: 10_000,
        maxPayload: 20_000,
        perMessageDeflate: false,
        followRedirects: false,
      });
      socket = ws;
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Browser relay is unavailable"));
      }, 10_000);
      ws.addEventListener("open", () =>
        ws.send(
          JSON.stringify({
            type: "hello",
            ticket: signBrowserWorkerTicket(config.secret, options, control.notice),
          }),
        ),
      );
      ws.addEventListener("message", (event) => {
        if (socket !== ws || typeof event.data !== "string" || event.data.length > 20_000) {
          return;
        }
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(event.data);
          if (!data || typeof data !== "object" || Array.isArray(data)) {
            throw new Error("Invalid relay message");
          }
        } catch {
          ws.close();
          return;
        }
        if (data.type === "ready") {
          clearTimeout(timeout);
          resolve();
          return;
        }
        if (pendingControls >= 64) {
          ws.close();
          return;
        }
        pendingControls++;
        serial = serial
          .then(async () => {
            if (stopped || current !== control || socket !== ws) {
              return;
            }
            if (data.type === "viewer-connected" && typeof data.connectionId === "string") {
              controllerId = data.connectionId;
              sequence = 0;
              await control.startFrames((frame) => {
                if (current === control && socket === ws) {
                  send(frame);
                }
              });
            } else if (data.type === "viewer-disconnected") {
              controllerId = "";
              await control.stopFrames();
            } else if (
              data.connectionId === controllerId &&
              controllerId &&
              Number.isSafeInteger(data.sequence) &&
              Number(data.sequence) > sequence
            ) {
              sequence = Number(data.sequence);
              if (data.type === "input") {
                await control.input(data.input);
              } else if (data.type === "complete") {
                const success = await control.complete();
                send({ type: "checked", success });
              }
            }
          })
          .catch(() =>
            send({ type: "error", message: "页面操作未完成，请检查连接或重新打开验证窗口。" }),
          )
          .finally(() => {
            pendingControls--;
          });
      });
      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Browser relay connection failed"));
      });
      ws.addEventListener("close", () => {
        clearTimeout(timeout);
        reject(new Error("Browser relay disconnected"));
        void control.stopFrames();
        if (!stopped && current === control && Date.now() < control.notice.expiresAt) {
          retry = setTimeout(() => {
            void connect(control).catch(() => {});
          }, 1500);
        }
      });
    });
  const dispose = registerBrowserAssistanceSession({
    sessionKey: options.sessionKey,
    signal: options.signal,
    onRequest: async (control) => {
      current = control;
      await connect(control);
      await options.publish(control.notice);
    },
    onState: async (notice) => {
      send({ type: "state", notice });
      await options.publish(notice);
      if (!["waiting", "verifying"].includes(notice.status)) {
        current = undefined;
        if (retry) {
          clearTimeout(retry);
        }
        socket?.close();
      }
    },
  });
  const abort = () => {
    current?.cancel();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  return async () => {
    stopped = true;
    options.signal?.removeEventListener("abort", abort);
    if (retry) {
      clearTimeout(retry);
    }
    socket?.close();
    await dispose();
  };
}
