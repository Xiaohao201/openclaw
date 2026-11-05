import { runReleaseCommand } from "./deploy-release.js";

try {
  const [configFile, release, ...args] = process.argv.slice(2);
  if (!configFile || !release) {
    throw new Error(
      "Use the generated release entrypoint: node deploy.mjs serve|status|stop|recover|deploy --compatible-state",
    );
  }
  await runReleaseCommand(configFile, release, args);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
