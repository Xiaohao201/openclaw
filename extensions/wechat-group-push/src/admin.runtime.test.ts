import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), scope: vi.fn() }));
vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  getCurrentGatewayOperatorScopes: deps.scope,
}));
vi.mock("openclaw/plugin-sdk/config-runtime", () => ({
  readConfigFileSnapshotForWrite: deps.read,
  writeConfigFile: deps.write,
}));
import { handleGroupAdmin } from "./admin.runtime.js";

let source: Record<string, unknown>;
beforeEach(() => {
  deps.scope.mockReset().mockReturnValue(["operator.admin"]);
  source = {
    other: { untouched: "example-secret" },
    plugins: {
      entries: {
        "wechat-group-push": {
          config: { endpoint: "https://example.com/send", groups: { Alpha: "a", Beta: "b" } },
        },
      },
    },
  };
  deps.read.mockReset().mockImplementation(async () => ({
    snapshot: {
      exists: true,
      valid: true,
      config: source,
      sourceConfig: source,
      raw: JSON.stringify(source),
    },
    writeOptions: { expectedConfigPath: "example.json" },
  }));
  deps.write.mockReset().mockImplementation(async (next) => {
    source = next;
  });
});
async function request(method: string, body?: unknown) {
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  ) as IncomingMessage;
  req.method = method;
  req.headers = {};
  let status = 200;
  let response = "";
  const headers = new Map();
  const res = {
    setHeader: (name: string, value: string) => headers.set(name, value),
    set statusCode(value: number) {
      status = value;
    },
    end: (text: string) => {
      response = text;
    },
  } as unknown as ServerResponse;
  await handleGroupAdmin(req, res);
  return { status, body: JSON.parse(response), headers };
}
describe("group admin HTTP adapter", () => {
  it("requires admin scope even after gateway authentication", async () => {
    deps.scope.mockReturnValue(["operator.read", "operator.write"]);
    expect((await request("GET")).status).toBe(403);
    expect((await request("POST", {})).status).toBe(403);
    deps.scope.mockReturnValue([]);
    expect((await request("GET")).status).toBe(403);
    expect(deps.read).not.toHaveBeenCalled();
    expect(deps.write).not.toHaveBeenCalled();
  });
  it("exposes only groups and revision, persists changes through the config writer", async () => {
    const before = await request("GET");
    expect(Object.keys(before.body).toSorted()).toEqual(["groups", "version"]);
    expect(before.headers.get("Cache-Control")).toBe("no-store");
    const result = await request("POST", {
      action: "delete",
      name: "Alpha",
      version: before.body.version,
    });
    expect(result.status).toBe(200);
    expect(result.body.groups).toEqual({ Beta: "b" });
    expect(source.other).toEqual({ untouched: "example-secret" });
    expect(deps.write.mock.calls[0][1].unsetPaths).toContainEqual([
      "plugins",
      "entries",
      "wechat-group-push",
      "config",
      "groups",
      "Alpha",
    ]);
  });
  it("rejects changes when config changes between read and save", async () => {
    const before = await request("GET");
    const read = deps.read.getMockImplementation()!;
    deps.read.mockImplementationOnce(read).mockImplementationOnce(async () => {
      source.changed = true;
      return read();
    });
    expect(
      (
        await request("POST", {
          action: "add",
          name: "Gamma",
          chatId: "c",
          version: before.body.version,
        })
      ).status,
    ).toBe(409);
    expect(deps.write).not.toHaveBeenCalled();
  });
  it("returns controlled errors for invalid config, unsupported methods and failed writes", async () => {
    expect((await request("DELETE")).status).toBe(405);
    const before = await request("GET");
    deps.write.mockRejectedValueOnce(new Error("secret"));
    expect(
      (
        await request("POST", {
          action: "add",
          name: "Gamma",
          chatId: "c",
          version: before.body.version,
        })
      ).body,
    ).toEqual({ code: "CONFIG_FAILED", message: "配置操作失败，请刷新确认当前状态后重试" });
    deps.read.mockResolvedValueOnce({ snapshot: { exists: false, valid: false } });
    expect((await request("GET")).status).toBe(503);
  });
});
