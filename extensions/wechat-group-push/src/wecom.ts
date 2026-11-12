import { z } from "zod";
import { GroupAdminError, type CreateGroupInput } from "./admin.js";

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});
const responseSchema = z.object({ errcode: z.number().int(), chatid: z.string().optional() });

export function createWecomClient(
  credentials: () => { corpId: string | undefined; secret: string | undefined },
  fetcher: typeof fetch = fetch,
) {
  let cached: { token: string; until: number; corpId: string; secret: string } | undefined;
  async function token() {
    const { corpId, secret } = credentials();
    if (!corpId || !secret) {
      throw new GroupAdminError(503, "WECOM_NOT_CONFIGURED", "服务端尚未配置企微建群凭证");
    }
    if (
      cached &&
      cached.corpId === corpId &&
      cached.secret === secret &&
      cached.until > Date.now()
    ) {
      return cached.token;
    }
    try {
      const url = new URL("https://qyapi.weixin.qq.com/cgi-bin/gettoken");
      url.searchParams.set("corpid", corpId);
      url.searchParams.set("corpsecret", secret);
      const response = await fetcher(url, {
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (!response.ok) {
        throw new Error("Token rejected");
      }
      const data = tokenSchema.parse(await response.json());
      cached = {
        token: data.access_token,
        until: Date.now() + Math.max(0, data.expires_in - 120) * 1000,
        corpId,
        secret,
      };
      return data.access_token;
    } catch {
      throw new GroupAdminError(502, "TOKEN_FAILED", "无法获取企微凭证，请检查应用配置");
    }
  }
  return async (input: CreateGroupInput): Promise<string> => {
    const accessToken = await token();
    try {
      const url = new URL("https://qyapi.weixin.qq.com/cgi-bin/appchat/create");
      url.searchParams.set("access_token", accessToken);
      const response = await fetcher(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: input.name,
          owner: input.owner,
          userlist: input.userlist,
          chatid: input.requestId,
        }),
      });
      if (!response.ok) {
        throw new Error("Uncertain response");
      }
      const result = responseSchema.parse(await response.json());
      if (result.errcode !== 0) {
        cached = undefined;
        throw new GroupAdminError(
          422,
          "WECOM_REJECTED",
          `企微拒绝建群（错误码 ${result.errcode}），请检查权限和成员；若该群 ID 已存在，请核实后补录`,
          input.requestId,
        );
      }
      if (result.chatid !== input.requestId) {
        throw new Error("Unexpected chat ID");
      }
      return result.chatid;
    } catch (error) {
      if (error instanceof GroupAdminError) {
        throw error;
      }
      throw new GroupAdminError(
        502,
        "CREATE_UNKNOWN",
        "建群结果暂不确定，请先用保留的群 ID 核实，避免重复建群",
        input.requestId,
      );
    }
  };
}
