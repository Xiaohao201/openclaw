import { SessionManager } from "@mariozechner/pi-coding-agent";

/** Only a private copy is opened for writing; the published checkpoint is immutable. */
export function appendRecoveryContext(file: string, request: string): void {
  const manager = SessionManager.open(file);
  manager.appendMessage({ role: "user", content: request, timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [
      {
        type: "text",
        text: "上一轮执行尚未确认完成。保留用户要求；不要假定工具操作成功，也不要自动重试发送、提交等外部操作，须先核对执行结果。",
      },
    ],
    api: "openai-responses",
    provider: "openclaw",
    model: "recovery-checkpoint",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
}
