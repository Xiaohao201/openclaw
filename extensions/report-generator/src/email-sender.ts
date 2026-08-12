import nodemailer from "nodemailer";
import type { PluginLogger } from "../api.js";
import type { SmtpConfig } from "./types.js";

export interface EmailSendOptions {
  to: string;
  subject: string;
  body: string;
  bodyHtml?: string;
  senderName?: string;
}

interface MailTransport {
  sendMail(message: Record<string, unknown>): Promise<unknown>;
}

type FetchFn = typeof fetch;

function assertHeaderValue(value: string, label: string): void {
  if (!value.trim() || /[\r\n]/u.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

export class EmailSender {
  private readonly smtpTransport?: MailTransport;

  constructor(
    private readonly config: SmtpConfig,
    deps: { smtpTransport?: MailTransport; fetchFn?: FetchFn } = {},
  ) {
    this.fetchFn = deps.fetchFn ?? fetch;
    if (config.transport === "smtp") {
      this.smtpTransport =
        deps.smtpTransport ??
        nodemailer.createTransport({
          host: config.host,
          port: config.port,
          secure: config.port === 465,
          requireTLS: config.port !== 465,
          auth: { user: config.user, pass: config.password },
        });
    }
  }

  private readonly fetchFn: FetchFn;

  async sendEmail(options: EmailSendOptions, logger: PluginLogger): Promise<void> {
    const { to, subject, body, bodyHtml, senderName = "观舆卫士" } = options;
    assertHeaderValue(to, "recipient email");
    assertHeaderValue(subject, "subject");
    assertHeaderValue(senderName, "sender name");
    if (senderName.trim().length > 100) {
      throw new Error("Invalid sender name");
    }

    const displayName = senderName.trim().replace(/["\\]/gu, "");
    const from = `"${displayName}" <${this.config.from || this.config.user}>`;
    logger.info("[EMAIL_SENDER] Sending report email");

    try {
      const message = {
        from,
        to,
        subject,
        text: body,
        html: bodyHtml ?? this.markdownToHtml(body, subject),
      };
      if (this.config.transport === "smtp") {
        if (!this.smtpTransport) {
          throw new Error("SMTP transport unavailable");
        }
        await this.smtpTransport.sendMail(message);
      } else {
        const response = await this.fetchFn(
          `${this.config.proxyProtocol}://${this.config.host}:${this.config.port}/api/send-email`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(this.config.password ? { Authorization: `Bearer ${this.config.password}` } : {}),
            },
            body: JSON.stringify(message),
          },
        );
        if (!response.ok) {
          throw new Error(`Email proxy returned HTTP ${response.status}`);
        }
      }
      logger.info("[EMAIL_SENDER] Report email sent successfully");
    } catch {
      logger.error("[EMAIL_SENDER] Email delivery failed");
      throw new Error("Email delivery failed");
    }
  }

  markdownToHtml(markdown: string, title: string): string {
    const escapeHtml = (text: string): string =>
      text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    const htmlBody = escapeHtml(markdown)
      .replace(/^### (.+)$/gm, "<h3>$1</h3>")
      .replace(/^## (.+)$/gm, "<h2>$1</h2>")
      .replace(/^# (.+)$/gm, "<h1>$1</h1>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/```(\w*)\n([\s\S]*?)```/g, "<pre><code>$2</code></pre>")
      .replace(/`(.+?)`/g, "<code>$1</code>")
      .replace(/^- (.+)$/gm, "<li>$1</li>")
      .replace(/^(\d+)\. (.+)$/gm, "<li>$2</li>")
      .replace(/\n\n/g, "</p><p>")
      .replace(/\n/g, "<br>");

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; }
h1 { border-bottom: 2px solid #0066cc; padding-bottom: 10px; } code, pre { background: #f4f4f4; } pre { padding: 15px; overflow-x: auto; }
.footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; color: #666; font-size: .85em; }
</style></head><body><h1>${escapeHtml(title)}</h1><p>${htmlBody}</p>
<div class="footer"><p>此邮件由观舆卫士 AI 舆情分析师自动发送，请勿直接回复。</p><p>如需管理报告订阅，请访问观舆卫士控制台。</p></div>
</body></html>`;
  }
}
