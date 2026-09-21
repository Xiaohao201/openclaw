import { readPhone } from "./src/reader.js";

const url = process.argv[2];
if (!url) {
  throw new Error("Usage: node --import tsx extensions/phone-reader/smoke.ts <url>");
}
try {
  const result = await readPhone(url, {
    adbPath: process.env.OPENCLAW_PHONE_ADB_PATH,
    serial: process.env.OPENCLAW_PHONE_SERIAL,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
