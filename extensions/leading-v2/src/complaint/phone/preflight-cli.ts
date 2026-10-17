import { z } from "zod";
import type { OpenClawPluginApi } from "../../../api.js";
export function registerPhonePreflight(api: OpenClawPluginApi) {
  api.registerCli(
    ({ program }) => {
      program
        .command("complaint-phone-preflight")
        .description("Check the configured XHS phone flow without submitting a report")
        .requiredOption("--user-id <id>", "User already bound in complaintExecution.phone")
        .requiredOption("--url <url>", "Explicit canonical XHS note URL")
        .option("--category <category>", "Exact visible category", "不实信息")
        .action(async (raw: unknown) => {
          const options = z
            .object({
              userId: z.string().min(1),
              url: z.string().url(),
              category: z.string().min(1).max(100),
            })
            .parse(raw);
          const { phonePreflight } = await import("./preflight.runtime.js");
          const outcome = await phonePreflight(api, options);
          console.log(JSON.stringify(outcome));
          if (outcome.errorCode !== "PHONE_PREFLIGHT_READY") {
            process.exitCode = 1;
          }
        });
    },
    {
      descriptors: [
        {
          name: "complaint-phone-preflight",
          description: "Check the configured XHS phone without submitting",
          hasSubcommands: false,
        },
      ],
    },
  );
}
