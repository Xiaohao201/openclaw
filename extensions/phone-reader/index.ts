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
                "Open an HTTP(S) URL on the connected Android phone; read accessibility text and capture images (default up to 10). Use when web_fetch fails or returns a login/block page, especially Xiaohongshu. For image posts, analyze imageCapture.images paths before answering: use image, or read with a vision-capable model if image is unavailable or fails; filenames and accessibility labels are NOT image contents. Recognized galleries are swiped within image bounds with verified page increments; unknown layouts capture only the current screen. maxImages can be 1–10. captureImages=false requests text only. Requires an unlocked authorized phone and logged-in app. Never claim a verified note ID; identityVerified is false. No likes, comments, login, or unlock actions. Expand short links with web_fetch first.",
              parameters: Type.Object(
                {
                  url: Type.String({ minLength: 1, maxLength: 8192 }),
                  captureImages: Type.Optional(Type.Boolean()),
                  maxImages: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
                },
                { additionalProperties: false },
              ),
              async execute(_id, args, signal) {
                const { url, captureImages, maxImages } = z
                  .object({
                    url: z.string().min(1).max(8192),
                    captureImages: z.boolean().default(true),
                    maxImages: z.number().int().min(1).max(10).default(10),
                  })
                  .strict()
                  .parse(args);
                try {
                  const result = await readPhone(
                    url,
                    { ...options, captureImages, maxImages },
                    undefined,
                    signal,
                  );
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
