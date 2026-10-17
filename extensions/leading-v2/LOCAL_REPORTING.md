# Direct local reporting

`complaint_submit` uses the native TypeScript executor inside the `leading-v2`
plugin. No Python process, virtual environment, separate reporting service or
replacement Chrome is started. The original Python directory is retained as a
migration reference; it is not packaged or invoked by the plugin.

## Installation and configuration

Install workspace dependencies and run `pnpm build`. The build stages the Android
server JAR and its notices into the built plugin. Check a source or built plugin:

```powershell
node extensions/leading-v2/check-runtime.mjs extensions/leading-v2
node extensions/leading-v2/check-runtime.mjs dist/extensions/leading-v2
```

The Windows deployment script runs these checks before restarting the Gateway.
The `complaintExecution` configuration defaults to:

```json
{ "mode": "local", "timeoutMs": 900000 }
```

Legacy `python`, `runtimeDir` and `headless` keys are accepted as compatibility
inputs and ignored. OpenClaw owns the browser's process, profile and visibility.
There is no Python fallback after native execution fails.

## Accounts and browser handoff

The trusted `rabbitmq-<userId>` identity selects the user. Batches and sessions are
partitioned by SHA-256 of that ID. Tool callers cannot choose another user's ID,
profile directory or device. Open a platform page with the current conversation's
`browser` tool, or refresh its existing page using `browser snapshot`.

Each user's managed OpenClaw profile keeps its own platform login. Opening a page
does not require the machine's default browser or everyday Chrome to be running
or logged in. No cookies, local storage or IndexedDB are automatically imported
from those browsers or other users. Log in directly in the user's OpenClaw browser;
the login helper and reporter reuse that same profile and exact tab. Existing
explicit administrator bindings remain supported.

The retired `leading-v2-shared-login.json` pool is ignored, including missing or
corrupt files. This change does not erase cookies already present in a user profile;
check the displayed platform account and log out there if it is not the intended one.

`complaint_browser(action=login, platform=weibo, confirmed=true)` uses that exact
page after explicit login authorization. The user completes login and CAPTCHA.
`screenshot` returns the current login image without retaining it in status.
`finish` requires explicit confirmation; `cancel`, shutdown and ten-minute expiry
release the connection. All leave the borrowed browser and tab open. Finish is a
user acknowledgment, not proof of authentication or report submission. Refresh
`browserTargetId` with `browser snapshot` before another handoff.

Only the recorded target ID and page marker can be acquired. A profile lock and
conversation ownership prevent concurrent use. Missing, stale or conflicting
handoffs fail before reporting. No disconnected browser is silently replaced.

## Submission inputs and supported flows

The tool requires `basisSource=AgentJudgment`, `confirmed=true`, `subjectScope`,
`judgment`, and explicit `links`. Multiple links require one `linkJudgments` item
per link. Supply approved platform category text in `categories`, with
`subCategory` when needed. The executor accepts a unique exact label or a curated
alias visible in the form. It does not infer allegations or invent categories.
An unresolved category returns `manual_required`. Reasons exceeding a platform's
form limit require a shorter approved reason; they are not silently truncated.

All 16 enabled direct platforms route to TypeScript: Baidu, Bilibili, Douyin,
Eastmoney, Futu, Kuaishou, NetEase, Sina, Sohu, Tencent, Tiantian Fund, Toutiao,
Weibo, Xiaohongshu, Yidianzixun and Zhihu. Previously unavailable platforms remain
excluded. Adapters validate content identities, page/form readiness and fresh
receipts. Special paths include Bilibili frames, Weibo popups, bound report-page
links, Sina article/community forms and Xiaohongshu app-only pages. Identity,
CAPTCHA or material requirements stop for the operator. Platform UI changes can
still require selector maintenance; offline fixtures are not live-site certification.

## 12377 anonymous channel

Only an explicit user choice authorizes this separate channel. Pass
`report12377: {category: "rumor", websiteName: "Example"}`. Supported anonymous
categories are politics, terrorism, fraud, pornography, vulgarity, gambling and
rumor. Each URL/reason is limited to 500 UTF-16 units. Open and hand off a page in
the current conversation first; no separate anonymous browser is launched.

The executor navigates the official notice and anonymous form, validates the
category and fills the approved fields. The operator checks subcategories,
attachments and CAPTCHA and presses submit within the manual window. A successful
official response with a retrieval code is required for `done`. An observed POST
without a verifiable code is `unknown`; it is never retried. No login is required
by this workflow. Real-name infringement reporting is not part of this channel.

## Xiaohongshu Android path

Only an explicit app-only page message activates the Android path, before any web
submission. Normal app banners, missing content and uncertain submissions do not
trigger it. Configure an authorized device and its owning user:

```json
{
  "phone": { "adbPath": "adb", "serial": "YOUR_ANDROID_SERIAL", "userId": "YOUR_OPENCLAW_USER_ID" }
}
```

The phone must be unlocked and USB-authorized, with the intended account already
logged in. The executor validates the owner hash and shares the
`openclaw-phone-<serial sha256>.lock` protocol with `phone_read`. Its native ADB
client starts the checksum-verified bundled Android server when needed and calls
JSON-RPC directly. It does not install an APK, switch keyboards or execute Python.

A fresh clipboard marker and the note's copied share URL verify the note ID. The
previous clipboard is restored only if it has not changed independently. Share
links are resolved in the guarded borrowed browser and must reach a canonical XHS
note. Description text is read back exactly and limited to 400 UTF-16 units.
Controls use observed hierarchy bounds. Hidden, disabled, duplicate and foreign
controls fail closed. Only a new success indication after one submit attempt
confirms success. A lost ADB response after that attempt is `unknown`.

The native no-submit preflight uses only the already configured device and user:

```powershell
pnpm openclaw complaint-phone-preflight --user-id YOUR_OPENCLAW_USER_ID --url https://www.xiaohongshu.com/explore/0123456789abcdef01234567
```

It has no submit option. It checks the form using a fixed Chinese test reason,
captures local evidence, clears that reason and attempts to return to the note
while retaining the device lock. `PHONE_PREFLIGHT_CLEANUP_REQUIRED` requires
manual inspection; only `PHONE_PREFLIGHT_READY` signals a completed preflight.

## Records, results and recovery

Before browser acquisition, a local batch and `legal_complaint_task` audit row are
saved using `backend.db` or `WRITER_MYSQL_*`. An unconfirmed insert is not retried.
This path neither calls `/legal/save-complaint-job` nor publishes RabbitMQ work.
Audit rows use `jobId=0`, the current `uid` and `groupId=0`; they remain `Stop` until
all links have confirmed receipts, then become `Done`.

The initial result is `accepted=true`, `submitted=false` and a `batchId`. Query
`complaint_task_status({batchId})` for per-link outcomes:

- `done`: observed submission receipt; not platform acceptance or removal.
- `manual_required`: login, verification, materials, target or lock needs attention.
- `unknown`: a submission may have occurred; do not resubmit automatically.
- `not_submitted`: this link was not attempted.
- `failed`: execution stopped before a submission attempt.

Submission, screenshot upload and database recording are separate. A screenshot
or persistence failure does not erase a confirmed receipt. Progress sync failures
expose `TASK_RECORD_SYNC_FAILED`. Historical backend tasks remain queryable; set
`mode=backend` only to explicitly use the legacy backend task API.

No automatic retries or restart replay are installed. Cancellation is checked
between bounded browser actions; active work settles before releasing ownership.
Inspect interrupted profile/device locks and platform results before removing a
specific stale lock. Never resubmit an entire batch to recover only pending links.

Profiles and evidence are sensitive local state. Browser requests retain the
host's narrow Fake-IP exception and public-destination checks, including report
popup requests. This interception is not a substitute for deployment egress
controls, service-worker isolation or protection against DNS rebinding.

## Validation

```powershell
$env:OPENCLAW_TEST_SHARED_LOGIN_CHROME='C:/Program Files/Google/Chrome/Application/chrome.exe'
pnpm test extensions/leading-v2/src/complaint
```

Tests use isolated Chrome profiles, locally fulfilled platform HTML and mocked
ADB/device responses. They never send real reports. Android hardware and current
live-site behavior require separate operator validation.
