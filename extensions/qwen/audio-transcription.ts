import path from "node:path";
import type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
} from "openclaw/plugin-sdk/media-understanding";
import {
  postJsonRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";

export const QWEN_ASR_MODEL = "qwen-audio-3.0-asr-flash";
const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com";
const ASR_PATH = "/api/v1/services/aigc/multimodal-generation/generation";
const MAX_INLINE_BYTES = 10_000_000;
const AUDIO_FORMATS = new Set([
  "aac",
  "amr",
  "flac",
  "m4a",
  "mp3",
  "mp4",
  "ogg",
  "opus",
  "wav",
  "webm",
  "wma",
]);
const MIME_FORMATS: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/x-ms-wma": "wma",
};

function resolveAsrBaseUrl(value?: string): string {
  const url = new URL(value?.trim() || DEFAULT_BASE_URL);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Qwen ASR requires an HTTPS base URL without credentials or query parameters");
  }
  if (url.hostname === "coding.dashscope.aliyuncs.com") {
    return DEFAULT_BASE_URL;
  }
  if (url.hostname === "coding-intl.dashscope.aliyuncs.com") {
    return "https://dashscope-intl.aliyuncs.com";
  }
  // Accept a workspace origin, native endpoint, or existing chat provider base URL.
  const pathname = url.pathname.replace(/\/+$/u, "");
  const prefix = pathname.endsWith(ASR_PATH)
    ? pathname.slice(0, -ASR_PATH.length)
    : pathname.replace(/\/(?:compatible-mode\/)?v1$/u, "");
  return `${url.origin}${prefix}`;
}

export async function transcribeQwenAudio(
  params: AudioTranscriptionRequest,
): Promise<AudioTranscriptionResult> {
  const mime = params.mime?.split(";", 1)[0]?.trim().toLowerCase();
  const extension = path.extname(params.fileName).slice(1).toLowerCase();
  const format = (mime && (MIME_FORMATS[mime] ?? mime.replace(/^audio\//u, ""))) || extension;
  if (!AUDIO_FORMATS.has(format)) {
    throw new Error("Qwen ASR does not support this audio format");
  }
  const contentType =
    format === "mp3" ? "audio/mpeg" : `audio/${format === "m4a" ? "mp4" : format}`;
  const prefix = `data:${contentType};base64,`;
  if (params.buffer.length === 0) {
    throw new Error("Qwen ASR cannot transcribe empty audio");
  }
  if (prefix.length + 4 * Math.ceil(params.buffer.length / 3) > MAX_INLINE_BYTES) {
    throw new Error(
      "Qwen ASR inline audio exceeds the 10 MB Base64 limit; use a smaller encoded file",
    );
  }
  const model = params.model?.trim() || QWEN_ASR_MODEL;
  const { baseUrl, headers, allowPrivateNetwork, dispatcherPolicy } =
    resolveProviderHttpRequestConfig({
      baseUrl: resolveAsrBaseUrl(params.baseUrl),
      defaultBaseUrl: DEFAULT_BASE_URL,
      headers: params.headers,
      request: params.request,
      defaultHeaders: {
        "content-type": "application/json",
        authorization: `Bearer ${params.apiKey}`,
      },
      provider: "qwen",
      capability: "audio",
      transport: "media-understanding",
    });
  headers.set("X-DashScope-SSE", "disable");
  const { response, release } = await postJsonRequest({
    url: `${baseUrl}${ASR_PATH}`,
    headers,
    body: {
      model,
      input: {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: { data: prefix + params.buffer.toString("base64") },
              },
            ],
          },
        ],
      },
      parameters: {
        format,
        ...(params.language?.trim() ? { language_hints: [params.language.trim()] } : {}),
      },
    },
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn ?? fetch,
    allowPrivateNetwork,
    dispatcherPolicy,
  });
  try {
    // Do not log upstream error bodies: they may echo credentials or inline audio.
    if (!response.ok) {
      throw new Error(`Qwen ASR request failed (HTTP ${response.status})`);
    }
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || "code" in payload || !("output" in payload)) {
      throw new Error("Qwen ASR returned an invalid or failed response");
    }
    const output = payload.output;
    if (
      !output ||
      typeof output !== "object" ||
      !("text" in output) ||
      typeof output.text !== "string" ||
      !output.text.trim()
    ) {
      throw new Error("Qwen ASR response missing full transcript");
    }
    // output.sentence contains only the last sentence, not the entire recording.
    return { text: output.text.trim(), model };
  } finally {
    await release();
  }
}
