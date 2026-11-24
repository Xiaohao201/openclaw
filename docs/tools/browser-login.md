---
summary: "Manual logins for browser automation + X/Twitter posting"
read_when:
  - You need to log into sites for browser automation
  - You want to post updates to X/Twitter
title: "Browser Login"
---

# Browser login + X/Twitter posting

## Manual login (recommended)

When a site requires login, **sign in manually** in the **host** browser profile (the pnpm openclaw browser).

Do **not** give the model your credentials. Automated logins often trigger anti‑bot defenses and can lock the account.

Back to the main browser docs: [Browser](/tools/browser).

## Human assistance in an integrated web client

An integration can opt a trusted execution session into the version 1
`openclaw/plugin-sdk/browser-assistance` contract. The browser plugin creates a
private managed browser for that execution. A detected verification or password
page pauses the browser tool; `action="handoff"` provides an explicit fallback.
The web client can show the same tab and forward bounded pointer and keyboard
input. Completing assistance checks the page again and returns a fresh snapshot,
without replaying the preceding click or submission.

The integration owns user authentication, session ownership, the encrypted viewer
transport, and delivery of sanitized status events. The SDK does not expose raw
CDP access to the web client. Requests are cancellable and limited to five minutes
at most; the enclosing run deadline still applies. Page refresh can reconnect to
a live request, but process restarts do not restore a suspended run. Browser
profiles are private to the execution and removed during normal cleanup.

Assistance currently requires a locally managed Chromium browser and does not
attach to an existing user profile, remote node, or sandbox browser. A visible
verification page does not guarantee the site will accept the browser session.

## Which Chrome profile is used?

OpenClaw controls a **dedicated Chrome profile** (named `openclaw`, orange‑tinted UI). This is separate from your daily browser profile.

For agent browser tool calls:

- Default choice: the agent should use its isolated `openclaw` browser.
- Use `profile="user"` only when existing logged-in sessions matter and the user is at the computer to click/approve any attach prompt.
- If you have multiple user-browser profiles, specify the profile explicitly instead of guessing.

Two easy ways to access it:

1. **Ask the agent to open the browser** and then log in yourself.
2. **Open it via CLI**:

```bash
pnpm openclaw browser start
pnpm openclaw browser open https://x.com
```

If you have multiple profiles, pass `--browser-profile <name>` (the default is `openclaw`).

## X/Twitter: recommended flow

- **Read/search/threads:** use the **host** browser (manual login).
- **Post updates:** use the **host** browser (manual login).

## Sandboxing + host browser access

Sandboxed browser sessions are **more likely** to trigger bot detection. For X/Twitter (and other strict sites), prefer the **host** browser.

If the agent is sandboxed, the browser tool defaults to the sandbox. To allow host control:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Then target the host browser:

```bash
pnpm openclaw browser open https://x.com --browser-profile openclaw --target host
```

Or disable sandboxing for the agent that posts updates.
