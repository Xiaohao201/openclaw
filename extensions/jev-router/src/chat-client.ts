import { z } from "zod";
import { assistantSchema, type ChatInput, type Completion } from "./benchmark.js";
import { readBody } from "./client.js";
import { parseUsage } from "./usage.js";

const optionsSchema = z.strictObject({
  model: z.string().regex(/^[a-z0-9-]+\/[a-zA-Z0-9._:-]+$/),
  maxRequests: z.number().int().min(1).max(160),
});
const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.enum(["stop", "tool_calls"]),
        message: assistantSchema,
      }),
    )
    .length(1),
});

export function createChatClient(
  options: z.infer<typeof optionsSchema>,
  deps: { fetch?: typeof fetch; apiKey?: () => string | undefined } = {},
) {
  const config = optionsSchema.parse(options);
  const fetcher = deps.fetch ?? globalThis.fetch;
  let requests = 0;
  return {
    async complete(input: ChatInput): Promise<Completion> {
      const apiKey = (deps.apiKey ?? (() => process.env.JEV_OPENROUTER_API_KEY))()?.trim();
      if (!apiKey) {
        throw new Error("missing_key");
      }
      if (requests >= config.maxRequests) {
        throw new Error("request_budget");
      }
      requests++;
      try {
        const response = await fetcher("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(30000),
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "X-OpenRouter-Title": "openclaw-jev-task-benchmark",
          },
          body: JSON.stringify({
            model: config.model,
            ...input,
            temperature: 0,
            max_tokens: 512,
            reasoning: { enabled: false },
            provider: { allow_fallbacks: false, require_parameters: true },
          }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("chat_failed");
        }
        const raw = await readBody(response);
        const body = responseSchema.parse(raw);
        return { message: body.choices[0].message, usage: parseUsage(raw) };
      } catch {
        throw new Error("chat_failed");
      }
    },
    requests: () => requests,
  };
}
