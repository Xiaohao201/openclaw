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
passed to the native TypeScript browser lease through host configuration.
User-bound Chrome, login setup, report popups and the anonymous 12377
flow all honor it. Only `198.18.0.0/15` is additionally allowed. Loopback, private
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
last active tab. Both confirmed login setup and complaint execution acquire the
recorded target and its fresh page marker. They attach to the same running browser,
profile, and tab used by OpenClaw; merely opening a page does not submit
a complaint. Account changes, expired selections, and a busy browser
require the user to revisit the page before a new handoff.

Use `complaint_browser` in a `rabbitmq-<userId>` chat:

1. `action=status` reports that user's binding and active login session.
2. First use `browser open` to open the platform page in the current conversation,
   or `browser snapshot` to refresh its existing page. After the user's explicit
   authorization, `action=login`, `platform=weibo` (or another supported platform),
   and `confirmed=true` reuses that exact tab. Login setup never starts a separate
   browser. A missing page, disconnected browser, or changed binding stops setup.
3. The user can log in on the execution machine. `action=screenshot` returns only
   that login tab for QR scanning. CAPTCHA and other interactive steps must be
   completed by the user in that tab.
4. After the user confirms completion, `action=finish, confirmed=true` acknowledges
   the session. `action=cancel` ends setup. Both keep the original browser and tab
   open. Login/logout changes belong to the shared profile immediately; cancellation
   does not undo them, and no cookies are copied to a separate session.
5. Use the returned `browserTargetId` as `targetId` in `browser snapshot` to refresh
   the current conversation's page before further browser operations or reporting.

The login workflow expires after ten minutes, leaving the original tab open.
Saving acknowledges session persistence,
not platform authentication, report submission, or acceptance. Subsequent reports
still check platform readiness. Old batches never resume or retry automatically.
There is one login/report execution lock per user. Other users cannot read or control
the session, and cannot supply a user ID or browser directory to the tool.
Other conversations also cannot view or finish the borrowed login tab.

Unbound users need no manual directory setup: ordinary `browser` calls prepare
their OpenClaw profile, which login setup and reporting both reuse.
Existing administrator-created Chrome bindings remain supported. They are not
exposed as an arbitrary machine-profile selector to chat users. Enable remote
debugging in Chrome and approve its connection prompt. Do not bind unrelated users
to the same account. New conversations use OpenClaw's managed profile workflow.
Network compatibility does not copy account credentials.

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

All enabled platforms execute in TypeScript. The `openclaw.build.runtimeAssets`
manifest stages only the Android server and its notices; no Python assets or
virtual environment are needed. Legacy interpreter/runtime/headless settings are
accepted and ignored for compatibility. See `LOCAL_REPORTING.md` for setup.

Every browser path, including 12377, requires a current conversation handoff.
There is no replacement browser or alternate engine after failure. Batches and
audit rows are persisted before acquisition; failed acquisition retains the IDs.
Execution results must still be queried with `complaint_task_status`.

User authorization does not establish the factual basis of a report. Preserve
per-link findings when a user requests a larger batch; do not replace uncertainty
or normal criticism with unsupported allegations. `linkJudgments` is an array of
objects, not a JSON-encoded string. Only a confirmed platform result permits saying
that a report was submitted. Never automatically retry uncertain submissions.
