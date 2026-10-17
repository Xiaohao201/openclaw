# Shared browser sessions

> Historical Python implementation reference. Current deployment uses the native
> TypeScript executor and login helper. Do not run the commands below to configure
> the migrated plugin; see [Local reporting](../LOCAL_REPORTING.md).

## OpenClaw conversation workflow

Both `complaint_browser` login setup and direct complaint submission borrow the
current conversation's OpenClaw browser and exact tab. Start with `browser open`
or refresh an existing tab with `browser snapshot`. Ordinary browser calls prepare
the user's managed profile automatically, or use their explicit administrator
binding. The Python login worker requires the trusted handoff; it cannot select a
different account or start a replacement browser if the connection is unavailable.

## Shared platform accounts across application users

Automatically provisioned `leading-…` profiles retain separate CDP ports, browser
data directories, and conversation tabs. Their platform login state is synchronized
through a deployment-local pool. The initial source is the configured OpenClaw
default browser (`browser.defaultProfile`), the same browser used by
`pnpm openclaw browser` without a profile override. Existing accounts in an individual
user profile do not override that initial source.

Synchronization runs before browser operations, after page operations, and after
`complaint_browser` login finishes or is cancelled. New users import the existing
pool automatically. Login changes, token refreshes, and logout propagate on the
next synchronization, including back to the default browser. An older browser
revision cannot overwrite a newer shared revision. Existing pages are not reloaded
or submitted again; a page may need refreshing to display the new account.

Only the domains of the supported direct-reporting platforms participate. Cookies,
local storage, and IndexedDB are synchronized; unrelated sites remain local to
their browser. Platform CAPTCHA, device binding, and account expiry still apply.
Session storage and device-bound credentials are not portable login state.

The pool is stored as `leading-v2-shared-login.json` inside the OpenClaw state
directory. It contains credentials: keep the deployment's existing filesystem
access restrictions and do not commit or publish it. File locking and atomic writes
protect concurrent updates. After the first import, the saved pool remains usable
when the default browser is offline. If it has never been imported, browser actions
stop with a setup error rather than silently choosing another account.

For an `existing-session` default browser, enable Chrome remote debugging and
allow its connection prompt as described below. Explicit administrator bindings
for other profiles are not automatically added to the shared pool. Login sharing
does not share conversation tabs, tasks, history records, or task ownership.

Run the offline Chrome integration test by setting
`OPENCLAW_TEST_SHARED_LOGIN_CHROME` to the Chrome executable path and running
`pnpm test extensions/leading-v2/src/complaint/complaint-shared-login.browser.test.ts`.
It uses temporary browser profiles, distinct ports, and intercepted fixture pages.

Finishing, cancelling, or timing out login leaves the original browser and tab
open. Login/logout changes remain in the profile and enter the shared platform pool.
Afterwards, refresh the tab with `browser snapshot` using the tool's returned
`browserTargetId` as `targetId` before another handoff. Login and reporting hold
the same browser lease, so concurrent OpenClaw operations are blocked until release.

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

OpenClaw conversations automatically prepare a per-user managed profile. To
override that default, an operator can bind a specific user to an existing
OpenClaw Chrome profile without exporting cookies. The binding is stored in that
user's hashed session directory. This is a local CLI operation, not an agent tool
argument.

```powershell
python extensions/leading-v2/python/runner.py --bind-browser --user-id USER_ID --state-dir C:/path/to/state --profile-dir C:/path/to/state/browser/openclaw/user-data --cdp-url http://127.0.0.1:18800
```

Supply the profile and loopback CDP port belonging to that user. Do not bind
unrelated users to the same profile. When the configured CDP endpoint is running,
the OpenClaw tools borrow the conversation's existing tab. Closing the task leaves
the original browser and tab open. When the port is unavailable, the handoff stops
with `SHARED_BROWSER_UNAVAILABLE` without launching another browser.

Legacy standalone `runner.py --login` calls do not carry a conversation handoff:
they create a task tab and can launch the bound profile when its CDP endpoint is
offline. Use the OpenClaw conversation workflow above to share its running tab.

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
