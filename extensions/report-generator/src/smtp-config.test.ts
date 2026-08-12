import { describe, expect, it, vi } from "vitest";
import { resolveSmtpConfig } from "./smtp-config.js";

describe("resolveSmtpConfig", () => {
  it("maps the standalone SMTP JSON format without exposing its password", () => {
    const readFile = vi.fn().mockReturnValue(
      JSON.stringify({
        host: "smtp.exmail.qq.com",
        protocol: "ssl",
        port: 465,
        password: "authorization-code",
        user: "info@example.com",
        senderEmail: "info@example.com",
        senderName: "观舆卫士",
      }),
    );

    const config = resolveSmtpConfig({ configFile: "E:/secure/smtp.json" }, { readFile });

    expect(readFile).toHaveBeenCalledWith("E:/secure/smtp.json", "utf8");
    expect(config).toEqual({
      transport: "smtp",
      proxyProtocol: "http",
      host: "smtp.exmail.qq.com",
      port: 465,
      user: "info@example.com",
      password: "authorization-code",
      from: "info@example.com",
      defaultSender: "观舆卫士",
    });
  });

  it("rejects an SMTP file with missing required fields", () => {
    expect(() =>
      resolveSmtpConfig(
        { configFile: "smtp.json" },
        { readFile: () => JSON.stringify({ host: "smtp.example.com" }) },
      ),
    ).toThrow("Invalid SMTP config file");
  });
});
