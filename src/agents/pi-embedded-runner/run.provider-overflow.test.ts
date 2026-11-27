import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { makeAttemptResult, makeCompactionSuccess } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedCompactDirect,
  mockedMatchesProviderContextOverflow,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";

describe("provider-owned overflow recovery", () => {
  let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;
  const errorMessage = "400 Range of input length should be [1, 32768]";

  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedMatchesProviderContextOverflow.mockResolvedValue(true);
  });

  it.each(["prompt", "assistant"] as const)(
    "compacts and retries a provider-recognized %s error in the same session",
    async (source) => {
      mockedRunEmbeddedAttempt
        .mockResolvedValueOnce(
          makeAttemptResult(
            source === "prompt"
              ? { promptError: new Error(errorMessage) }
              : { lastAssistant: makeAssistantMessageFixture({ errorMessage }) },
          ),
        )
        .mockResolvedValueOnce(makeAttemptResult());
      mockedCompactDirect.mockResolvedValueOnce(makeCompactionSuccess({ summary: "Summary" }));

      const result = await runEmbeddedPiAgent(overflowBaseRunParams);

      expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
      expect(mockedMatchesProviderContextOverflow).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: source === "prompt" ? "anthropic" : "openai",
          workspaceDir: overflowBaseRunParams.workspaceDir,
          context: { errorMessage },
        }),
      );
      expect(mockedCompactDirect).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: overflowBaseRunParams.sessionId,
          force: true,
          runtimeContext: expect.objectContaining({ trigger: "overflow" }),
        }),
      );
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
      expect(mockedRunEmbeddedAttempt).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          sessionId: overflowBaseRunParams.sessionId,
          sessionFile: overflowBaseRunParams.sessionFile,
          prompt: overflowBaseRunParams.prompt,
        }),
      );
      expect(result.meta.error).toBeUndefined();
    },
  );

  it("stops after the existing recovery limit and returns a context error", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({ lastAssistant: makeAssistantMessageFixture({ errorMessage }) }),
    );
    mockedCompactDirect.mockResolvedValue(makeCompactionSuccess({ summary: "Summary" }));

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(3);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(4);
    expect(result.meta.error?.kind).toBe("context_overflow");
    expect(result.payloads?.[0]?.isError).toBe(true);
  });

  it("does not compact a range error rejected by the active provider hook", async () => {
    mockedMatchesProviderContextOverflow.mockResolvedValue(false);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({ promptError: new Error(errorMessage) }),
    );

    await expect(runEmbeddedPiAgent(overflowBaseRunParams)).rejects.toThrow(errorMessage);
    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });
});
