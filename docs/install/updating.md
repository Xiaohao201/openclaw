---
summary: "Updating OpenClaw safely (global install or source), plus rollback strategy"
read_when:
  - Updating OpenClaw
  - Something breaks after an update
title: "Updating"
---

# Updating

Keep OpenClaw up to date.

## Recommended: `openclaw update`

The fastest way to update. It detects your install type (npm or git), fetches the latest version, runs `openclaw doctor`, and restarts the gateway.

```bash
openclaw update
```

To switch channels or target a specific version:

```bash
openclaw update --channel beta
openclaw update --tag main
openclaw update --dry-run   # preview without applying
```

`--channel beta` prefers beta, but the runtime falls back to stable/latest when
the beta tag is missing or older than the latest stable release. Use `--tag beta`
if you want the raw npm beta dist-tag for a one-off package update.

See [Development channels](/install/development-channels) for channel semantics.

## Alternative: re-run the installer

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Add `--no-onboard` to skip onboarding. For source installs, pass `--install-method git --no-onboard`.

## Alternative: manual npm, pnpm, or bun

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

```bash
bun add -g openclaw@latest
```

## Native Windows source server deployment

For a native Windows checkout that currently keeps the gateway alive in a terminal with
`pnpm openclaw gateway`, this repository includes an idempotent deployment helper:

```powershell
.\deploy-server.cmd
```

By default it deploys `origin/v1`. The helper fetches that branch into an isolated Git
worktree, installs locked dependencies, runs static checks, builds OpenClaw, creates and
verifies a state/config backup, runs `doctor`, and activates OpenClaw's native Windows
Scheduled Task. If task creation is denied, OpenClaw uses its per-user Startup-folder
fallback. On the first run, the managed restart takes over the gateway port from the old
foreground process. Later runs leave the active release unchanged until the replacement
passes its RPC health check; a failed activation restores the previous built release.

OpenClaw configuration, credentials, sessions, and workspaces remain in their existing
locations. Release worktrees, backups, deployment state, and the concurrency lock default
to `%LOCALAPPDATA%\OpenClawDeploy`.

Useful operations:

```powershell
.\deploy-server.cmd dry-run
.\deploy-server.cmd status
.\deploy-server.cmd rollback
```

Override the source when needed:

```powershell
$env:OPENCLAW_DEPLOY_REMOTE = "origin"
$env:OPENCLAW_DEPLOY_BRANCH = "main"
.\deploy-server.cmd
```

Requirements: native Windows, Node.js 22 or newer, pnpm, and Git. The managed gateway
survives closing the deployment terminal and starts when that Windows user signs in. A
native per-user Scheduled Task does not provide pre-login startup. The gateway is restarted
in place, so expect a short interruption; this is not a zero-downtime multi-instance
deployment.

## Auto-updater

The auto-updater is off by default. Enable it in `~/.openclaw/openclaw.json`:

```json5
{
  update: {
    channel: "stable",
    auto: {
      enabled: true,
      stableDelayHours: 6,
      stableJitterHours: 12,
      betaCheckIntervalHours: 1,
    },
  },
}
```

| Channel  | Behavior                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| `stable` | Waits `stableDelayHours`, then applies with deterministic jitter across `stableJitterHours` (spread rollout). |
| `beta`   | Checks every `betaCheckIntervalHours` (default: hourly) and applies immediately.                              |
| `dev`    | No automatic apply. Use `openclaw update` manually.                                                           |

The gateway also logs an update hint on startup (disable with `update.checkOnStart: false`).

## After updating

<Steps>

### Run doctor

```bash
openclaw doctor
```

Migrates config, audits DM policies, and checks gateway health. Details: [Doctor](/gateway/doctor)

### Restart the gateway

```bash
openclaw gateway restart
```

### Verify

```bash
openclaw health
```

</Steps>

## Rollback

### Pin a version (npm)

```bash
npm i -g openclaw@<version>
openclaw doctor
openclaw gateway restart
```

Tip: `npm view openclaw version` shows the current published version.

### Pin a commit (source)

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
pnpm install && pnpm build
openclaw gateway restart
```

To return to latest: `git checkout main && git pull`.

## If you are stuck

- Run `openclaw doctor` again and read the output carefully.
- For `openclaw update --channel dev` on source checkouts, the updater auto-bootstraps `pnpm` when needed. If you see a pnpm/corepack bootstrap error, install `pnpm` manually (or re-enable `corepack`) and rerun the update.
- Check: [Troubleshooting](/gateway/troubleshooting)
- Ask in Discord: [https://discord.gg/clawd](https://discord.gg/clawd)

## Related

- [Install Overview](/install) — all installation methods
- [Doctor](/gateway/doctor) — health checks after updates
- [Migrating](/install/migrating) — major version migration guides
