# Direct local reporting

`complaint_submit` defaults to a plugin-owned Python browser executor. Before
checking Python or acquiring the browser, it saves a local batch and an audit row
in `legal_complaint_task`, using `backend.db` or the existing `WRITER_MYSQL_*`
environment variables. Missing database configuration or an unconfirmed insert
stops execution. Browser and runtime failures retain their task ID, batch ID,
and failure reason. A potentially committed insert is never retried automatically.

This audit path does not call `/legal/save-complaint-job` or publish RabbitMQ
messages. It does not create legacy `legal_complaint` queue/detail rows. Audit
tasks use `jobId=0`, the current user's `uid`, and `groupId=0` (owner visibility).
They remain `Stop` so the legacy backend cannot treat them as pending work;
the reason includes the batch ID and local state counts. Only when every link
has an observed submission receipt does the task become `Done`. A receipt does
not mean the platform accepted the allegation or removed content.

`complaint_task_status` reads local batches and their numeric task IDs without an
API key. Historical backend tasks still use the authenticated backend. If database
progress synchronization fails, the local status exposes `TASK_RECORD_SYNC_FAILED`;
check the batch before recovery, and do not resubmit an uncertain report.

## Install

Use Python 3.10 or newer on the OpenClaw host. From the repository root:

```powershell
python extensions/leading-v2/python/setup_runtime.py
```

Set `plugins.entries.leading-v2.config.complaintExecution`:

```json
{
  "mode": "local",
  "headless": false,
  "timeoutMs": 900000
}
```

The setup command creates the plugin's `.venv`, installs the pinned requirements,
and checks all executor imports plus the Playwright driver. It does not install or
launch a second browser: conversation handoffs use OpenClaw's running Chrome.
When `python` is omitted, login and reporting both select `.venv` beside the actual
runtime directory; without that environment they retain the legacy PATH default.
An explicit `python` executable always takes precedence. Install requirements in
that interpreter separately and run the check below if you manage it yourself.

`python` is an executable, not a shell command.
`runtimeDir` optionally points to an absolute directory containing the bundled
`runner.py` and sibling modules. By default it is the registered plugin's `python`
directory. No sibling checkout or original deployment configuration is required.

For a **dist-only repository deployment**, stage the plugin's Python assets after
each repository build (the generic TypeScript bundler does not copy Python):

```powershell
node extensions/leading-v2/stage-python.mjs dist/extensions/leading-v2
python extensions/leading-v2/python/setup_runtime.py --runtime-dir dist/extensions/leading-v2/python
```

Alternatively deploy the source plugin directory, or set `runtimeDir` to its
installed Python directory. The staging command copies only Python/text assets;
it does not copy virtual environments, browser profiles, or credentials.
For `dist-runtime` deployments, use the same two commands with `dist-runtime`
instead of `dist`. The Windows `deploy-server.cmd` prepares all available source,
`dist`, and `dist-runtime` plugin trees and stops before restarting the Gateway if
installation or verification fails.

Diagnose the exact interpreter used by the deployed plugin, without opening a
platform page or submitting a report:

```powershell
extensions/leading-v2/.venv/Scripts/python extensions/leading-v2/python/runner.py --check-runtime
```

Substitute the deployed runtime and interpreter paths. Missing modules now return
`RUNTIME_DEPENDENCY_MISSING` with the module name and interpreter. Other startup
errors identify their phase and exception type without exposing exception payloads.
A generic runtime failure does not establish that Chrome needs installation.

## Accounts and execution

The trusted `rabbitmq-<userId>` agent identity selects the user. A caller cannot
supply another user ID to the tool. Batches and browser sessions live under the
OpenClaw state directory, partitioned by SHA-256 of that user ID. Session cookies
from the original program are not shared or automatically imported.

In the current OpenClaw conversation, use `browser open` to open the platform.
This prepares that user's OpenClaw profile and records the conversation's tab.
`complaint_browser(action=login, platform=weibo, confirmed=true)` then reuses the
same browser, login state, and tab after explicit login authorization. Already
authenticated profiles need no separate login. Missing or stale handoffs fail
without launching a replacement browser. See `RUNTIME.md` for the login lifecycle.

After login, `finish` or `cancel` leaves the browser and tab open. Refresh the
page with `browser snapshot`, using the returned `browserTargetId` as `targetId`,
before continuing. Login setup never submits a report. Headed execution requires an interactive desktop;
a background service account may need a separate desktop host. The actual logged-in
platform account determines the reporting identity; `role` cannot switch accounts.

The tool requires `basisSource=AgentJudgment`, explicit `confirmed=true`,
`subjectScope`, `judgment`, and `links`. Multiple links require exactly one
`linkJudgments` entry per link. Legacy implicit “latest detection job” submission
is not supported in local mode: provide the specific links and verified reasons.

`complaint_taxonomy` returns this installed executor's platforms and URL routing.
It does not fabricate a backend taxonomy version. Optional `categories` supplies
real platform category/subcategory text per link; otherwise the browser matches
the individual reason to visible options. Existing backend `classifications`
must not be passed in local mode. Ordinary platform reasons retain the source
program's 190-character limit, applied deterministically without external AI calls.

For the 12377 anonymous channel, explicitly pass
`report12377: {category: "rumor", websiteName: "Example"}`. Supported categories
are politics, terrorism, fraud, pornography, vulgarity, gambling, and rumor.
Each URL/reason is limited to 500 UTF-16 units. The user must review the official
form, complete verification, and perform final submission in the execution-host
browser within ten minutes. Only an official retrieval code confirms submission;
it is returned in the user-owned batch result. No login profile is loaded for this
anonymous flow. Infringement categories requiring identity are not supported here.

## Results and recovery

### XHS app-only Android fallback

The XHS executor checks for explicit app-only page messages before desktop login
and again before clicking any web report control. A normal app banner, missing
page, timeout, or uncertain web submission does not trigger a second submission.
Short links must resolve in the guarded browser to a canonical XHS note URL.

Administrators can bind one reporting phone to one OpenClaw user in
`complaintExecution.phone` (omit this block to disable phone execution):

```json
{
  "adbPath": "adb",
  "serial": "YOUR_ANDROID_SERIAL",
  "userId": "YOUR_OPENCLAW_USER_ID"
}
```

Use the account currently logged into XHS on that phone. This does not switch
accounts or import desktop cookies. The phone must be USB-authorized, unlocked,
and dedicated to the bound user. The executor verifies the user session hash
before interacting with it and shares the `openclaw-phone-<serial sha256>.lock`
exclusion protocol with `phone_read`. Execution has a 110-second device deadline;
interrupted locks require inspection, not automatic resubmission.

Install the optional Android dependency in the same Python environment as the executor:

```powershell
extensions/leading-v2/.venv/Scripts/python -m pip install -r extensions/leading-v2/python/requirements-phone.txt
```

The Android adapter supports the Android 9 / XHS 9.49 layout: the unlabelled
`moreOperateIV` share button, horizontal scrolling to `举报`, the ordinary-report
group `对他人造成困扰或危害`, category selection, and expansion of
`补充更多举报信息`. It merges labels on a button and its descendants while rejecting
ambiguous sibling controls, disabled buttons, and offscreen bounds. The exact legacy
category `不实信息` maps to the visible `不实信息、谣言`; other categories remain exact.
Identity/material-dependent infringement flows still require manual handling.

The pinned `uiautomator2` dependency starts its bundled Android server jar for
clipboard and Unicode text operations. No keyboard APK is installed and the
default input method is unchanged. It verifies a fresh clipboard marker before
copying the share URL, compares note IDs, and restores the previous clipboard.
It never trusts a launch intent as proof of identity. Chinese descriptions are
read back exactly and limited to 400 UTF-16 units. UI gestures use observed control
bounds, not device-specific coordinates. Unsupported states return `manual_required`.

Short-link redirects are restricted to XHS domains and pinned to validated public
IP addresses with TLS hostname verification. When the host resolver returns only
the `198.18.0.0/15` Fake-IP range, the adapter queries Cloudflare's fixed HTTPS DNS
endpoint for the public hostname (never the note URL or its tokens), then validates
and pins the returned public address. Other private DNS answers are rejected.
The general browser network guard is unchanged.

Use actual platform category text in `categories`; there is no fuzzy mobile
category selection. The typed reason is read back before clicking submit. Only a
new exact `举报成功` or `提交成功` UI indication after that click yields `done`.
Disconnects/timeouts after the click return `unknown`, never a retry. The current
adapter's automated tests use fake UI/ADB responses, not a live platform receipt.

For a repeatable **no-submit** test on a connected, unlocked phone, use the dedicated
preflight command with the bound user ID and a specific note URL:

```powershell
extensions/leading-v2/.venv/Scripts/python extensions/leading-v2/python/xhs_phone_preflight.py --serial YOUR_ANDROID_SERIAL --user-id YOUR_OPENCLAW_USER_ID --url https://www.xiaohongshu.com/discovery/item/0123456789abcdef01234567 --output-dir C:/openclaw-preflight
```

This entry point has no submit option. It uses a fixed Chinese test description,
verifies the enabled submit control, returns `not_submitted` with
`PHONE_PREFLIGHT_READY`, and saves `before-submit.png` plus `result.json`. It then
clears its test description and returns to the note while holding the shared phone
lock. Check the recorded `cleanup` result; interrupted or unverified cleanup requires
manual inspection. These artifacts are local and may contain account/content details.
The normal executor's confirmed submission behavior is unchanged.

The initial response returns `accepted=true`, `submitted=false`, and `batchId`.
This means local acceptance only. Query `complaint_task_status({batchId})` for
every link, or `listBatches=true` to recover the current user's batch IDs.

- `done`: observed platform success indication (or 12377 retrieval code).
- `manual_required`: login/verification/materials/session lock need attention.
- `unknown`: no verifiable result, timeout, interruption, or lost checkpoint.
- `not_submitted`: remaining links were not attempted.
- `failed`: a failure known to occur before the browser submission flow started.

No automatic retries or restart replay are installed. Unknown/manual results stop
remaining links. Shutdown aborts active subprocesses; status remains conservative.
A process killed during execution may leave browser processes and `execution.lock`
in the user's session directory. An administrator must check the process and
platform result before closing leftover browsers and removing that exact lock.
Do not remove a lock while its browser is running. Do not resubmit an entire batch
to recover only its unattempted links. Completed submission does not mean platform
acceptance, removal, or agreement; this executor does not perform takedown rechecks.

Screenshots and browser profiles remain local to the user's state directory.
They are sensitive: retain normal host access controls and an appropriate retention
policy. The browser blocks non-public network destinations and disables service
workers; use deployment-level egress controls against DNS rebinding as well.

To explicitly keep creating legacy backend tasks, set `mode` to `backend`.

## Source and validation

Browser flow modules were adapted from the supplied `auto-reporting-function`
program. Deployment credentials, MySQL, Redis, RabbitMQ, OSS, email fallback,
SMS, executable binaries, and the multiprocessing consumer were not imported.
AI classification/healing is disabled by default. Browser success tracking is
explicit because the original handlers sometimes returned true without observing
a success indicator. Source selectors still require platform-specific maintenance.

```powershell
pnpm test extensions/leading-v2/src/complaint extensions/leading-v2/src/ai/ai-tools.test.ts
python -m unittest discover -s extensions/leading-v2/python -p "test_*.py"
```

Tests use fake browser managers and an actual child-process fixture. They do not
submit real reports or prove that every live platform's current selectors work.
