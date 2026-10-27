import { Command } from "commander";
import { addGatewayRunCommand } from "../../cli/gateway-cli/run.js";
import { isExternallyManagedGateway } from "../../infra/external-lifecycle.js";

if (!isExternallyManagedGateway() || !process.send || !process.connected) {
  throw new Error(
    "The lifecycle worker entrypoint may only be started by an external manager over IPC",
  );
}
const program = addGatewayRunCommand(new Command("gateway-worker"));
await program.parseAsync(process.argv);
