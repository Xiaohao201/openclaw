# Shared Supervisor and release entrypoints

All release directories use one Supervisor configuration and deployment journal:

```text
release/
  source/                     Stable source checkout and installed dependencies
  supervisor/
    supervisor.json           Shared Gateway config and state locations
    deployment-state.json     Last selected release and deployment phase
    deployment-state.json.recovery.json
  001/
    deploy.mjs                Operator entrypoint for 001
  002/
    deploy.mjs                Operator entrypoint for 002
```

Keep the stable source checkout and its dependencies available. The generated
entrypoints invoke its deployment scripts, without copying the Supervisor state
into each release. Entry points contain absolute paths; moving a deployment tree
requires updating its deployment configuration and entrypoints.

## Prepare and start

From the source checkout, build a new directory outside the checkout:

```powershell
pnpm deploy:prepare --output "C:\OpenClaw\release\001"
```

Preparation exports committed HEAD, builds and verifies the release, creates or
preserves the shared configuration, and writes `deploy.mjs` in the release.
It does not switch or stop a running service. Review the printed Gateway
authentication and trusted proxy instructions before first startup.

The v3 build excludes the unused Feishu plugin from bundled runtime output.
Its `extensions/feishu/package.json` sets `openclaw.bundle.enabled` to `false`.
This plugin-owned build flag skips entry bundling and runtime dependency staging;
source files and workspace dependencies remain available for Plugin SDK types.
Other plugins keep their existing build behavior. To bundle Feishu again, remove
that flag or set it to `true`, commit the change, and prepare a new release.
Use a new output directory after a failed preparation; existing directories are
never overwritten.

After stopping any previous standalone Gateway, start from the release directory:

```powershell
cd "C:\OpenClaw\release\001"
node deploy.mjs serve
```

Keep this foreground terminal open. In another terminal in that directory:

```powershell
node deploy.mjs status
```

Status shows `targetRelease` (the entrypoint's directory), `release` (the shared
Supervisor's selected release), and `releaseMatches`. Check `phase: "running"`
and a non-null `pid`; a selected release alone does not mean it is serving.

## Update the shared service

Prepare `002` from the source checkout, then run:

```powershell
cd "C:\OpenClaw\release\002"
node deploy.mjs status
node deploy.mjs deploy --compatible-state
node deploy.mjs status
```

Pass `--compatible-state` only after confirming that the releases can share the
same data and configuration and that rollback is compatible. The command uses
the existing Supervisor; it does not start another one. Cutover may briefly
return HTTP 503 and disconnect clients. It does not provide plugin hot-plugging.

`serve` never silently switches versions. If the shared configuration or journal
selects `001`, invoking `serve` from `002` reports both paths and exits before
starting a worker. Use `deploy` when the shared Supervisor is running.

## Existing releases and recovery

From the updated source checkout, add an entrypoint to a verified existing release:

```powershell
pnpm deploy:prepare --configure "C:\OpenClaw\release\002"
```

This preserves shared configuration and state, and refuses to overwrite a
different existing `deploy.mjs`. It does not repair an invalid artifact.

From any prepared release, these commands target the shared service:

```powershell
node deploy.mjs stop
node deploy.mjs recover
```

`stop` acknowledges a shutdown request; wait for the serving terminal to exit
before editing state. `recover` is only for a blocked Supervisor and retries its
selected release, which may differ from the entrypoint directory. Inspect
`status` first. Neither command automatically deletes journals or resets the
selected release to the current directory.

The existing `pnpm deploy:serve <supervisor.json>` and
`pnpm deploy:control <supervisor.json> ...` commands remain available for service
installations and administration from the stable source checkout.
