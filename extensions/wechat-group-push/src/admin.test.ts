import { describe, expect, it, vi } from "vitest";
import { createGroupAdmin, type GroupStore } from "./admin.js";

function setup() {
  let groups = { Alpha: "a", Beta: "b" };
  let version = "v1";
  const save = vi.fn(async (next: Record<string, string>, expected: string) => {
    if (expected !== version) {
      throw new Error("conflict");
    }
    groups = next as typeof groups;
    version += "x";
  });
  const store: GroupStore = { read: async () => ({ groups, version }), save };
  const create = vi.fn(async () => "0123456789abcdef0123456789abcdef");
  return { admin: createGroupAdmin(store, create), save, create };
}

describe("group administration", () => {
  it("adds, renames and deletes mappings using the current revision", async () => {
    const { admin } = setup();
    await admin.mutate({ action: "add", version: "v1", name: "Gamma", chatId: "c" });
    await admin.mutate({
      action: "update",
      version: "v1x",
      originalName: "Gamma",
      name: "Delta",
      chatId: "d",
    });
    const result = await admin.mutate({ action: "delete", version: "v1xx", name: "Delta" });
    expect(result.groups).toEqual({ Alpha: "a", Beta: "b" });
  });
  it("rejects stale writes and duplicate names without calling save", async () => {
    const { admin, save } = setup();
    await expect(
      admin.mutate({ action: "delete", version: "old", name: "Alpha" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      admin.mutate({ action: "add", version: "v1", name: "Alpha", chatId: "c" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(save).not.toHaveBeenCalled();
  });
  it("serializes concurrent mutations so only one stale revision succeeds", async () => {
    const { admin } = setup();
    const results = await Promise.allSettled(
      ["Gamma", "Delta"].map((name) =>
        admin.mutate({ action: "add", version: "v1", name, chatId: name }),
      ),
    );
    expect(results.map((r) => r.status).toSorted()).toEqual(["fulfilled", "rejected"]);
  });
  it("keeps at least one destination and rejects missing entries", async () => {
    const { admin } = setup();
    await admin.mutate({ action: "delete", version: "v1", name: "Alpha" });
    await expect(
      admin.mutate({ action: "delete", version: "v1x", name: "Beta" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      admin.mutate({ action: "delete", version: "v1x", name: "Missing" }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it.each(["", "  ", "__proto__", "constructor", "prototype"])(
    "rejects unsafe names: %s",
    async (name) => {
      const { admin, save } = setup();
      await expect(
        admin.mutate({ action: "add", version: "v1", name, chatId: "c" }),
      ).rejects.toBeDefined();
      expect(save).not.toHaveBeenCalled();
    },
  );
  it("returns the created chat ID when persistence fails without creating twice", async () => {
    const { admin, save, create } = setup();
    save.mockRejectedValueOnce(new Error("disk full"));
    const result = await admin.mutate({
      action: "create",
      version: "v1",
      name: "Gamma",
      owner: "one",
      userlist: ["one", "two"],
      requestId: "0123456789abcdef0123456789abcdef",
    });
    expect(result).toMatchObject({
      status: "created_unsaved",
      chatId: "0123456789abcdef0123456789abcdef",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("does not create a remote group on invalid or duplicate input", async () => {
    const { admin, create } = setup();
    await expect(
      admin.mutate({
        action: "create",
        version: "v1",
        name: "Alpha",
        owner: "one",
        userlist: ["one", "two"],
        requestId: "0123456789abcdef0123456789abcdef",
      }),
    ).rejects.toBeDefined();
    await expect(
      admin.mutate({
        action: "create",
        version: "v1",
        name: "Gamma",
        owner: "one",
        userlist: ["two"],
        requestId: "0123456789abcdef0123456789abcdef",
      }),
    ).rejects.toBeDefined();
    expect(create).not.toHaveBeenCalled();
  });
});
