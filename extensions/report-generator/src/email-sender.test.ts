import { describe, expect, it, vi } from "vitest";
import type { PluginLogger } from "../api.js";
import { EmailSender } from "./email-sender.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as PluginLogger;

describe("EmailSender", () => {
  it("uses the topic sender as the configured From display name over SMTP", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "1" });
    const sender = new EmailSender(
      {
        transport: "smtp",
        proxyProtocol: "http",
        host: "mail-proxy",
        port: 8080,
        user: "reports@example.com",
        password: "secret",
        from: "reports@example.com",
        defaultSender: "观舆卫士",
      },
      { smtpTransport: { sendMail } },
    );

    await sender.sendEmail(
      {
        to: "reader@example.com",
        subject: "日报",
        body: "内容",
        senderName: "专题观察员",
      },
      logger,
    );

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '"专题观察员" <reports@example.com>',
        to: "reader@example.com",
      }),
    );
  });

  it("rejects CRLF in the sender display name", async () => {
    const sendMail = vi.fn();
    const sender = new EmailSender(
      {
        transport: "smtp",
        proxyProtocol: "http",
        host: "mail-proxy",
        port: 8080,
        user: "reports@example.com",
        password: "secret",
        from: "reports@example.com",
        defaultSender: "观舆卫士",
      },
      { smtpTransport: { sendMail } },
    );

    await expect(
      sender.sendEmail(
        {
          to: "reader@example.com",
          subject: "日报",
          body: "内容",
          senderName: "观舆卫士\r\nBcc: attacker@example.com",
        },
        logger,
      ),
    ).rejects.toThrow("Invalid sender name");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("keeps the existing HTTP email proxy as the compatible default mode", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const sender = new EmailSender(
      {
        transport: "http",
        proxyProtocol: "http",
        host: "mail-proxy",
        port: 8080,
        user: "reports@example.com",
        password: "proxy-token",
        from: "reports@example.com",
        defaultSender: "观舆卫士",
      },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );

    await sender.sendEmail({ to: "reader@example.com", subject: "日报", body: "内容" }, logger);

    expect(fetchFn).toHaveBeenCalledWith(
      "http://mail-proxy:8080/api/send-email",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
