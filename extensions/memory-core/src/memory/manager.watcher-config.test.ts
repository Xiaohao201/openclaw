import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  MemorySearchConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryIndexManager } from "./index.js";

type WatchIgnoredFn = (watchPath: string, stats?: { isDirectory?: () => boolean }) => boolean;

const { watchMock } = vi.hoisted(() => ({
  watchMock: vi.fn(() =>
    Object.assign(new EventEmitter(), {
      close: vi.fn(async () => undefined),
    }),
  ),
}));

vi.mock("chokidar", () => ({
  default: { watch: watchMock },
  watch: watchMock,
}));

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock-embed",
      embedQuery: async () => [1, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
    },
  }),
}));

type MemoryIndexModule = typeof import("./index.js");
type MemoryEmbeddingProvidersModule =
  typeof import("../../../../src/plugins/memory-embedding-providers.js");

let getMemorySearchManager: MemoryIndexModule["getMemorySearchManager"];
let closeAllMemorySearchManagers: MemoryIndexModule["closeAllMemorySearchManagers"];
let clearRegistry: MemoryEmbeddingProvidersModule["clearMemoryEmbeddingProviders"];
let registerAdapter: MemoryEmbeddingProvidersModule["registerMemoryEmbeddingProvider"];

describe("memory watcher config", () => {
  let manager: MemoryIndexManager | null = null;
  let workspaceDir = "";
  let extraDir = "";

  beforeAll(async () => {
    vi.resetModules();
    ({ getMemorySearchManager, closeAllMemorySearchManagers } = await import("./index.js"));
    ({
      clearMemoryEmbeddingProviders: clearRegistry,
      registerMemoryEmbeddingProvider: registerAdapter,
    } = await import("../../../../src/plugins/memory-embedding-providers.js"));
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    clearRegistry();
    // Keep config resolution local instead of discovering real provider plugins.
    for (const id of ["openai", "gemini"]) {
      registerAdapter({
        id,
        defaultModel: "mock-embed",
        transport: "remote",
        supportsMultimodalEmbeddings: () => id === "gemini",
        create: async () => ({ provider: null }),
      });
    }
  });

  afterEach(async () => {
    watchMock.mockClear();
    if (manager) {
      await manager.close();
      manager = null;
    }
    await closeAllMemorySearchManagers();
    vi.restoreAllMocks();
    vi.useRealTimers();
    clearRegistry();
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = "";
      extraDir = "";
    }
  });

  afterAll(() => {
    vi.resetModules();
  });

  async function setupWatcherWorkspace(seedFile: { name: string; contents: string }) {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-watch-"));
    extraDir = path.join(workspaceDir, "extra");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, seedFile.name), seedFile.contents);
  }

  function createWatcherConfig(overrides?: Partial<MemorySearchConfig>): OpenClawConfig {
    const defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> = {
      workspace: workspaceDir,
      memorySearch: {
        provider: "openai",
        model: "mock-embed",
        store: { path: path.join(workspaceDir, "index.sqlite"), vector: { enabled: false } },
        sync: { watch: true, watchDebounceMs: 25, onSessionStart: false, onSearch: false },
        query: { minScore: 0, hybrid: { enabled: false } },
        extraPaths: [extraDir],
        ...overrides,
      },
    };
    return {
      agents: {
        defaults,
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
  }

  async function expectWatcherManager(cfg: OpenClawConfig) {
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) {
      throw new Error("manager missing");
    }
    manager = result.manager as unknown as MemoryIndexManager;
    return manager;
  }

  it.each(["add", "change", "unlink"])(
    "keeps syncing on %s after repeated EBUSY watcher errors",
    async (event) => {
      await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
      const activeManager = await expectWatcherManager(createWatcherConfig());
      const watcher = watchMock.mock.results[0].value;
      const syncSpy = vi.spyOn(activeManager, "sync").mockResolvedValue(undefined);
      vi.useFakeTimers();
      const filePath = path.join(workspaceDir, "memory", "2026-11-25.md");
      const error = Object.assign(
        new Error(`EBUSY: resource busy or locked, watch '${filePath}'`),
        {
          code: "EBUSY",
          syscall: "watch",
          path: filePath,
        },
      );

      for (let attempt = 0; attempt < 2; attempt++) {
        // Chokidar emits from async setup; an unhandled error event rejects that work.
        await expect(Promise.resolve().then(() => watcher.emit("error", error))).resolves.toBe(
          true,
        );
      }
      expect(watcher.close).not.toHaveBeenCalled();

      watcher.emit(event, filePath);
      await vi.advanceTimersByTimeAsync(25);
      expect(syncSpy).toHaveBeenCalledExactlyOnceWith({ reason: "watch" });
      expect(watchMock).toHaveBeenCalledTimes(1);

      await activeManager.close();
      expect(watcher.close).toHaveBeenCalledTimes(1);
    },
  );

  it("watches the memory directory and ignores non-markdown churn", async () => {
    await setupWatcherWorkspace({ name: "notes.md", contents: "hello" });
    const cfg = createWatcherConfig();

    await expectWatcherManager(cfg);

    expect(watchMock).toHaveBeenCalledTimes(1);
    const [watchedPaths, options] = watchMock.mock.calls[0] as unknown as [
      string[],
      Record<string, unknown>,
    ];
    expect(watchedPaths).toEqual(
      expect.arrayContaining([
        path.join(workspaceDir, "MEMORY.md"),
        path.join(workspaceDir, "memory.md"),
        path.join(workspaceDir, "memory"),
        path.join(extraDir, "**", "*.md"),
      ]),
    );
    expect(options.ignoreInitial).toBe(true);
    expect(options.awaitWriteFinish).toEqual({ stabilityThreshold: 25, pollInterval: 100 });

    const ignored = options.ignored as WatchIgnoredFn | undefined;
    expect(ignored).toBeTypeOf("function");
    expect(ignored?.(path.join(workspaceDir, "memory", "node_modules", "pkg", "index.md"))).toBe(
      true,
    );
    expect(ignored?.(path.join(workspaceDir, "memory", ".venv", "lib", "python.md"))).toBe(true);
    expect(ignored?.(path.join(workspaceDir, "memory", "project", "notes.tmp"))).toBe(true);
    expect(ignored?.(path.join(workspaceDir, "memory", "project", "notes.json"))).toBe(true);
    expect(ignored?.(path.join(workspaceDir, "memory", "project", "notes.md"))).toBe(false);
    expect(
      ignored?.(path.join(workspaceDir, "memory", "project"), { isDirectory: () => true }),
    ).toBe(false);
  });

  it("watches multimodal extensions with case-insensitive globs", async () => {
    await setupWatcherWorkspace({ name: "PHOTO.PNG", contents: "png" });
    const cfg = createWatcherConfig({
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      fallback: "none",
      multimodal: { enabled: true, modalities: ["image", "audio"] },
    });

    await expectWatcherManager(cfg);

    expect(watchMock).toHaveBeenCalledTimes(1);
    const [watchedPaths, options] = watchMock.mock.calls[0] as unknown as [
      string[],
      Record<string, unknown>,
    ];
    expect(watchedPaths).toEqual(
      expect.arrayContaining([
        path.join(extraDir, "**", "*.[pP][nN][gG]"),
        path.join(extraDir, "**", "*.[wW][aA][vV]"),
      ]),
    );

    const ignored = options.ignored as WatchIgnoredFn | undefined;
    expect(ignored).toBeTypeOf("function");
    expect(ignored?.(path.join(extraDir, "nested", "PHOTO.PNG"))).toBe(false);
    expect(ignored?.(path.join(extraDir, "nested", "voice.WAV"))).toBe(false);
    expect(ignored?.(path.join(extraDir, "nested", "metadata.json"))).toBe(true);
  });
});
