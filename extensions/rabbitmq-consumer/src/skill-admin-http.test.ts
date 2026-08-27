import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createSkillAdminHttpHandler } from "./skill-admin-http.js";

const TOKEN = "test-skill-admin-token-at-least-32-characters";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createSkillRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-skill-admin-"));
  roots.push(root);
  const dir = path.join(root, "ai-public-opinion-brief");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    "---\nname: ai-public-opinion-brief\ndescription: test\n---\n\n# Original\n",
    "utf8",
  );
  return root;
}

function createRequest(params: {
  method: string;
  token?: string;
  body?: unknown;
  path?: string;
}): IncomingMessage {
  const rawBody = params.body === undefined ? "" : JSON.stringify(params.body);
  const req = Readable.from(rawBody ? [Buffer.from(rawBody)] : []) as IncomingMessage;
  req.method = params.method;
  req.url = params.path ?? "/plugins/rabbitmq-consumer/skills/ai-public-opinion-brief";
  req.headers = {
    ...(params.token ? { authorization: `Bearer ${params.token}` } : {}),
    ...(rawBody ? { "content-type": "application/json" } : {}),
  };
  return req;
}

function createResponse(): ServerResponse & { json: () => unknown } {
  let body = "";
  const headers = new Map<string, string>();
  return {
    statusCode: 200,
    setHeader(name: string, value: number | string | readonly string[]) {
      headers.set(name.toLowerCase(), String(value));
      return this;
    },
    end(chunk?: string | Buffer) {
      body += chunk?.toString() ?? "";
      return this;
    },
    json: () => JSON.parse(body) as unknown,
  } as unknown as ServerResponse & { json: () => unknown };
}

describe("bundled Skill admin HTTP handler", () => {
  it("reads and atomically updates one whitelisted SKILL.md", async () => {
    const root = await createSkillRoot();
    const handler = createSkillAdminHttpHandler({ token: TOKEN, skillRoots: [root] });

    const getResponse = createResponse();
    await handler(createRequest({ method: "GET", token: TOKEN }), getResponse);
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({
      skillName: "ai-public-opinion-brief",
      content: expect.stringContaining("# Original"),
    });

    const content = "---\nname: ai-public-opinion-brief\ndescription: updated\n---\n\n# Updated\n";
    const patchResponse = createResponse();
    await handler(
      createRequest({ method: "PATCH", token: TOKEN, body: { content } }),
      patchResponse,
    );
    expect(patchResponse.statusCode).toBe(200);
    await expect(
      readFile(path.join(root, "ai-public-opinion-brief", "SKILL.md"), "utf8"),
    ).resolves.toBe(content);
  });

  it("rejects missing credentials and skills outside the fixed whitelist", async () => {
    const root = await createSkillRoot();
    const handler = createSkillAdminHttpHandler({ token: TOKEN, skillRoots: [root] });

    const unauthorized = createResponse();
    await handler(createRequest({ method: "GET" }), unauthorized);
    expect(unauthorized.statusCode).toBe(401);

    const unknown = createResponse();
    await handler(
      createRequest({
        method: "GET",
        token: TOKEN,
        path: "/plugins/rabbitmq-consumer/skills/../secrets",
      }),
      unknown,
    );
    expect(unknown.statusCode).toBe(404);
  });

  it("keeps the stable frontmatter name and original file when validation fails", async () => {
    const root = await createSkillRoot();
    const filePath = path.join(root, "ai-public-opinion-brief", "SKILL.md");
    const original = await readFile(filePath, "utf8");
    const handler = createSkillAdminHttpHandler({ token: TOKEN, skillRoots: [root] });
    const response = createResponse();

    await handler(
      createRequest({
        method: "PATCH",
        token: TOKEN,
        body: { content: "---\nname: another-skill\n---\n\n# Changed\n" },
      }),
      response,
    );

    expect(response.statusCode).toBe(400);
    await expect(readFile(filePath, "utf8")).resolves.toBe(original);
  });
});
