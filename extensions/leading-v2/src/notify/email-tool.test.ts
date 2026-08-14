import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import type { SmtpConfig } from "./email-client.js";
import { createEmailSendToolFactory, type EmailSender } from "./email-tool.js";

const smtp: SmtpConfig = {
  host: "smtp.exmail.qq.com",
  port: 465,
  user: "sender@example.com",
  password: "authcode",
};

function createApi() {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as OpenClawPluginApi;
}

function parse(result: unknown): Record<string, unknown> {
  const value = result as { details?: unknown; content?: Array<{ text?: string }> };
  if (value.details && typeof value.details === "object") {
    return value.details as Record<string, unknown>;
  }
  const text = value.content?.[0]?.text;
  return text ? JSON.parse(text) : (result as Record<string, unknown>);
}

describe("send_email", () => {
  it("is available only to rabbitmq chat agents when SMTP is configured", () => {
    const factory = createEmailSendToolFactory(createApi(), smtp, vi.fn<EmailSender>());

    expect(factory({ agentId: "telegram-1" })).toBeNull();
    expect(factory({ agentId: "rabbitmq-1749" })?.name).toBe("send_email");
    expect(
      createEmailSendToolFactory(
        createApi(),
        undefined,
        vi.fn<EmailSender>(),
      )({
        agentId: "rabbitmq-1749",
      }),
    ).toBeNull();
  });

  it("requires explicit user confirmation before sending", async () => {
    const sender = vi.fn<EmailSender>();
    const tool = createEmailSendToolFactory(
      createApi(),
      smtp,
      sender,
    )({
      agentId: "rabbitmq-1749",
    })!;

    const result = parse(
      await tool.execute("mail-1", {
        to: "user@qq.com",
        subject: "舆情报告",
        content: "报告正文",
      }),
    );

    expect(result).toEqual({ success: false, error: "请先获得用户对本次邮件发送的明确确认。" });
    expect(sender).not.toHaveBeenCalled();
  });

  it.each([
    [{ to: "not-an-email", subject: "标题", content: "正文", confirmed: true }, "收件邮箱"],
    [
      {
        to: "user@qq.com\r\nBcc: victim@example.com",
        subject: "标题",
        content: "正文",
        confirmed: true,
      },
      "收件邮箱",
    ],
    [
      {
        to: "first@example.com,second@example.com",
        subject: "标题",
        content: "正文",
        confirmed: true,
      },
      "收件邮箱",
    ],
    [{ to: "user@qq.com", subject: "   ", content: "正文", confirmed: true }, "邮件标题"],
    [
      {
        to: "user@qq.com",
        subject: "标题\r\nBcc: victim@example.com",
        content: "正文",
        confirmed: true,
      },
      "邮件标题",
    ],
    [
      { to: "user@qq.com", subject: "标".repeat(201), content: "正文", confirmed: true },
      "邮件标题",
    ],
    [{ to: "user@qq.com", subject: "标题", content: "   ", confirmed: true }, "邮件正文"],
    [
      { to: "user@qq.com", subject: "标题", content: "文".repeat(100_001), confirmed: true },
      "邮件正文",
    ],
  ])("rejects invalid message input %#", async (params, errorPart) => {
    const sender = vi.fn<EmailSender>();
    const tool = createEmailSendToolFactory(
      createApi(),
      smtp,
      sender,
    )({
      agentId: "rabbitmq-1749",
    })!;

    const result = parse(await tool.execute("mail-invalid", params));

    expect(result.success).toBe(false);
    expect(result.error).toContain(errorPart);
    expect(sender).not.toHaveBeenCalled();
  });

  it("sends the validated plain-text message through the configured SMTP account", async () => {
    const sender = vi.fn<EmailSender>().mockResolvedValue(undefined);
    const tool = createEmailSendToolFactory(
      createApi(),
      smtp,
      sender,
    )({
      agentId: "rabbitmq-1749",
    })!;

    const result = parse(
      await tool.execute("mail-2", {
        to: "  user@qq.com  ",
        subject: "  舆情报告  ",
        content: "第一行\n第二行",
        confirmed: true,
      }),
    );

    expect(sender).toHaveBeenCalledWith(smtp, {
      to: "user@qq.com",
      subject: "舆情报告",
      text: "第一行\n第二行",
    });
    expect(result).toEqual({
      success: true,
      to: "user@qq.com",
      subject: "舆情报告",
      message: "邮件已发送。",
    });
  });

  it("limits repeated sends per user", async () => {
    const sender = vi.fn<EmailSender>().mockResolvedValue(undefined);
    const tool = createEmailSendToolFactory(
      createApi(),
      smtp,
      sender,
      () => 1_000,
    )({
      agentId: "rabbitmq-1749",
    })!;
    const params = {
      to: "user@qq.com",
      subject: "标题",
      content: "正文",
      confirmed: true,
    };

    for (let index = 0; index < 10; index += 1) {
      expect(parse(await tool.execute(`mail-${index}`, params)).success).toBe(true);
    }
    const limited = parse(await tool.execute("mail-11", params));

    expect(limited).toEqual({ success: false, error: "邮件发送过于频繁，请稍后再试。" });
    expect(sender).toHaveBeenCalledTimes(10);
  });

  it("returns a generic SMTP failure without leaking recipient or provider details", async () => {
    const api = createApi();
    const sender = vi
      .fn<EmailSender>()
      .mockRejectedValue(new Error("550 rejected user@qq.com with secret detail"));
    const tool = createEmailSendToolFactory(api, smtp, sender)({ agentId: "rabbitmq-1749" })!;

    const result = parse(
      await tool.execute("mail-3", {
        to: "user@qq.com",
        subject: "标题",
        content: "正文",
        confirmed: true,
      }),
    );

    expect(result).toEqual({ success: false, error: "邮件发送失败，请稍后重试。" });
    const logged = vi.mocked(api.logger.error).mock.calls.flat().join(" ");
    expect(logged).not.toContain("user@qq.com");
    expect(logged).not.toContain("secret detail");
  });
});
