export type LoginResult = {
  state: "awaiting_login" | "saved" | "cancelled" | "expired" | "busy" | "failed";
  message: string;
  screenshot?: string;
  errorCode?: string;
};
export type LoginConnection = {
  targetId: string;
  screenshot: () => Promise<string>;
  release: () => Promise<void>;
};
const waiting: LoginResult = {
  state: "awaiting_login",
  message: "请在当前 OpenClaw 标签页完成登录或验证，完成后确认；不会提交举报。",
};
const failure: LoginResult = {
  state: "failed",
  message: "浏览器登录会话发生异常，未执行举报。请重新检查当前标签页。",
  errorCode: "BROWSER_LOGIN_FAILED",
};
export class LoginHandoffRequired extends Error {}

/** Serializes interactive actions without retaining login screenshots in status. */
export class LoginSession {
  latest: LoginResult = { state: "busy", message: "正在连接当前对话的浏览器标签页。" };
  closed = false;
  targetId?: string;
  private connection?: LoginConnection;
  private operation?: Promise<LoginResult>;
  private closing?: Promise<LoginResult>;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    readonly params: {
      platform: string;
      sessionKey: string;
      sessionId: string;
      connect: () => Promise<LoginConnection>;
      onError?: (error: unknown, stage: "connect" | "screenshot" | "release") => void;
    },
  ) {}

  private report(error: unknown, stage: "connect" | "screenshot" | "release") {
    try {
      this.params.onError?.(error, stage);
    } catch {
      // Logging must never prevent releasing the borrowed browser.
    }
  }

  private run(work: () => Promise<LoginResult>): Promise<LoginResult> {
    if (this.operation || this.closing) {
      return Promise.resolve({
        state: "busy",
        message: "登录操作正在处理，请稍后查询；不要重复开启登录。",
      });
    }
    this.operation = Promise.resolve()
      .then(work)
      .finally(() => {
        this.operation = undefined;
      });
    return this.operation;
  }

  start(): Promise<LoginResult> {
    if (this.closed || this.connection) {
      return Promise.resolve(this.latest);
    }
    return this.run(async () => {
      try {
        this.connection = await this.params.connect();
        this.targetId = this.connection.targetId;
        this.latest = { ...waiting };
        this.timer = setTimeout(() => {
          void this.stop("expired");
        }, 600000);
        this.timer.unref();
        return this.latest;
      } catch (error) {
        this.report(error, "connect");
        this.latest =
          error instanceof LoginHandoffRequired
            ? {
                state: "failed",
                message: "请先在当前对话用 browser 打开并查看平台标签页，再发起登录。",
                errorCode: "BROWSER_HANDOFF_REQUIRED",
              }
            : { ...failure };
        this.closed = true;
        return this.latest;
      }
    });
  }

  command(action: "screenshot" | "finish" | "cancel"): Promise<LoginResult> {
    if (this.closed) {
      return Promise.resolve(this.latest);
    }
    return this.run(async () => {
      if (action !== "screenshot") {
        return this.close(action === "finish" ? "saved" : "cancelled");
      }
      try {
        if (!this.connection) {
          throw new Error("Login connection missing");
        }
        const screenshot = await this.connection.screenshot();
        if (screenshot.length > 4000000) {
          throw new Error("Login screenshot too large");
        }
        return { ...waiting, screenshot };
      } catch (error) {
        this.report(error, "screenshot");
        return this.close("failed");
      }
    });
  }

  private close(state: "saved" | "cancelled" | "expired" | "failed"): Promise<LoginResult> {
    if (this.closing) {
      return this.closing;
    }
    if (this.closed) {
      return Promise.resolve(this.latest);
    }
    clearTimeout(this.timer);
    this.closing = Promise.resolve().then(async () => {
      try {
        await this.connection?.release();
        this.latest =
          state === "failed"
            ? { ...failure }
            : {
                state,
                message:
                  state === "saved"
                    ? "登录态保留在同一 OpenClaw 浏览器；确认结束不代表平台登录验证或举报成功。原标签页保持打开，旧批次不会自动重提。"
                    : state === "expired"
                      ? "登录会话已超时结束，原标签页保持打开；请重新查看页面后发起登录。"
                      : "登录流程已结束，原标签页保持打开；已有登录变化不会撤销，未提交举报。",
              };
      } catch (error) {
        this.report(error, "release");
        this.latest = { ...failure };
      } finally {
        this.closed = true;
      }
      return this.latest;
    });
    return this.closing;
  }

  async stop(state: "cancelled" | "expired" = "cancelled"): Promise<void> {
    await this.operation;
    await this.close(state);
  }
}
