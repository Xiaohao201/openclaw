---
summary: "CLI reference for `pnpm openclaw browser` (lifecycle, profiles, tabs, actions, state, and debugging)"
read_when:
  - You use `pnpm openclaw browser` and want examples for common tasks
  - You want to control a browser running on another machine via a node host
  - You want to attach to your local signed-in Chrome via Chrome MCP
title: "browser"
---

# `pnpm openclaw browser`

Manage OpenClaw's browser control surface and run browser actions (lifecycle, profiles, tabs, snapshots, screenshots, navigation, input, state emulation, and debugging).

Related:

- Browser tool + API: [Browser tool](/tools/browser)

Run the commands below from the OpenClaw repository root. The `pnpm openclaw` script uses this checkout.

For server deployments, run `pnpm build` and start the browser before accepting user requests. The source launcher prepares plugin runtime artifacts on its first invocation and reuses them while inputs and outputs remain unchanged. Changes to source, dependencies, or generated artifacts can require preparation again. A `Preparing plugin runtime artifacts...` message identifies this phase, which runs before the browser request timeout starts.

## Common flags

- `--url <gatewayWsUrl>`: Gateway WebSocket URL (defaults to config).
- `--token <token>`: Gateway token (if required).
- `--timeout <ms>`: request timeout (ms).
- `--expect-final`: wait for a final Gateway response.
- `--browser-profile <name>`: choose a browser profile (default from config).
- `--json`: machine-readable output (where supported).

## Quick start (local)

```bash
pnpm openclaw browser profiles
pnpm openclaw browser --browser-profile openclaw start
pnpm openclaw browser --browser-profile openclaw open https://example.com
pnpm openclaw browser --browser-profile openclaw snapshot
```

## Quick troubleshooting

If `start` fails with `not reachable after start`, troubleshoot CDP readiness first. If `start` and `tabs` succeed but `open` or `navigate` fails, the browser control plane is healthy and the failure is usually navigation SSRF policy.

Minimal sequence:

```bash
pnpm openclaw browser --browser-profile openclaw start
pnpm openclaw browser --browser-profile openclaw tabs
pnpm openclaw browser --browser-profile openclaw open https://example.com
```

Detailed guidance: [Browser troubleshooting](/tools/browser#cdp-startup-failure-vs-navigation-ssrf-block)

## Lifecycle

```bash
pnpm openclaw browser status
pnpm openclaw browser start
pnpm openclaw browser stop
pnpm openclaw browser --browser-profile openclaw reset-profile
```

Notes:

- For `attachOnly` and remote CDP profiles, `pnpm openclaw browser stop` closes the
  active control session and clears temporary emulation overrides even when
  OpenClaw did not launch the browser process itself.
- For local managed profiles, `pnpm openclaw browser stop` stops the spawned browser
  process.

## If the command is missing

If `pnpm openclaw browser` is an unknown command, check `plugins.allow` in
`~/.openclaw/openclaw.json`.

When `plugins.allow` is present, the bundled browser plugin must be listed
explicitly:

```json5
{
  plugins: {
    allow: ["telegram", "browser"],
  },
}
```

`browser.enabled=true` does not restore the CLI subcommand when the plugin
allowlist excludes `browser`.

Related: [Browser tool](/tools/browser#missing-browser-command-or-tool)

## Profiles

Profiles are named browser routing configs. In practice:

- `openclaw`: launches or attaches to a dedicated OpenClaw-managed Chrome instance (isolated user data dir).
- `user`: controls your existing signed-in Chrome session via Chrome DevTools MCP.
- custom CDP profiles: point at a local or remote CDP endpoint.

```bash
pnpm openclaw browser profiles
pnpm openclaw browser create-profile --name work --color "#FF5A36"
pnpm openclaw browser create-profile --name chrome-live --driver existing-session
pnpm openclaw browser create-profile --name remote --cdp-url https://browser-host.example.com
pnpm openclaw browser delete-profile --name work
```

Use a specific profile:

```bash
pnpm openclaw browser --browser-profile work tabs
```

## Tabs

```bash
pnpm openclaw browser tabs
pnpm openclaw browser tab new
pnpm openclaw browser tab select 2
pnpm openclaw browser tab close 2
pnpm openclaw browser open https://docs.openclaw.ai
pnpm openclaw browser focus <targetId>
pnpm openclaw browser close <targetId>
```

## Snapshot / screenshot / actions

Snapshot:

```bash
pnpm openclaw browser snapshot
```

Screenshot:

```bash
pnpm openclaw browser screenshot
pnpm openclaw browser screenshot --full-page
pnpm openclaw browser screenshot --ref e12
```

Notes:

- `--full-page` is for page captures only; it cannot be combined with `--ref`
  or `--element`.
- `existing-session` / `user` profiles support page screenshots and `--ref`
  screenshots from snapshot output, but not CSS `--element` screenshots.

Navigate/click/type (ref-based UI automation):

```bash
pnpm openclaw browser navigate https://example.com
pnpm openclaw browser click <ref>
pnpm openclaw browser type <ref> "hello"
pnpm openclaw browser press Enter
pnpm openclaw browser hover <ref>
pnpm openclaw browser scrollintoview <ref>
pnpm openclaw browser drag <startRef> <endRef>
pnpm openclaw browser select <ref> OptionA OptionB
pnpm openclaw browser fill --fields '[{"ref":"1","value":"Ada"}]'
pnpm openclaw browser wait --text "Done"
pnpm openclaw browser evaluate --fn '(el) => el.textContent' --ref <ref>
```

File + dialog helpers:

```bash
pnpm openclaw browser upload /tmp/openclaw/uploads/file.pdf --ref <ref>
pnpm openclaw browser waitfordownload
pnpm openclaw browser download <ref> report.pdf
pnpm openclaw browser dialog --accept
```

## State and storage

Viewport + emulation:

```bash
pnpm openclaw browser resize 1280 720
pnpm openclaw browser set viewport 1280 720
pnpm openclaw browser set offline on
pnpm openclaw browser set media dark
pnpm openclaw browser set timezone Europe/London
pnpm openclaw browser set locale en-GB
pnpm openclaw browser set geo 51.5074 -0.1278 --accuracy 25
pnpm openclaw browser set device "iPhone 14"
pnpm openclaw browser set headers '{"x-test":"1"}'
pnpm openclaw browser set credentials myuser mypass
```

Cookies + storage:

```bash
pnpm openclaw browser cookies
pnpm openclaw browser cookies set session abc123 --url https://example.com
pnpm openclaw browser cookies clear
pnpm openclaw browser storage local get
pnpm openclaw browser storage local set token abc123
pnpm openclaw browser storage session clear
```

## Debugging

```bash
pnpm openclaw browser console --level error
pnpm openclaw browser pdf
pnpm openclaw browser responsebody "**/api"
pnpm openclaw browser highlight <ref>
pnpm openclaw browser errors --clear
pnpm openclaw browser requests --filter api
pnpm openclaw browser trace start
pnpm openclaw browser trace stop --out trace.zip
```

## Existing Chrome via MCP

Use the built-in `user` profile, or create your own `existing-session` profile:

```bash
pnpm openclaw browser --browser-profile user tabs
pnpm openclaw browser create-profile --name chrome-live --driver existing-session
pnpm openclaw browser create-profile --name brave-live --driver existing-session --user-data-dir "~/Library/Application Support/BraveSoftware/Brave-Browser"
pnpm openclaw browser --browser-profile chrome-live tabs
```

This path is host-only. For Docker, headless servers, Browserless, or other remote setups, use a CDP profile instead.

Current existing-session limits:

- snapshot-driven actions use refs, not CSS selectors
- `click` is left-click only
- `type` does not support `slowly=true`
- `press` does not support `delayMs`
- `hover`, `scrollintoview`, `drag`, `select`, `fill`, and `evaluate` reject
  per-call timeout overrides
- `select` supports one value only
- `wait --load networkidle` is not supported
- file uploads require `--ref` / `--input-ref`, do not support CSS
  `--element`, and currently support one file at a time
- dialog hooks do not support `--timeout`
- screenshots support page captures and `--ref`, but not CSS `--element`
- `responsebody`, download interception, PDF export, and batch actions still
  require a managed browser or raw CDP profile

## Remote browser control (node host proxy)

If the Gateway runs on a different machine than the browser, run a **node host** on the machine that has Chrome/Brave/Edge/Chromium. The Gateway will proxy browser actions to that node (no separate browser control server required).

Use `gateway.nodes.browser.mode` to control auto-routing and `gateway.nodes.browser.node` to pin a specific node if multiple are connected.

Security + remote setup: [Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)
