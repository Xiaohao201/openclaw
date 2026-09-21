import { Type } from "@sinclair/typebox";
import { buildPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult, wrapExternalContent } from "openclaw/plugin-sdk/provider-web-fetch";
import { z } from "zod";
import { PhoneError, readPhone } from "./src/reader.js";

const configSchema = z
  .object({
    adbPath: z.string().min(1).optional(),
    serial: z.string().min(1).optional(),
    apps: z
      .array(
        z
          .object({
            host: z.string().min(1),
            package: z.string().regex(/^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+$/),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export default definePluginEntry({
  id: "phone-reader",
  name: "Phone Reader",
  description: "Read links using a connected Android phone when web access fails.",
  configSchema: buildPluginConfigSchema(configSchema),
  register(api) {
    const options = configSchema.parse(api.pluginConfig ?? {});
    api.registerTool(
      (ctx) =>
        ctx.sandboxed
          ? null
          : {
              name: "phone_read",
              label: "Phone Read",
              description:
                "Open an HTTP(S) URL on the Android phone connected to the Gateway host and read visible accessibility text. Use when web_fetch fails or shows a login/block page, especially Xiaohongshu note links without xsec_token. Supports Xiaohongshu notes and configured host/app routes. Requires an unlocked, authorized phone and logged-in app. Does not click, like, comment, or unlock. Returns current screen only, with unverified target identity; never claim full content or a verified note ID. Short links must first be expanded with web_fetch.",
              parameters: Type.Object(
                { url: Type.String({ minLength: 1, maxLength: 8192 }) },
                { additionalProperties: false },
              ),
              async execute(_id, args, signal) {
                const { url } = z
                  .object({ url: z.string().min(1).max(8192) })
                  .strict()
                  .parse(args);
                try {
                  const result = await readPhone(url, options, undefined, signal);
                  return jsonResult({
                    ...result,
                    text: wrapExternalContent(result.text, { source: "web_fetch" }),
                    externalContent: { untrusted: true, wrapped: true, source: "phone_read" },
                  });
                } catch (error) {
                  if (error instanceof PhoneError) {
                    return jsonResult({ ok: false, code: error.code, message: error.message });
                  }
                  throw error;
                }
              },
            },
      { name: "phone_read" },
    );
  },
});
