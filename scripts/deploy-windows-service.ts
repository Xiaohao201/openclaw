import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const windowsPath = z
  .string()
  .refine((value) => path.win32.isAbsolute(value) && !/["%\r\n]/.test(value));
const serviceSchema = z
  .object({
    repo: windowsPath,
    node: windowsPath,
    config: windowsPath,
    logs: windowsPath,
  })
  .strict();
const xmlEscape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

/** WinSW 2.x definition. Generation does not install or start a service. */
export function windowsServiceXml(input: z.infer<typeof serviceSchema>) {
  const config = serviceSchema.parse(input);
  const start = `--import tsx "${path.win32.join(config.repo, "scripts", "deploy-supervisor.ts")}" "${config.config}"`;
  const stop = `--import tsx "${path.win32.join(config.repo, "scripts", "deploy-control.ts")}" "${config.config}" stop`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<service>
  <id>OpenClawSupervisor</id>
  <name>OpenClaw Supervisor</name>
  <description>Managed OpenClaw gateway with serialized deployment and runtime recovery.</description>
  <executable>${xmlEscape(config.node)}</executable>
  <workingdirectory>${xmlEscape(config.repo)}</workingdirectory>
  <startarguments>${xmlEscape(start)}</startarguments>
  <stopexecutable>${xmlEscape(config.node)}</stopexecutable>
  <stoparguments>${xmlEscape(stop)}</stoparguments>
  <stoptimeout>5min</stoptimeout>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount>
  <onfailure action="restart" delay="15sec" />
  <onfailure action="restart" delay="60sec" />
  <onfailure action="none" />
  <resetfailure>1hour</resetfailure>
  <logpath>${xmlEscape(config.logs)}</logpath>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>8</keepFiles></log>
</service>
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [config, directory] = process.argv.slice(2);
  if (process.platform !== "win32" || !config || !directory) {
    throw new Error(
      "Usage on Windows: deploy-windows-service.ts <supervisor.json> <existing-private-service-directory>",
    );
  }
  await fs.access(config);
  await fs.access(directory);
  const xml = windowsServiceXml({
    repo: process.cwd(),
    node: process.execPath,
    config: path.resolve(config),
    logs: path.join(path.resolve(directory), "logs"),
  });
  const output = path.join(directory, "OpenClawSupervisor.xml");
  await fs.writeFile(output, xml, { flag: "wx", mode: 0o600 });
  console.log(
    `Created ${output}. Place the verified WinSW 2.x executable beside it as OpenClawSupervisor.exe. No service was installed.`,
  );
}
