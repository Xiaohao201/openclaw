# WeChat Group Push

Registers `wechat_group_push` to send text through a configured warning service.
The tool requires `groupName`, `confirmed: true`, and `content`. There is no
default destination. Before each send, the agent must repeat the target group
name and wait for user confirmation, even when the initial request names a group.
The tool rejects missing confirmation and names outside the configured map. This is an outbound tool, not an inbound WeChat channel.

Example local configuration (replace placeholders):

```json
{
  "plugins": {
    "entries": {
      "wechat-group-push": {
        "enabled": true,
        "config": {
          "endpoint": "http://127.0.0.1:5002/warning_info",
          "groups": {
            "Example business group": "example-chat-id",
            "Another business group": "another-example-chat-id"
          },
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

Legacy `chatId` + `groupName` configuration remains readable, but still requires
explicit group selection and confirmation. Do not mix it with `groups`. The
confirmation flag records the agent's assertion; the conversational confirmation
is enforced by the tool instructions and bundled skill, not an independent approval UI.
