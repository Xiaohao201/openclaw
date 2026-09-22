import { beforeEach, describe, expect, it, vi } from "vitest";

const transcribeAudioFile = vi.hoisted(() => vi.fn());
vi.mock("../runtime-api.js", () => ({
  getQQBotRuntime: () => ({ mediaUnderstanding: { transcribeAudioFile } }),
}));

import { resolveSTTConfig, transcribeAudio } from "./stt.js";

describe("QQ audio transcription", () => {
  beforeEach(() => transcribeAudioFile.mockReset());

  it("routes framework audio configuration through the public media runtime", async () => {
    const cfg = {
      tools: { media: { audio: { models: [{ provider: "speech-service", model: "asr-model" }] } } },
    };
    transcribeAudioFile.mockResolvedValue({ text: "full transcript" });
    expect(await transcribeAudio("voice.wav", cfg)).toBe("full transcript");
    expect(transcribeAudioFile).toHaveBeenCalledWith({ filePath: "voice.wav", cfg });
  });

  it("honors disabled framework transcription", async () => {
    const cfg = { tools: { media: { audio: { enabled: false } } } };
    expect(resolveSTTConfig(cfg)).toBeNull();
    expect(await transcribeAudio("voice.wav", cfg)).toBeNull();
    expect(transcribeAudioFile).not.toHaveBeenCalled();
  });

  it("returns no transcript when the runtime has no available ASR", async () => {
    transcribeAudioFile.mockResolvedValue({ text: undefined });
    expect(await transcribeAudio("voice.wav", {})).toBeNull();
  });

  it("preserves explicit channel STT configuration", () => {
    expect(
      resolveSTTConfig({
        channels: {
          qqbot: {
            stt: {
              baseUrl: "https://example.com/v1/",
              apiKey: "test-key",
              model: "custom-model",
            },
          },
        },
      }),
    ).toEqual({
      mode: "openai-compatible",
      baseUrl: "https://example.com/v1",
      apiKey: "test-key",
      model: "custom-model",
    });
  });
});
