# Complaint execution architecture

The `leading-v2` plugin owns complaint tools and execution. It is not a separate
service. The browser plugin remains the owner of Chrome processes and profiles.

## Responsibilities

| Layer                              | Responsibility                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| Existing tool factories            | Validate authorized targets, reasons and trusted user/session identity                          |
| Existing local batch orchestration | Persist before execution, serialize the batch, expose status and cancellation                   |
| `executor/router.ts`               | Select exactly one engine for each platform; never retry through another engine                 |
| `executor/native.ts`               | Execute stages and distinguish pre-submit failure, confirmed submission and unknown outcome     |
| `browser/session.runtime.ts`       | Attach to the exact handed-off target, hold a profile lock and release the connection           |
| `platforms/douyin.ts`              | Operate Douyin page controls, check login, choose an unambiguous category and observe a receipt |
| Existing evidence/result modules   | Upload screenshots and persist execution results independently of submission                    |

The native path is:

```text
complaint_submit -> durable batch/task -> session handoff
                -> native executor -> platform adapter -> existing browser tab
                -> observed outcome -> evidence/result persistence
```

No native component launches Chrome, creates a replacement profile, adopts a tab
by URL, or restarts a browser on a page timeout. The handoff marker and CDP target
ID must both match. The profile lock is shared with the legacy Python executor.
Disconnecting the native client preserves the original browser and target tab.

## Native runtime

All 16 direct platforms use TypeScript drivers. `platforms/web-contracts.ts` owns
platform selectors; `platforms/targets.ts` checks content and report-page identity.
Douyin has its own driver, including canonicalization of jingxuan links. Login,
batch execution, screenshots and database writes remain inside the existing
`leading-v2` plugin. No Python executable or HTTP bridge service is required.

`complaint_browser` leases the same target for interactive login. Finish, cancel,
shutdown and ten-minute expiry release the lease without closing the borrowed tab.
Finish records the user's confirmation, not proof of authentication or submission.

12377 uses the same borrowed tab, fills the anonymous form and waits for the user
to complete CAPTCHA and submit. Only a correlated official POST response containing
a valid retrieval code confirms success. The command never solves CAPTCHA or
presses the final submit button for this channel.

XHS switches to the configured Android device only after observing an explicit
app-only content gate, before web submission. The native phone path holds the same
per-device lock as phone reading, validates the bound user, resolves the fresh
copied share URL and checks its note ID before preparing the report. It uses ADB
and the bundled, SHA-256-verified UIAutomator JAR. Clipboard contents are restored
when unchanged by another actor. No Python, APK or replacement keyboard is installed.
`complaint-phone-preflight` exercises this flow with submission disabled at the
device boundary and clears the test description before returning to the note.

Supply an approved category. Drivers accept exact labels or unambiguous curated
aliases. They do not invent allegations, use LLM category matching, silently
truncate reasons or dynamically generate replacement execution code. Ambiguity,
login, identity-material requirements and CAPTCHA require operator action.

Legacy Python sources are retained only as migration references and offline
behavior specifications. They are not runtime assets and no router invokes them.
Deprecated python/runtimeDir/headless configuration inputs remain accepted and
ignored for deployment compatibility. `check-runtime.mjs` verifies native assets;
the deployment script checks both staged output trees before restart.

## Outcome and lifetime rules

- Before the submit attempt, interruption means not submitted.
- Once the submit call starts, an exception or missing receipt means unknown.
- Only a positive platform success marker means submitted; it does not mean accepted.
- Screenshot, cleanup or database failure must not erase a confirmed submission.
- Persistence may be retried separately; submission must never be retried automatically.
- Cancellation is checked between stages. In-flight browser actions settle under
  their bounded operation timeouts before the lease is released; the total timeout
  is a stage-boundary deadline, not a promise race that leaves work running.
- Browser request interception retains the public-destination/Fake-IP policy.
  It is not a replacement for deployment egress controls or protection against
  browser service workers and DNS rebinding.

## Verification

Unit tests cover routing, interruption, login, receipts and evidence failure.
The opt-in `native.browser.test.ts` uses an isolated Chrome profile and locally
fulfilled HTML only; it checks a single submission, screenshots, exclusive access
and preservation of the borrowed browser. It also checks subsequent native login,
screenshot capture and reacquisition of the same tab after login finishes.
Additional isolated Chrome fixtures cover the other platform forms, popup/iframe
variants and the official anonymous-report receipt flow. Phone tests simulate
ADB/RPC, XML UI hierarchies, ownership, clipboard restoration, exact Unicode input,
preflight cleanup, receipt loss and concurrent locking. No test submits a real
report. Live platform DOM and an actual bound Android device still require
deployment verification; offline tests cannot certify those external environments.
