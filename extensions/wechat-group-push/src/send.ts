import { z } from "zod";

const commonConfig = {
  endpoint: z.url().refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash
    );
  }, "Use an HTTP(S) endpoint without credentials or fragments"),
  timeoutMs: z.number().int().min(100).max(60_000).default(15_000),
};

export const configSchema = z.union([
  z
    .object({
      ...commonConfig,
      groups: z
        .record(z.string().min(1), z.string().trim().min(1))
        .refine((groups) => Object.keys(groups).length > 0, "Configure at least one group"),
    })
    .strict(),
  // Accept legacy configuration without treating its single group as a default.
  z
    .object({
      ...commonConfig,
      chatId: z.string().trim().min(1),
      groupName: z.string().trim().min(1),
    })
    .strict()
    .transform(({ chatId, groupName, ...rest }) => ({ ...rest, groups: { [groupName]: chatId } })),
]);

const messageSchema = z
  .object({
    groupName: z.string().min(1),
    confirmed: z.literal(true),
    content: z
      .string()
      .refine((value) => value.trim().length > 0, "Message must not be blank")
      .refine(
        (value) => Buffer.byteLength(value, "utf8") <= 2048,
        "Message exceeds 2048 UTF-8 bytes",
      ),
  })
  .strict();

const responseSchema = z.object({ errcode: z.number().int() });

type SendResult =
  | { status: "sent"; groupName: string }
  | { status: "rejected"; groupName: string; providerCode: number }
  | { status: "unknown"; groupName: string };

export async function sendToWechatGroup(
  rawConfig: unknown,
  args: unknown,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<SendResult> {
  const config = configSchema.parse(rawConfig);
  const { content, groupName } = messageSchema.parse(args);
  if (!Object.hasOwn(config.groups, groupName)) {
    throw new Error(
      "Choose an exact configured group name and confirm it with the user before sending",
    );
  }
  const chatId = config.groups[groupName];
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const unknown: SendResult = { status: "unknown", groupName };
  try {
    // Resolve the exact confirmed name only within the operator-configured destinations.
    // Do not follow redirects or retry: either could deliver the message twice or elsewhere.
    const response = await fetcher(config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatid: chatId, content }),
      redirect: "error",
      signal: requestSignal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return unknown;
    }
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return unknown;
    }
    return parsed.data.errcode === 0
      ? { status: "sent", groupName }
      : { status: "rejected", groupName, providerCode: parsed.data.errcode };
  } catch {
    // A lost response does not establish whether the upstream service delivered it.
    return unknown;
  }
}
