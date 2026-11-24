# Lobster browser assistance

This opt-in integration connects the browser plugin's version 1 assistance
contract to the Lobster application. Status events use Mercure and sanitized
`history_messages.metadata.browserAssistance`; JPEG frames and user input use a
separate authenticated WebSocket relay. No database migration is required.

## Configuration and deployment

1. Build and deploy the matching OpenClaw and `ai-assistant` changes together.
   Forward WebSocket upgrade requests for `/api/lobster/browser-channel`. For
   a clustered PM2 website, use the dedicated relay described below; the Nitro
   route is suitable only when every connection reaches the same app process.
2. Generate a random secret of at least 32 characters. Set
   `LOBSTER_BROWSER_RELAY_SECRET` in both server environments. Do not put it in
   public runtime config, a browser bundle, chat messages, or a URL.
3. Set `LOBSTER_BROWSER_RELAY_URL=wss://app.example.com/api/lobster/browser-channel`
   on the execution server. Only loopback development permits `ws:`. The worker
   initiates an outbound connection, so the browser/CDP port remains private.
4. Route this WebSocket path to **one relay instance**. Its rooms and admission
   nonces are process-local. Ordinary user-based sticky sessions are insufficient
   because execution workers and viewers are different connections. Horizontal
   relay routing requires a separate shared routing design.
5. Enable only for a test deployment first. Keep existing host browser policy,
   executable configuration, and SSRF restrictions. Assistance uses a new private
   local profile for each execution; existing login sessions are not imported.
6. Validate a controlled verification page, two concurrent users, cancellation,
   a refreshed page, a lost viewer connection, a closed tab, and an execution
   restart. Never use real passwords or CAPTCHA solving in automated tests.

The feature is disabled when both relay variables are absent. An incomplete
configuration fails explicitly. Disable by removing both variables on OpenClaw
and restarting after active turns finish. Remove the website secret to reject new
relay connections. Persistent metadata can be retained during rollback.

## Clustered website deployment

The matching `ai-assistant` checkout builds a standalone relay with `pnpm build`
(or `pnpm build:browser-assistance-relay` after relay-only changes). It imports
only the relay protocol and ticket verifier; it does not start website consumers.

Set `LOBSTER_BROWSER_RELAY_SECRET` and `LOBSTER_BROWSER_RELAY_PORT` in the website's
private shared environment file. The main `ecosystem.config.js` explicitly
forwards the secret so authenticated HTTP endpoints can issue viewer tickets.
`ecosystem.browser-assistance.config.js` runs exactly one relay process, bound to
loopback. Use the same PM2 owner as the website:

```sh
APP_ENV_FILE=/path/to/shared/.env APP_CURRENT_DIR=/path/to/current \
  pm2 startOrReload /path/to/current/ecosystem.browser-assistance.config.js --update-env
pm2 save
```

Include `deploy/nginx/browser-assistance.location.conf` in the website's HTTPS
virtual host, and make its upstream port match `LOBSTER_BROWSER_RELAY_PORT`.
The template defaults to port 3002. Run `nginx -t` before reloading. Only the HTTPS
port needs to be publicly reachable; do not expose the relay, CDP, or browser bridge.
The relay sends heartbeat pings and the Nginx template allows long-lived upgrades.

On every later website release, rebuild and reload both PM2 configurations after
switching `current`; the existing website deployment script only reloads the main
application. Keep the previous release and shared-environment backup for rollback.
A relay restart ends active takeover sessions, so deploy after they have finished.
Check `/healthz` on loopback, unauthenticated viewer-ticket rejection, and a signed
worker/viewer exchange through the public WSS URL before running a real task.

On Windows, put the two worker variables in `%USERPROFILE%\.openclaw\.env`
and restart the existing OpenClaw gateway service. A Startup-folder installation
starts at Windows login, so the computer must remain on and the gateway must be
running to consume cloud tasks. Use `openclaw gateway status --json` to verify
readiness. Keep `browser.headless` consistent with the host's runtime environment.

## Verifying alongside an older production worker

Do not attach a new test worker to a busy production queue alongside an older
worker: RabbitMQ may deliver the test task to either version. Keep the production
worker running and configure the test OpenClaw instance with a separate
`plugins.entries.rabbitmq-consumer.config.rabbitmq.queue` (and matching
`RABBITMQ_QUEUE` environment value). Its control queue uses the `.control` suffix.

The website supports a narrowly scoped route through three private PM2 variables:
`LOBSTER_CHAT_CANARY_USER_ID`, `LOBSTER_CHAT_CANARY_SESSION_ID`, and
`LOBSTER_CHAT_CANARY_QUEUE`. Only the exact authenticated user and session pair
uses that queue. Other sessions and users retain the normal queue. Both task
submission and cancellation use the same resolver. Reload the main PM2 application
after changing these values; the relay does not need to restart for route changes.

Use the controlled live test runner's pre-submit pause to read the UI-generated
session id, configure this exact route, and release the original request unchanged.
Keep normal browser authentication and authorization enabled. After verification,
the selected session can remain available for operator testing; a wider rollout
requires updating the production worker separately. Never stop a worker serving
real users just to make a test deterministic.

## Behavior and limits

- A request waits up to three minutes by default, bounded by the enclosing run.
  The consumer's `turnTimeoutMs` is only a polling window and does not extend the
  run deadline. Waiting occupies a consumer slot; size concurrency accordingly.
- A viewer ticket lasts at most 60 seconds for admission and is single-use. The
  authenticated owner, history row, request, and worker deadline must all match.
  Only one viewer can control a request at a time.
- Closing the viewer does not resume the agent. The viewer can reconnect while
  the original request is alive. Completing verifies the same tab; Stop cancels
  the current run through the existing durable cancellation mechanism.
- Process restarts invalidate live requests. Stored pending metadata does not
  imply a resumable process; the viewer reports that the request is unavailable.
- Capture covers web content, not native browser chrome, OS dialogs, hardware
  security keys, or file pickers. Headless/browser reputation can still cause a
  site to refuse verification. DNS and network failures are not CAPTCHA evidence.
- Normal cleanup stops only the execution's browser and removes its private
  profile. After an unclean host shutdown an operator should remove orphaned
  `assist-*` profiles only after verifying no process still owns them.

## Protocol

Both sides send a `hello` containing a signed version 1 ticket as their first
WebSocket message. Tickets are HMAC-SHA256 over a base64url JSON payload with
`role`, `userId`, `historyId`, `requestId`, `expiresAt`, and a random `nonce`.
The relay supplies the controller identity and enforces increasing input sequence
numbers. Only frames, sanitized state, completion results, and bounded input are
forwarded. Never log WebSocket payloads or record frames, passwords, or cookies.

## Local verification

Run the scoped browser/consumer tests through the repository entrypoint:

```sh
pnpm test extensions/browser/src/assistance extensions/rabbitmq-consumer/src/browser-assistance.test.ts extensions/browser/src/browser/bridge-server.auth.test.ts
```

Set `OPENCLAW_BROWSER_ASSISTANCE_E2E=1` to include the real local browser tests.
`OPENCLAW_BROWSER_TEST_EXECUTABLE` can select an installed Chromium executable.
These tests use a controlled local challenge page, not a third-party CAPTCHA.

In the matching website checkout, run:

```sh
node --test --experimental-strip-types server/utils/browser-assistance-*.test.ts scripts/tests/browser-assistance-api.test.mjs server/utils/lobster-session-stream.test.ts
node scripts/tests/browser-assistance-ui.mjs
node scripts/tests/browser-assistance-launch.mjs
```

The UI harness renders the actual Vue component with simulated HTTP/WebSocket
boundaries. It does not start the application, database consumers, or real tasks.
Set `OPENCLAW_ROOT` if the OpenClaw checkout is not a sibling named `openclaw`.
Production rollout still requires an integration smoke test through the configured
relay, identity service, queue, and status delivery.
