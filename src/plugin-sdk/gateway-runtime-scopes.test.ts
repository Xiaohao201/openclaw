import { describe, expect, it, vi } from "vitest";
const request = vi.hoisted(() => ({ scopes: undefined as string[] | undefined }));
vi.mock("../plugins/runtime/gateway-request-scope.js", () => ({
  getPluginRuntimeGatewayRequestScope: () =>
    request.scopes ? { client: { connect: { scopes: request.scopes } } } : undefined,
}));
import { getCurrentGatewayOperatorScopes } from "./gateway-runtime.js";

describe("public gateway operator scopes", () => {
  it("returns no capabilities outside a request", () => {
    request.scopes = undefined;
    expect(getCurrentGatewayOperatorScopes()).toEqual([]);
  });
  it("returns a copy and never escalates a read-only request", () => {
    request.scopes = ["operator.read"];
    const scopes = getCurrentGatewayOperatorScopes();
    expect(scopes).toEqual(["operator.read"]);
    expect(scopes).not.toBe(request.scopes);
    expect(scopes.includes("operator.admin")).toBe(false);
    request.scopes = undefined;
  });
});
