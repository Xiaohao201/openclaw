import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSmtpConfig, sendEmail } from "./email-client.js";

const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn();
  return { sendMail, createTransport: vi.fn(() => ({ sendMail })) };
});
vi.mock("nodemailer", () => ({ default: { createTransport } }));

describe("SMTP delivery", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it("resolves inline settings and environment fallbacks", () => {
    for (const [name, value] of Object.entries({
      SMTP_HOST: "smtp.test",
      SMTP_PORT: "587",
      SMTP_USER: "env-user",
      SMTP_PASSWORD: "env-password",
      SMTP_FROM: "env-from",
    })) {
      vi.stubEnv(name, value);
    }
    expect(resolveSmtpConfig({})).toEqual({
      host: "smtp.test",
      port: 587,
      user: "env-user",
      password: "env-password",
      from: "env-from",
    });
    expect(
      resolveSmtpConfig({
        smtp: { host: "inline", port: 465, user: "user", password: "password", from: "sender" },
      }),
    ).toEqual({ host: "inline", port: 465, user: "user", password: "password", from: "sender" });
    vi.stubEnv("SMTP_FROM", undefined);
    expect(resolveSmtpConfig({})?.from).toBe("env-user");
  });
  it.each([{ host: "" }, { port: 0 }, { port: "bad" }, { user: "" }, { password: "" }])(
    "rejects incomplete configuration: %j",
    (override) => {
      expect(
        resolveSmtpConfig({
          smtp: { host: "smtp.test", port: 465, user: "user", password: "password", ...override },
        }),
      ).toBeUndefined();
    },
  );
  it("reuses transport and defaults the From address to the account", async () => {
    const cfg = { host: "reuse.test", port: 465, user: "user@example.com", password: "test" };
    const message = { to: "to@example.com", subject: "test", text: "body" };
    await sendEmail(cfg, message);
    await sendEmail(cfg, message);
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenLastCalledWith({ ...message, from: cfg.user });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    sendMail.mockResolvedValue({ accepted: ["to@example.com"] });
  });
  it.each([465, 587])("uses bounded timeouts and the appropriate TLS mode on %s", async (port) => {
    const cfg = {
      host: "smtp.example.com",
      port,
      user: `user${port}`,
      password: "test-secret",
      from: "sender@example.com",
    };
    await sendEmail(cfg, { to: "to@example.com", subject: "test", text: "body" });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: cfg.host,
        port,
        secure: port === 465,
        auth: { user: cfg.user, pass: cfg.password },
        connectionTimeout: 30_000,
        greetingTimeout: 30_000,
        socketTimeout: 60_000,
      }),
    );
    expect(sendMail).toHaveBeenCalledExactlyOnceWith({
      from: cfg.from,
      to: "to@example.com",
      subject: "test",
      text: "body",
    });
  });
  it("propagates an uncertain timeout without retrying", async () => {
    const error = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    sendMail.mockRejectedValueOnce(error);
    await expect(
      sendEmail(
        { host: "smtp.example.com", port: 465, user: "timeout", password: "test" },
        {
          to: "to@example.com",
          subject: "test",
          text: "body",
        },
      ),
    ).rejects.toBe(error);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});
