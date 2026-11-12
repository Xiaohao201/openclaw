import { z } from "zod";

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((name) => !["__proto__", "prototype", "constructor"].includes(name));
const common = { version: z.string().min(1), name: nameSchema };
const destination = { chatId: z.string().trim().min(1).max(256) };
const member = z.string().trim().min(1).max(128);
export const mutationSchema = z.discriminatedUnion("action", [
  z.object({ ...common, ...destination, action: z.literal("add") }).strict(),
  z
    .object({ ...common, ...destination, action: z.literal("update"), originalName: nameSchema })
    .strict(),
  z.object({ ...common, action: z.literal("delete") }).strict(),
  z
    .object({
      ...common,
      name: nameSchema.refine((n) => [...n].length <= 50),
      action: z.literal("create"),
      owner: member,
      userlist: z.array(member).min(2).max(1999),
      requestId: z.string().regex(/^[a-f0-9]{32}$/),
    })
    .strict(),
]);
export type CreateGroupInput = Extract<z.infer<typeof mutationSchema>, { action: "create" }>;
export type GroupSnapshot = { groups: Record<string, string>; version: string };
export type GroupStore = {
  read(): Promise<GroupSnapshot>;
  save(groups: Record<string, string>, version: string): Promise<void>;
};
type GroupAdminErrorCode =
  | "ADMIN_REQUIRED"
  | "INVALID_INPUT"
  | "CONFLICT"
  | "NOT_FOUND"
  | "LAST_GROUP"
  | "DUPLICATE"
  | "INVALID_MEMBERS"
  | "WECOM_NOT_CONFIGURED"
  | "TOKEN_FAILED"
  | "WECOM_REJECTED"
  | "CREATE_UNKNOWN"
  | "INVALID_CONFIG"
  | "INVALID_BODY"
  | "METHOD_NOT_ALLOWED";
export class GroupAdminError extends Error {
  constructor(
    public status: number,
    public code: GroupAdminErrorCode,
    message: string,
    public chatId?: string,
  ) {
    super(message);
  }
}

export function createGroupAdmin(
  store: GroupStore,
  create: (input: CreateGroupInput) => Promise<string>,
) {
  // Serialize this endpoint's read-modify-write operations; revisions reject stale clients.
  let queue: Promise<unknown> = Promise.resolve();
  async function apply(raw: unknown) {
    const parsed = mutationSchema.safeParse(raw);
    if (!parsed.success) {
      throw new GroupAdminError(400, "INVALID_INPUT", "群名称、群 ID 或成员信息不合法");
    }
    const input = parsed.data;
    const current = await store.read();
    if (input.version !== current.version) {
      throw new GroupAdminError(409, "CONFLICT", "配置已更新，请刷新列表后重试");
    }
    const groups = { ...current.groups };
    if (input.action === "delete" || input.action === "update") {
      const original = input.action === "update" ? input.originalName : input.name;
      if (!Object.hasOwn(groups, original)) {
        throw new GroupAdminError(404, "NOT_FOUND", "该群配置已不存在");
      }
      if (input.action === "delete" && Object.keys(groups).length === 1) {
        throw new GroupAdminError(400, "LAST_GROUP", "必须至少保留一个推送群");
      }
      delete groups[original];
    }
    if (input.action !== "delete") {
      if (Object.hasOwn(groups, input.name)) {
        throw new GroupAdminError(409, "DUPLICATE", "群名称已存在");
      }
      if (input.action === "create") {
        if (
          new Set(input.userlist).size !== input.userlist.length ||
          !input.userlist.includes(input.owner)
        ) {
          throw new GroupAdminError(400, "INVALID_MEMBERS", "成员不能重复，且必须包含群主");
        }
        const chatId = await create(input);
        groups[input.name] = chatId;
        try {
          await store.save(groups, current.version);
        } catch {
          // A remote creation cannot be rolled back by a failed local config write.
          return { status: "created_unsaved" as const, chatId, name: input.name, ...current };
        }
      } else {
        groups[input.name] = input.chatId;
        await store.save(groups, current.version);
      }
    } else {
      await store.save(groups, current.version);
    }
    return { status: "saved" as const, ...(await store.read()) };
  }
  return {
    read: () => store.read(),
    mutate(raw: unknown) {
      const operation = queue.then(() => apply(raw));
      queue = operation.catch(() => undefined);
      return operation;
    },
  };
}
