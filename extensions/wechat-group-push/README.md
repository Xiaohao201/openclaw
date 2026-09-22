# WeChat Group Push

Registers `wechat_group_push` to send text through a configured warning service.
The tool's sole argument is `content`; the destination is fixed by local config.
The bundled skill maps explicit requests to send to the default WeChat group to
this tool. This is an outbound tool, not an inbound WeChat channel.

Example local configuration (replace placeholders):

```json
{
  "plugins": {
    "entries": {
      "wechat-group-push": {
        "enabled": true,
        "config": {
          "endpoint": "http://127.0.0.1:5002/warning_info",
          "chatId": "example-chat-id",
          "groupName": "Example business group",
          "timeoutMs": 15000
        }
      }
    }
  }
}
```

The endpoint must accept `POST { "chatid": "...", "content": "..." }` and return
the enterprise WeChat JSON response with numeric `errcode` (`0` means success).
The gateway host must be able to reach this trusted service. HTTP 200 alone is
not proof of delivery. Errors, malformed responses, and timeouts are never retried.
Messages are limited to 2048 UTF-8 bytes and preserved verbatim.

Enable the plugin and restart the gateway. If your tool policy restricts plugin
tools, include `wechat_group_push` in `tools.alsoAllow`. In a source checkout with
an older built runtime, add this plugin's directory to `plugins.load.paths`.

Run `pnpm test extensions/wechat-group-push` for mock-only verification. Tests do
not send real group messages. Keep live endpoints and chat IDs in local config,
not committed source files.
