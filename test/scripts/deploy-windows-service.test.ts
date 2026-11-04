import { expect, it } from "vitest";
import { windowsServiceXml } from "../../scripts/deploy-windows-service.js";

const options = {
  repo: "C:\\OpenClaw & tools",
  node: "C:\\Program Files\\nodejs\\node.exe",
  config: "C:\\service\\supervisor.json",
  logs: "C:\\service\\logs",
};
it("generates an escaped service definition with graceful stop and bounded recovery", () => {
  const xml = windowsServiceXml(options);
  expect(xml).toContain("OpenClaw &amp; tools");
  expect(xml).toContain("<executable>C:\\Program Files\\nodejs\\node.exe</executable>");
  expect(xml).toContain("<stoparguments>");
  expect(xml).toContain("deploy-control.ts");
  expect(xml).toContain('<onfailure action="none"');
  expect(xml).toContain("roll-by-size");
  expect(xml).toContain("<user>LocalService</user>");
});
it("rejects relative paths, command-line quotes and WinSW environment expansion", () => {
  for (const repo of ["relative", 'C:\\bad"path', "C:\\%SECRET%", "C:\\bad\npath"]) {
    expect(() => windowsServiceXml({ ...options, repo })).toThrow();
  }
});
