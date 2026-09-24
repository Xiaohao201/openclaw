import { randomInt } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";

const [mode, output] = process.argv.slice(2);
if (!output || !["baseline", "filter", "route"].includes(mode)) {
  throw new Error(
    "Usage: node --import tsx scripts/dev/jev-debug-bench.ts baseline|filter|route OUTPUT.json",
  );
}
const file = await open(output, "wx", 0o600);
try {
  const root = "http://127.0.0.1:19001/plugins/rabbitmq-consumer/debug";
  const auth = await fetch(root, { redirect: "manual", signal: AbortSignal.timeout(10000) });
  const cookie = auth.headers.get("set-cookie")?.split(";")[0];
  if (auth.status !== 302 || !cookie) {
    throw new Error("Debug endpoint not ready");
  }
  const fixture = path.resolve("extensions/jev-router/eval/debug-note.txt").replaceAll("\\", "/");
  const prompts = [
    `后面会用到文件 ${fixture}。这一轮请勿调用任何工具，只回复“已记住路径”。`,
    "请只用 read 工具读取我上一轮提到的文件，告诉我 Verification code 和 Count 的值。不要搜索网络，不要写入文件，不要调用其他工具。",
    "根据刚才读取的文件，Count 加 5 等于多少？已有足够信息，不需要再调用工具。只回复数字。",
  ];
  const results: unknown[] = [];
  const run = `${mode}-${Date.now()}`;
  for (const [index, prompt] of prompts.entries()) {
    const started = Date.now();
    const response = await fetch(`${root}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      signal: AbortSignal.timeout(180000),
      body: JSON.stringify({
        id: randomInt(1500000000, 2000000000),
        user_id: "jev-synthetic-bench",
        session_id: `jev-${run}`,
        message: `[JEV_SYNTHETIC_BENCH] ${prompt}`,
        use_memory: false,
        use_websearch: false,
        max_tokens: 512,
        temperature: 0,
      }),
    });
    const result: unknown = await response.json();
    results.push({ index, elapsedMs: Date.now() - started, status: response.status, result });
    await file.truncate(0);
    await file.write(
      JSON.stringify({ mode, run, complete: index === prompts.length - 1, results }, null, 2),
      0,
      "utf8",
    );
    await file.sync();
    process.stdout.write(JSON.stringify(results.at(-1)) + "\n");
    if (!response.ok) {
      break;
    }
  }
} finally {
  await file.close();
}
