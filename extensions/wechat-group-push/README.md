# WeChat Group Push

Registers `wechat_group_push` to send text through a configured warning service.
The tool requires `groupName`, `destinationVersion`, `confirmed: true`, and `content`. There is no
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
          "endpoint": "https://your-aliyun-domain.example/warning_info",
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

With the default `gateway.reload.mode=hybrid` (or `hot`), edits under
`plugins.entries.wechat-group-push.config.groups` take effect without restarting
the gateway. The next tool creation reads the current group list; already-running
model requests keep their original tool schema. Other plugin settings retain their
normal restart behavior. Deploying this plugin update requires one initial restart.

Each send reads and validates the config file again. Missing, invalid, disabled,
or removed destinations stop the send. The agent must preserve the internal
`destinationVersion` from when it asks for confirmation; a changed endpoint or
group ID invalidates that version and requires fresh confirmation. The version
does not independently prove user consent. Changes after a request has already
been dispatched cannot recall that message.

Run `pnpm test extensions/wechat-group-push` for mock-only verification. Tests do
not send real group messages. Keep live endpoints and chat IDs in local config,
not committed source files.

Legacy `chatId` + `groupName` configuration remains readable, but still requires
explicit group selection and confirmation. Do not mix it with `groups`. The
confirmation flag records the agent's assertion; the conversational confirmation
is enforced by the tool instructions and bundled skill, not an independent approval UI.

## Aliyun relay configuration

Set `plugins.entries.wechat-group-push.config.endpoint` in the active OpenClaw
configuration file (normally `~/.openclaw/openclaw.json`) to the full relay URL:
`https://your-aliyun-domain.example/warning_info`. Replace the placeholder domain
before sending, and preserve `/warning_info` (or the path exposed by your proxy).
Keep the existing `groups` map: the plugin resolves the selected group name and
posts `{ "chatid": "...", "content": "..." }` to this endpoint.

The Aliyun service owns enterprise credentials, access tokens, and the call to
`appchat/send`. No enterprise credentials belong in this plugin configuration.
Although the server supports a default group when `chatid` is omitted, this
plugin always supplies the explicitly selected group's ID. Restart the gateway
after changing the endpoint. A placeholder endpoint is not a working deployment.
