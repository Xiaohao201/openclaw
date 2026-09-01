import "./styles.css";
import { resolveUiEntryMode } from "./entry-mode.js";

async function boot(): Promise<void> {
  if (resolveUiEntryMode(window.location.search) === "rabbitmq-debug") {
    document.querySelector("openclaw-app")?.remove();
    await import("./ui/rabbitmq-debug/app.js");
    document.documentElement.lang = "zh-CN";
    document.title = "夙衡 · RabbitMQ 本地测试";
    document.body.append(document.createElement("suheng-rabbitmq-debug-app"));
    return;
  }
  await import("./ui/app.js");
}

void boot();
