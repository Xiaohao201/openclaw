export type UiEntryMode = "control-ui" | "rabbitmq-debug";

export function resolveUiEntryMode(search: string): UiEntryMode {
  return new URLSearchParams(search).get("mode") === "rabbitmq-debug"
    ? "rabbitmq-debug"
    : "control-ui";
}
