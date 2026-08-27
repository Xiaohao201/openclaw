import { timingSafeEqual, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

const ROUTE_PREFIX = "/plugins/rabbitmq-consumer/skills/";
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = MAX_SKILL_BYTES + 16 * 1024;

export const EDITABLE_BUNDLED_SKILLS = [
  "institution-violation-judgment",
  "gov-public-opinion-analysis-agent",
  "ai-public-opinion-brief",
  "ai-collaboration-diagnostic",
] as const;

type EditableBundledSkill = (typeof EDITABLE_BUNDLED_SKILLS)[number];
const editableSkills = new Set<string>(EDITABLE_BUNDLED_SKILLS);

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function readBearerToken(req: IncomingMessage): string {
  const authorization = req.headers.authorization;
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  const match = /^Bearer\s+(.+)$/i.exec(value?.trim() ?? "");
  return match?.[1]?.trim() ?? "";
}

function tokensEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    providedBuffer.length > 0 &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

function parseSkillName(req: IncomingMessage): EditableBundledSkill {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (!pathname.startsWith(ROUTE_PREFIX)) {
    throw new HttpError(404, "Not found");
  }
  const rawName = pathname.slice(ROUTE_PREFIX.length);
  if (!rawName || rawName.includes("/")) {
    throw new HttpError(404, "Skill not found");
  }
  let skillName: string;
  try {
    skillName = decodeURIComponent(rawName);
  } catch {
    throw new HttpError(400, "Invalid skill name");
  }
  if (!editableSkills.has(skillName)) {
    throw new HttpError(404, "Skill not found");
  }
  return skillName as EditableBundledSkill;
}

function validateSkillDocument(skillName: EditableBundledSkill, content: string): void {
  if (!content.trim()) {
    throw new HttpError(400, "SKILL.md content cannot be empty");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) {
    throw new HttpError(413, "SKILL.md content exceeds 256KB");
  }
  if (content.includes("\0")) {
    throw new HttpError(400, "SKILL.md content is invalid");
  }

  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content)?.[1];
  const nameLine = frontmatter?.split(/\r?\n/u).find((line) => /^name\s*:/u.test(line));
  const declaredName = /^name\s*:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*$/u.exec(nameLine ?? "");
  const parsedName = declaredName?.[1] ?? declaredName?.[2] ?? declaredName?.[3];
  if (parsedName !== skillName) {
    throw new HttpError(400, `frontmatter name must remain ${skillName}`);
  }
}

async function resolveSkillFile(
  skillName: EditableBundledSkill,
  skillRoots: string[],
): Promise<string> {
  for (const rawRoot of skillRoots) {
    const root = rawRoot.trim();
    if (!root) continue;
    try {
      const sourceFilePath = path.join(root, skillName, "SKILL.md");
      const sourceStats = await lstat(sourceFilePath);
      if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) continue;
      const [rootPath, filePath] = await Promise.all([realpath(root), realpath(sourceFilePath)]);
      const relative = path.relative(rootPath, filePath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      return filePath;
    } catch {
      // Try the next explicitly configured bundled-skills root.
    }
  }
  throw new HttpError(404, "Skill file not found");
}

async function readRequestJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new HttpError(413, "Request body is too large");
    }
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const fileStats = await stat(filePath);
  const tempPath = path.join(
    path.dirname(filePath),
    `.SKILL.md.${process.pid}.${randomUUID()}.tmp`,
  );
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(tempPath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: fileStats.mode,
    });
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export function createSkillAdminHttpHandler(params: { token?: string; skillRoots: string[] }) {
  const expectedToken = params.token?.trim() ?? "";
  const roots = Array.from(new Set(params.skillRoots.map((root) => path.resolve(root))));

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    try {
      if (expectedToken.length < 32) {
        throw new HttpError(503, "Skill admin endpoint is not configured");
      }
      if (!tokensEqual(readBearerToken(req), expectedToken)) {
        throw new HttpError(401, "Unauthorized");
      }

      const skillName = parseSkillName(req);
      const filePath = await resolveSkillFile(skillName, roots);
      if (req.method === "GET") {
        const content = await readFile(filePath, "utf8");
        writeJson(res, 200, { skillName, content });
        return true;
      }
      if (req.method === "PATCH") {
        const body = await readRequestJson(req);
        if (typeof body.content !== "string") {
          throw new HttpError(400, "content must be a string");
        }
        validateSkillDocument(skillName, body.content);
        await atomicWrite(filePath, body.content);
        writeJson(res, 200, { skillName, content: body.content });
        return true;
      }

      res.setHeader("Allow", "GET, PATCH");
      throw new HttpError(405, "Method not allowed");
    } catch (error) {
      if (error instanceof HttpError) {
        writeJson(res, error.statusCode, { error: error.message });
      } else {
        writeJson(res, 500, { error: "Unable to update Skill" });
      }
      return true;
    }
  };
}
