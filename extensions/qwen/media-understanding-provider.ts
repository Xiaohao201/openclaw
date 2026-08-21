import {
  buildOpenAiCompatibleVideoRequestBody,
  coerceOpenAiCompatibleVideoText,
  resolveMediaUnderstandingString,
  type ImageDescriptionRequest,
  type ImageDescriptionResult,
  type ImagesDescriptionInput,
  type ImagesDescriptionRequest,
  type ImagesDescriptionResult,
  type MediaUnderstandingProvider,
  type OpenAiCompatibleVideoPayload,
  type VideoDescriptionRequest,
  type VideoDescriptionResult,
} from "openclaw/plugin-sdk/media-understanding";
import { requireApiKey, resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { QWEN_STANDARD_CN_BASE_URL, QWEN_STANDARD_GLOBAL_BASE_URL } from "./models.js";

const DEFAULT_QWEN_VIDEO_MODEL = "qwen-vl-max-latest";
const DEFAULT_QWEN_VIDEO_PROMPT = "Describe the video in detail.";
const DEFAULT_QWEN_IMAGE_PROMPT = "Describe the image in detail.";

type QwenProviderConfig = NonNullable<
  NonNullable<NonNullable<ImagesDescriptionRequest["cfg"]["models"]>["providers"]>[string]
>;

function normalizeQwenStandardBaseUrl(direct: string | undefined): string {
  if (!direct?.trim()) {
    return QWEN_STANDARD_GLOBAL_BASE_URL;
  }
  try {
    const url = new URL(direct);
    if (url.hostname === "coding-intl.dashscope.aliyuncs.com") {
      return QWEN_STANDARD_GLOBAL_BASE_URL;
    }
    if (url.hostname === "coding.dashscope.aliyuncs.com") {
      return QWEN_STANDARD_CN_BASE_URL;
    }
    return `${url.origin}${url.pathname}`.replace(/\/+$/u, "");
  } catch {
    return QWEN_STANDARD_GLOBAL_BASE_URL;
  }
}

function resolveConfiguredQwenProvider(
  cfg: ImagesDescriptionRequest["cfg"] | undefined,
): QwenProviderConfig | undefined {
  for (const [providerId, provider] of Object.entries(cfg?.models?.providers ?? {})) {
    const normalized = providerId.trim().toLowerCase();
    if (normalized === "qwen" || normalized === "modelstudio") {
      return provider;
    }
  }
  return undefined;
}

function resolveQwenStandardBaseUrl(
  cfg: { models?: { providers?: Record<string, { baseUrl?: string } | undefined> } } | undefined,
  providerId: string,
): string {
  const direct = cfg?.models?.providers?.[providerId]?.baseUrl?.trim();
  return normalizeQwenStandardBaseUrl(direct);
}

export async function describeQwenImagesWithApiKey(params: {
  images: ImagesDescriptionInput[];
  apiKey: string;
  baseUrl?: string;
  model?: string;
  prompt?: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}): Promise<ImagesDescriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const model = resolveMediaUnderstandingString(params.model, DEFAULT_QWEN_VIDEO_MODEL);
  const prompt = resolveMediaUnderstandingString(params.prompt, DEFAULT_QWEN_IMAGE_PROMPT);
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: normalizeQwenStandardBaseUrl(params.baseUrl),
      defaultBaseUrl: QWEN_STANDARD_GLOBAL_BASE_URL,
      defaultHeaders: {
        "content-type": "application/json",
        authorization: `Bearer ${params.apiKey}`,
      },
      provider: "qwen",
      api: "openai-completions",
      capability: "image",
      transport: "media-understanding",
    });
  const content = [
    { type: "text", text: prompt },
    ...params.images.map((image) => ({
      type: "image_url",
      image_url: {
        url: `data:${resolveMediaUnderstandingString(image.mime, "image/jpeg")};base64,${image.buffer.toString("base64")}`,
      },
    })),
  ];
  const { response: res, release } = await postJsonRequest({
    url: `${baseUrl}/chat/completions`,
    headers,
    body: { model, messages: [{ role: "user", content }] },
    timeoutMs: params.timeoutMs,
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
  });

  try {
    await assertOkOrThrowHttpError(res, "Qwen image description failed");
    const payload = (await res.json()) as OpenAiCompatibleVideoPayload;
    const text = coerceOpenAiCompatibleVideoText(payload);
    if (!text) {
      throw new Error("Qwen image description response missing content");
    }
    return { text, model };
  } finally {
    await release();
  }
}

async function describeQwenImages(
  params: ImagesDescriptionRequest,
): Promise<ImagesDescriptionResult> {
  const provider = resolveConfiguredQwenProvider(params.cfg);
  const auth = await resolveApiKeyForProvider({
    provider: "qwen",
    cfg: params.cfg,
    agentDir: params.agentDir,
    profileId: params.profile,
    preferredProfile: params.preferredProfile,
  });
  return await describeQwenImagesWithApiKey({
    images: params.images,
    apiKey: requireApiKey(auth, "qwen"),
    baseUrl: provider?.baseUrl,
    model: params.model,
    prompt: params.prompt,
    timeoutMs: params.timeoutMs,
  });
}

async function describeQwenImage(params: ImageDescriptionRequest): Promise<ImageDescriptionResult> {
  return await describeQwenImages({
    images: [{ buffer: params.buffer, fileName: params.fileName, mime: params.mime }],
    model: params.model,
    provider: params.provider,
    prompt: params.prompt,
    maxTokens: params.maxTokens,
    timeoutMs: params.timeoutMs,
    profile: params.profile,
    preferredProfile: params.preferredProfile,
    agentDir: params.agentDir,
    cfg: params.cfg,
  });
}

export async function describeQwenVideo(
  params: VideoDescriptionRequest,
): Promise<VideoDescriptionResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const model = resolveMediaUnderstandingString(params.model, DEFAULT_QWEN_VIDEO_MODEL);
  const mime = resolveMediaUnderstandingString(params.mime, "video/mp4");
  const prompt = resolveMediaUnderstandingString(params.prompt, DEFAULT_QWEN_VIDEO_PROMPT);
  const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: normalizeQwenStandardBaseUrl(params.baseUrl),
      defaultBaseUrl: QWEN_STANDARD_GLOBAL_BASE_URL,
      headers: params.headers,
      request: params.request,
      defaultHeaders: {
        "content-type": "application/json",
        authorization: `Bearer ${params.apiKey}`,
      },
      provider: "qwen",
      api: "openai-completions",
      capability: "video",
      transport: "media-understanding",
    });

  const { response: res, release } = await postJsonRequest({
    url: `${baseUrl}/chat/completions`,
    headers,
    body: buildOpenAiCompatibleVideoRequestBody({
      model,
      prompt,
      mime,
      buffer: params.buffer,
    }),
    timeoutMs: params.timeoutMs,
    fetchFn,
    allowPrivateNetwork,
    dispatcherPolicy,
  });

  try {
    await assertOkOrThrowHttpError(res, "Qwen video description failed");
    const payload = (await res.json()) as OpenAiCompatibleVideoPayload;
    const text = coerceOpenAiCompatibleVideoText(payload);
    if (!text) {
      throw new Error("Qwen video description response missing content");
    }
    return { text, model };
  } finally {
    await release();
  }
}

export function buildQwenMediaUnderstandingProvider(): MediaUnderstandingProvider {
  return {
    id: "qwen",
    capabilities: ["image", "video"],
    defaultModels: {
      image: "qwen-vl-max-latest",
      video: DEFAULT_QWEN_VIDEO_MODEL,
    },
    autoPriority: {
      image: 35,
      video: 15,
    },
    describeImage: describeQwenImage,
    describeImages: describeQwenImages,
    describeVideo: describeQwenVideo,
  };
}

export function resolveQwenMediaUnderstandingBaseUrl(
  cfg: { models?: { providers?: Record<string, { baseUrl?: string } | undefined> } } | undefined,
): string {
  return resolveQwenStandardBaseUrl(cfg, "qwen");
}
