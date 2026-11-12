# WeChat Group Push

Registers `wechat_group_push` to send text through a configured warning service.

## Group administration

The plugin also registers `GET/POST /api/plugins/wechat-group-push/groups`, protected
by Gateway authentication with the trusted-operator scope. Only a trusted server
should call it; never put a Gateway token in browser code. GET returns only the
group map and a config revision. POST accepts a revision and one action: `add`
(`name`, `chatId`), `update` (`originalName`, `name`, `chatId`), `delete` (`name`),
or `create` (`name`, `owner`, `userlist`, `requestId`). Creation uses a client-generated
32-character lowercase hexadecimal request ID as the WeCom chat ID.

Set `WECOM_CORP_ID` and `WECOM_APP_SECRET` in the Gateway process environment to
enable creation of WeCom application group chats. Existing mappings can be managed
without these credentials. Creation is never automatically retried. A
`created_unsaved` result includes the created chat ID for recovery using `add`;
`CREATE_UNKNOWN` errors require checking that ID before creating another group.
No messages are sent by group administration. Deleting a mapping does not dissolve
the real group, and the final mapping cannot be removed.

Writes preserve other config sections through the public configuration writer.
Requests are serialized and revisions reject stale edits. External file editors
do not participate in this serialization; avoid simultaneous direct file edits.
Restart once after deploying this code to register the new HTTP route.

## Sending
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
