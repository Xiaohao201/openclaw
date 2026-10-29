# Reliable Stop output deployment

This change spans OpenClaw and the sibling `ai-assistant` application. Local
verification does not deploy either application to the other Windows computer.

## Behavior

- Clicking Stop freezes the current turn locally and ignores its late stream events.
- The authenticated API records cancellation intent and a durable outbox entry in
  one MySQL transaction. A broker outage does not discard an accepted request.
- The outbox worker retries notifications. Active consumers also read the writer
  database every two seconds, so a control delivered to another instance is not
  the only cancellation path.
- Duplicate delivery within a consumer shares the original execution and abort
  handle. A restarted consumer checks persistent intent before starting work.
- The backend distinguishes cancellation requested from execution terminated.
  The UI reports unconfirmed termination after 30 seconds and continues checking
  automatically. This is a confirmation deadline, not a guarantee that every
  external system can be terminated within 30 seconds.
- Explicit Stop terminates the run's supervised exec processes, including
  background processes, and waits for their exit. It does not kill the Gateway
  or another user's processes. Existing Windows process-tree escalation is reused.
- Attachment downloads and preparation reads observe cancellation. Report
  planning/writing receives cancellation independently, and a running report
  child prevents the API from declaring its parent fully stopped.
- Report metadata updates preserve concurrent cancellation fields atomically.

## Deployment order

1. Back up the application database and current deployed artifacts.
2. Apply `ai-assistant/migrations/2026_10_29_lobster_chat_cancellations.sql` to the
   **writer database used by history_messages**. The API and outbox worker need
   SELECT, INSERT, and UPDATE access to the new table. Migration execution is
   separate from application startup and has not been performed by this change.
3. Deploy the modified OpenClaw source to `C:\openclaw` on the execution computer.
   Run `pnpm install` and `pnpm build`; gracefully stop the existing instance,
   then start it with `pnpm openclaw gateway`. Do not start a second Gateway over
   the old one. Include both rabbitmq-consumer and report-generator changes.
4. Deploy the modified ai-assistant source, run its normal installation/build
   commands, and restart its Node server. Include the new Nitro outbox plugin,
   utilities, API changes, composable, and ChatPanel change.
5. Confirm both deployments use the same history writer database and matching
   user/session identifiers. The control queue remains the chat queue plus
   `.control`; the publisher uses broker confirmations.

## Acceptance on the execution computer

Local regression coverage includes 159 OpenClaw test cases across the targeted
consumer, preparation, report, and owned-process suites, and 46 frontend/API
test cases. Tests exercise the real composable with HTTP/SSE boundaries mocked
and verify report cancellation against the runtime's actual run registry.
These tests do not substitute for broker/database fault injection or process-tree
verification on the deployment computer. No production database migration or
remote deployment was performed during local development.

Use a dedicated test account and harmless workloads. Observe the exact history
ID, cancellation receipt, terminal metadata, and owned process exit.

1. Stop during text streaming, then stop during attachment preparation. No late
   text should appear after the click.
2. Stop a harmless long-running background command. Verify its process and child
   processes disappear before the backend reports cancellation confirmed.
3. Interrupt the control broker connection, click Stop once, and restore the
   connection. The durable request must survive and complete automatically.
4. Deliver the same chat envelope twice while its first execution is active.
   Verify there is one local execution and Stop targets that execution.
5. Restart the consumer after cancellation is recorded but before execution.
   The queued task must not start a model run.
6. Stop during report planning/writing. Parent completion must not hide the
   report child, and report output must not revive the stopped UI.
7. Run two users concurrently; stopping one must not interrupt the other.
8. Refresh the page while termination is pending. Automatic status tracking
   must resume without requiring repeated Stop clicks.

## Limits and operational recovery

Network partitions, a stopped host, uninterruptible third-party tools, and
already-submitted external operations cannot be treated as confirmed termination.
Database report aggregation currently cooperates at phase boundaries; an active
server-side SQL statement is not forcibly killed by this implementation. A sent
email or committed external write is not rolled back by Stop.

The system retains pending status and retries instead of claiming success. If
the Gateway itself is blocked, inspect the owned task and process before taking
operator action; this change deliberately does not restart a shared Gateway as
a per-user cancellation mechanism. Persistently non-cooperative in-process tools
need a separately designed worker-process boundary before hard termination can
be promised for those tools.

For rollback, retain the additive outbox table and cancellation metadata. Revert
both application deployments together; reverting only the worker removes the
durable fallback and report-child confirmation behavior.
