# Local complaint runtime

## Local debug polling

`pnpm suheng:debug` defaults `OPENCLAW_LEADING_V2_BACKGROUND_POLLING` to `0` for
the child Gateway process. Leading V2 then starts neither the scheduled-task loop
nor the completion-notification polling loop, even if inherited configuration
enables notifications. Interactive tools, including manual status queries and
schedule management, remain available. Production configuration files are unchanged.

Set `OPENCLAW_LEADING_V2_BACKGROUND_POLLING=1` before starting the debug command
to explicitly enable background polling; `notify.enabled=false` still disables
completion notifications. Normal launches without this environment variable retain
their existing behavior. Rebuild with `pnpm build` after changing plugin code:
the debug command runs built artifacts and only builds automatically when they
are missing.

## Network policy

The host's explicit `browser.ssrfPolicy.allowRfc2544BenchmarkRange` setting is
passed to all complaint Python processes through an administrator-owned environment
variable. Isolated sessions, user-bound Chrome, login setup, and the anonymous 12377
browser all honor it. Only `198.18.0.0/15` is additionally allowed. Loopback, private
LANs, link-local addresses, and credentials in URLs remain blocked. The broad
`dangerouslyAllowPrivateNetwork` setting is deliberately not inherited. Agent tool
arguments cannot enable this exception. An existing operator-approved binding's
narrow exception remains supported.

## Login from OpenClaw

In a `rabbitmq-<userId>` chat, ordinary `browser` calls automatically prepare an
OpenClaw-managed profile for that user. Start with `status`, `start`, or `open`;
no manual binding or complaint confirmation is required just to open a URL. Omit
`profile` (or use the default `openclaw` alias) to select the user's own profile.
Existing administrator bindings continue to select their approved account.

The per-user profile and CDP port reservations are persisted in
`STATE_DIR/leading-v2-browser-profiles.json`. They are restored into the active
browser configuration after a debug restart, preserving profile directories and
login state. Corrupt bindings or conflicting profile/port assignments fail closed.

After `browser open`, subsequent page operations without a `targetId` use the
page observed in that conversation. They do not fall back to another conversation's
last active tab. Only a confirmed complaint acquires the recorded target and its
fresh page marker for the report executor; merely opening a page does not submit
a complaint. Account changes, expired selections, and a busy report browser
require the user to revisit the page before a new handoff.

Use `complaint_browser` in a `rabbitmq-<userId>` chat:

1. `action=status` reports that user's binding and active login session.
2. After the user's explicit authorization, `action=login`, `platform=weibo`
   (or another supported platform), and `confirmed=true` opens their own browser.
3. The user can log in on the execution machine. `action=screenshot` returns only
   that login window for QR scanning. CAPTCHA and other interactive steps must be
   completed by the user in that window.
4. After the user confirms completion, `action=finish, confirmed=true` saves the
   session and closes the task window. `action=cancel` closes it without saving an
   isolated session. For a bound Chrome, login/logout changes are immediately part
   of the existing profile; cancellation does not undo them.

The login window expires after ten minutes. Saving acknowledges session persistence,
not platform authentication, report submission, or acceptance. Subsequent reports
still check platform readiness. Old batches never resume or retry automatically.
There is one login/report execution lock per user. Other users cannot read or control
the session, and cannot supply a user ID or browser directory to the tool.

Unbound users need no manual directory setup: the tool creates an isolated session.
To reuse an existing operator Chrome, the administrator must explicitly bind that
user with `runner.py --bind-browser --existing-chrome --user-id USER_ID --state-dir
STATE_DIR`. This is not exposed as an arbitrary machine-profile selector to chat
users. Enable remote debugging in Chrome and approve its connection prompt. Do not
bind unrelated users to the same account. See `python/SHARED_BROWSER.md` for the
operator binding workflow. Network compatibility does not copy account credentials.

12377 remains a separate anonymous flow; it needs no `complaint_browser` login,
and the user still completes its CAPTCHA and final submission manually.
It is excluded from the direct-platform catalog. A failed login, browser handoff,
or evidence fetch must not prompt an unsolicited suggestion to use 12377 or switch
channels. Only an explicit user choice authorizes that separate flow.

Direct reporting excludes Tonghuashun, Xueqiu, and WeChat. They are omitted from
the capability catalog and rejected by both local and backend submission paths.
WeChat hosts must not fall through to the broader Tencent domain route. Historical
batch status remains queryable. The separately authorized 12377 manual channel is
not a direct platform reporting capability.

The plugin requires its `python/` runtime alongside the built plugin. The optional
`openclaw.build.runtimeAssets` array in `package.json` lists package-relative files
copied by the bundled metadata build step. This additive build contract accepts
only files inside the owning package and fails the build for missing files. Plugins
without this field keep their existing behavior. Add new Python runtime modules to
this list; do not include tests, bytecode caches, credentials, or browser profiles.

Install dependencies from `python/requirements.txt` using the configured Python
interpreter. Isolated login/report browsers and 12377 use bundled Chromium when
available, falling back to installed Chrome with a new temporary profile if the
browser package is missing or incomplete. This never attaches to the operator's
default Chrome profile. At least one of those browser installations is required.
The default runtime directory is `<plugin root>/python`. An explicit
`complaintExecution.runtimeDir` overrides that directory and must be absolute.

Before accepting a batch, the tool checks for `runner.py`. A missing runtime returns
`accepted=false`, `submitted=false`, and `RUNTIME_MISSING` without saving a batch.
This file check does not establish Python, browser, dependency, or login readiness;
execution results must still be queried with `complaint_task_status`.

User authorization does not establish the factual basis of a report. Preserve
per-link findings when a user requests a larger batch; do not replace uncertainty
or normal criticism with unsupported allegations. `linkJudgments` is an array of
objects, not a JSON-encoded string. Only a confirmed platform result permits saying
that a report was submitted. Never automatically retry uncertain submissions.
