# Direct local reporting

`complaint_submit` now defaults to a plugin-owned Python browser executor. It
does not call `/legal/save-complaint-job`, publish RabbitMQ messages, or write
complaint rows to MySQL. `complaint_task_status` reads local batches without an
API key. Historical backend batches and explicit numeric task IDs still use
the authenticated backend. Other leading-v2 tools retain their existing behavior.

## Install

Use Python 3.10 or newer on the OpenClaw host. From the repository root:

```powershell
python -m venv extensions/leading-v2/.venv
extensions/leading-v2/.venv/Scripts/python -m pip install -r extensions/leading-v2/python/requirements.txt
extensions/leading-v2/.venv/Scripts/python -m playwright install chromium
```

Set `plugins.entries.leading-v2.config.complaintExecution`:

```json
{
  "mode": "local",
  "python": "C:/deployment/openclaw/extensions/leading-v2/.venv/Scripts/python.exe",
  "headless": false,
  "timeoutMs": 900000
}
```

Use your actual interpreter path. `python` is an executable, not a shell command.
`runtimeDir` optionally points to an absolute directory containing the bundled
`runner.py` and sibling modules. By default it is the registered plugin's `python`
directory. No sibling checkout or original deployment configuration is required.

For a **dist-only repository deployment**, stage the plugin's Python assets after
each repository build (the generic TypeScript bundler does not copy Python):

```powershell
node extensions/leading-v2/stage-python.mjs dist/extensions/leading-v2
```

Alternatively deploy the source plugin directory, or set `runtimeDir` to its
installed Python directory. The staging command copies only Python/text assets;
it does not copy virtual environments, browser profiles, or credentials.

## Accounts and execution

The trusted `rabbitmq-<userId>` agent identity selects the user. A caller cannot
supply another user ID to the tool. Batches and browser sessions live under the
OpenClaw state directory, partitioned by SHA-256 of that user ID. Session cookies
from the original program are not shared or automatically imported.

Initialize each user's platform login on the execution host (replace all values
with the real state directory, user ID, and installed Python executable):

```powershell
python extensions/leading-v2/python/runner.py --login --platform weibo --user-id 123 --state-dir C:/openclaw-state
```

Complete login in the browser and press Enter in the terminal to save. This login
command never submits a report. Headed execution requires an interactive desktop;
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

The initial Android adapter requires accessible controls named `更多`, `复制链接`,
`举报`, the exact configured category/subcategory, a single description field,
and `提交`. It verifies the current note using a freshly copied share URL, expands
public XHS short links, and compares note IDs. It never trusts a launch intent as
proof of note identity. It requires working `cmd clipboard set/get` commands and
an already enabled `com.android.adbkeyboard/.AdbIME` input method for Chinese input.
The executor does not install keyboards, change the default input method, bypass
verification, or guess screen coordinates. Unsupported phones return
`manual_required`. In particular, devices reporting `No shell command
implementation` for the clipboard command need a different Android adapter before
automatic submission is possible; installing ADBKeyboard alone is insufficient.

Use actual platform category text in `categories`; there is no fuzzy mobile
category selection. The typed reason is read back before clicking submit. Only a
new exact `举报成功` or `提交成功` UI indication after that click yields `done`.
Disconnects/timeouts after the click return `unknown`, never a retry. The current
adapter's automated tests use fake UI/ADB responses, not a live platform receipt.

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
