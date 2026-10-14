# Shared browser sessions

## Reuse the operator's everyday Chrome

Chrome 144+ can expose its existing session after the operator enables remote
debugging at `chrome://inspect/#remote-debugging`. Keep Chrome open and approve
its connection prompt. Check connectivity without visiting a platform:

```powershell
python extensions/leading-v2/python/runner.py --check-browser --existing-chrome
```

Bind this browser to the operator's application user once:

```powershell
python extensions/leading-v2/python/runner.py --bind-browser --existing-chrome --user-id USER_ID --state-dir C:/path/to/state
```

The default is the OS user's stable Chrome data directory. Use `--profile-dir`
for another browser data directory (the parent of `Default`, not `Default`
itself). The selected directory must match the one OpenClaw uses. For default
Chrome, OpenClaw's built-in `user` profile targets the same session:

```powershell
pnpm openclaw browser --browser-profile user start
pnpm openclaw browser --browser-profile user tabs
```

The runner discovers Chrome's current loopback WebSocket address from
`DevToolsActivePort` on each task, matching Chrome MCP's discovery mechanism.
It uses Playwright over CDP to retain the existing platform handlers. This is
live session reuse: login and logout are visible to both clients without
exporting or copying cookies. A successful connection alone does not prove a
particular platform is logged in; each task still checks that platform.

When discovery, connection, or Chrome consent fails, the runner returns
`SHARED_BROWSER_UNAVAILABLE`. It never launches a replacement browser for an
`existing-session` binding. Task cleanup leaves the operator's original tabs
and Chrome running. OpenClaw and the runner should not manipulate the same task
tab concurrently. Each application user must be bound to their own intended
operator session; no global binding is inferred from whichever Chrome is open.

## Reuse an OpenClaw-managed Chrome profile

The local complaint runner defaults to isolated sessions. An operator can opt a
specific user into an existing OpenClaw Chrome profile without exporting cookies.
The binding is stored in that user's hashed session directory; unbound users keep
their isolated sessions. This is a local CLI operation, not an agent tool argument.

```powershell
python extensions/leading-v2/python/runner.py --bind-browser --user-id USER_ID --state-dir C:/path/to/state --profile-dir C:/path/to/state/browser/openclaw/user-data --cdp-url http://127.0.0.1:18800
```

Supply the profile and loopback CDP port belonging to that user. Do not bind
unrelated users to the same profile. When the configured CDP endpoint is running,
the runner uses its context and creates a new task tab. Closing the task closes
only its tabs and disconnects; the original browser and tabs remain open. When
the port is unavailable, the runner opens that same profile with installed Chrome.
If Chrome already holds the profile without the configured debug endpoint, the
runner stops with `SHARED_BROWSER_UNAVAILABLE` instead of using another profile.

Login and logout changes persist in the shared profile in both directions.
`runner.py --login --platform PLATFORM --user-id USER_ID --state-dir STATE_DIR`
uses the binding too. Normal platform login, CAPTCHA, and account restrictions
still apply; a shared profile does not guarantee every platform is authenticated.
The anonymous 12377 flow remains separate.

A trusted local Fake-IP proxy may resolve public domains to `198.18.0.0/15`.
Only when this matches the operator's OpenClaw network policy, add
`--allow-fake-ip` to the binding command. The default rejects these addresses.
This option does not allow loopback, RFC1918, link-local, or other private ranges.
It is not equivalent to `dangerouslyAllowPrivateNetwork`. Browser egress must
still be controlled at the deployment level, as with isolated sessions.

A profile-level `.openclaw-complaint.lock` serializes local complaint use. After a
crash, inspect the recorded process and outstanding tasks before removing a stale
lock. Do not manually operate a task tab while its complaint flow is running.
An existing binding cannot be silently replaced: stop that user's jobs and inspect
or remove their `browser-binding.json` before changing profiles or policy.

Validation: `python -m unittest discover -s extensions/leading-v2/python -p 'test_*.py'`.
