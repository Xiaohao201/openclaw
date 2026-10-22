import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi } from "../../api.js";
import { extractUserId } from "../client/agent-id.js";
import { envelopeError } from "../client/envelope.js";
import { getJson, resolveConfig } from "../client/http-client.js";
import type { ApiKeyResolver } from "../client/key-resolver.js";
import { failure, resolveKeyOrError } from "../client/tool-helpers.js";
import { localPlatforms, platformForLink, resolveLocalConfig } from "./complaint-local-contract.js";
import {
  isUnavailableComplaintLink,
  isUnavailableComplaintPlatform,
} from "./complaint-platform-policy.js";

export function createComplaintTaxonomyToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
) {
  const config = resolveConfig(api.pluginConfig ?? {});
  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "complaint_taxonomy",
      label: "查询举报平台和分类",
      description:
        "只读查询当前举报分类目录，不提交任务。用户问支持哪些平台时不传 links；核对具体链接时传 links。向中央网信办12377举报时传 destination=Report12377，links 仍为被举报内容原网址；不传 destination 时查询内容所在平台。12377目录仅代表已接入的匿名类别；后端模式使用该目录提交时，complaint_submit 必须同样传 destination=Report12377；本地模式仍传 report12377 对象并使用独立人工流程，不传后端 classifications。不得改投原平台。必须查询后再回答，不得根据旧名单拒绝平台。platforms 表示目录可用，具体链接以 taxonomies 和 unsupportedLinks 为准；接口失败或旧版缺少 platforms 不代表不支持。目录可用不保证举报执行、涉企投诉或下架成功。",
      parameters: Type.Object(
        {
          destination: Type.Optional(
            Type.Union([Type.Literal("ContentPlatform"), Type.Literal("Report12377")], {
              description: "举报接收渠道，默认内容所在平台；12377与内容链接所属平台无关。",
            }),
          ),
          links: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 50 }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(_id: string, params: Record<string, unknown>) {
        if (
          params.destination !== undefined &&
          params.destination !== "ContentPlatform" &&
          params.destination !== "Report12377"
        ) {
          return jsonResult({ success: false, error: "举报接收渠道无效。" });
        }
        if (
          params.links !== undefined &&
          (!Array.isArray(params.links) ||
            params.links.length > 50 ||
            params.links.some(
              (link) => typeof link !== "string" || !link.trim() || link.length > 2048,
            ))
        ) {
          return jsonResult({
            success: false,
            error: "links 必须为最多50条非空链接的数组，每条不超过2048字符。",
          });
        }
        const links = params.links as string[] | undefined;
        if (
          params.destination !== "Report12377" &&
          resolveLocalConfig(api.pluginConfig ?? {}).mode === "local"
        ) {
          return jsonResult({
            success: true,
            executor: "local",
            platforms: Object.keys(localPlatforms).toSorted(),
            links: (links ?? []).map((link) => ({ link, platform: platformForLink(link) })),
            unsupportedLinks: (links ?? []).filter((link) => !platformForLink(link)),
            instruction:
              "本地模式从浏览器实际选项匹配单条举报事由，无后端分类版本。可传 categories 平台分类文字，不传 classifications。支持平台不保证当前页面可执行；登录/验证可能需人工处理。原平台登录、浏览器或取证失败时不得推荐或切换举报渠道。12377不属于原平台目录，仅在用户明确指定时使用独立人工流程。unsupportedLinks 仅指原平台直接举报路径。",
          });
        }
        const keyed = await resolveKeyOrError(api, resolver, userId, "complaint_taxonomy");
        if ("error" in keyed) {
          return keyed.error;
        }
        try {
          const result = await getJson(
            config,
            "/legal/fetch-complaint-taxonomy",
            {
              ...(links?.length ? { links } : {}),
              ...(params.destination ? { destination: params.destination } : {}),
            },
            keyed.apiKey,
          );
          const error = envelopeError(result);
          if (error) {
            return jsonResult({ success: false, error });
          }
          // Older backends silently ignore unknown query parameters. Never present
          // their content-platform catalog as the explicitly selected destination.
          if (
            params.destination === "Report12377" &&
            (result.destination !== "Report12377" ||
              !Array.isArray(result.taxonomies) ||
              result.taxonomies.some(
                (entry: unknown) =>
                  !entry ||
                  typeof entry !== "object" ||
                  (entry as Record<string, unknown>).platform !== "Report12377",
              ))
          ) {
            return jsonResult({
              success: false,
              error:
                "后端未确认12377分类目录，请部署支持举报接收渠道查询的接口；不能使用原平台分类代替。",
            });
          }
          if (
            result.code !== "success" ||
            !Array.isArray(result.taxonomies) ||
            !Array.isArray(result.unsupportedLinks) ||
            (!links?.length && !Array.isArray(result.platforms))
          ) {
            return jsonResult({
              success: false,
              error:
                "分类接口未返回完整目录（可能尚未升级），当前无法判断支持范围。不要解释为平台不支持。",
            });
          }
          // Restrictions on direct platform reporting do not describe the
          // explicitly selected 12377 destination's catalog.
          if (params.destination === "Report12377") {
            return jsonResult({
              success: true,
              destination: "Report12377",
              ...(!links?.length ? { platforms: result.platforms } : {}),
              taxonomies: result.taxonomies,
              unsupportedLinks: result.unsupportedLinks,
            });
          }
          return jsonResult({
            success: true,
            ...(!links?.length
              ? {
                  platforms: (result.platforms as unknown[]).filter(
                    (entry) => !isUnavailableComplaintPlatform(entry),
                  ),
                }
              : {}),
            taxonomies: result.taxonomies.filter((entry: unknown) => {
              if (isUnavailableComplaintPlatform(entry)) {
                return false;
              }
              return !(
                entry &&
                typeof entry === "object" &&
                "link" in entry &&
                typeof entry.link === "string" &&
                isUnavailableComplaintLink(entry.link)
              );
            }),
            unsupportedLinks: [
              ...new Set([
                ...result.unsupportedLinks,
                ...(links ?? []).filter(isUnavailableComplaintLink),
              ]),
            ],
          });
        } catch (error) {
          return failure(api, "complaint_taxonomy", userId, error);
        }
      },
    };
  };
}
