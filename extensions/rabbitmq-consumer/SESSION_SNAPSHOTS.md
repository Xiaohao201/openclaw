# Conversation snapshots

New RabbitMQ chat runs save their Pi transcripts under the configured agent
sessions directory:

```text
agents/rabbitmq-<user_id>/sessions/<history_messages.session_id>/<history_messages.id>.jsonl
```

Each history row has a unique execution key ending in `:turn:<history_id>` and a
new runtime session ID. The conversation key points only to an immutable
`<id>.recovery.jsonl` or `<id>.completed.jsonl` checkpoint. New turns copy that
checkpoint byte for byte, preserving the previous prompt prefix without acquiring
the old execution's transcript lock.

Before launching a turn, the consumer publishes a recovery checkpoint containing
the previous context, the new user request, and an explicit note that execution
has not been confirmed. A canceled turn therefore retains its user's intent,
but unfinished tool calls and unconfirmed results are not treated as successful.
This is a pre-run checkpoint, not a snapshot of every intermediate tool result.
Unknown external outcomes must be checked before retrying an operation.

After successful execution, the consumer locks its own transcript, freezes a
completed copy, and advances the conversation only if that execution still owns
the conversation head. A canceled or superseded execution cannot replace a newer
head. Replaying an already prepared history row is rejected rather than risking
duplicate external operations. Existing transcript files are not deleted.

On cancellation, the consumer releases the conversation queue independently of
backend cleanup. Output dispatch checks the turn's cancellation signal; ordinary
response and completion writes also check durable cancellation intent in SQL.
Frontend filtering by history ID remains necessary for already dispatched events.
New tool calls from canceled or orphaned isolated executions are blocked. Writes
and edits are scoped to a per-turn output directory, and `exec` defaults to that
directory. These checks are not an OS sandbox: an already running shell command
or external service operation may continue and cannot be undone by Stop.

Deployment must first drain old executions and detached child callbacks before
switching consumers. Importing a legacy live transcript still requires its write
lock (one-second timeout); a failed migration prevents the new run from starting.
Subsequent isolated turns do not acquire that legacy lock. Deploy the matching
frontend change so clicking Stop immediately restores input while cancellation
confirmation and retries continue in the background.

Before appending a chat turn, the consumer resolves the snapshot's active Pi
branch and compaction boundary. If the latest enterprise skill envelope or custom
skill selection already contains the same instructions, the new message carries
a short activation reference instead of another full copy. The actual user task
is preserved, including any skill tags quoted inside it. Changed instructions or
selections are sent in full again.

This check uses the transcript rather than process memory, so it survives
restarts. A new session, a branch without the instructions, or compaction that
removed them causes a fresh full copy to be sent. If history cannot be read, the
consumer keeps the instructions and logs a warning. Existing duplicate copies
are not removed from older transcripts; this prevents further accumulation while
preserving the cached history prefix.

## Task-only intent rules

Before routing a new turn, the consumer builds a separate classification view
of the original task. It unwraps the producer's leading
`<enterprise-default-skill>…</enterprise-default-skill><user-task>…</user-task>`
envelope and, when `hasAttachment` is set, excludes the known ai-assistant
attachment and video-result blocks. Skill instructions and evidence remain in
the execution message. Existing transcripts are never rewritten.

Automatic skill selection, monitoring-project context and project matching,
attachment report detection, and workspace/Word/design guidance all use that
task-only view. Explicit skill and template selections keep their precedence.
A malformed enterprise envelope disables text-based matching for that turn
instead of guessing from skill prose; the complete message still reaches the
agent. This is a compatibility parser for the producer's known formats, not a
general parser for arbitrary quoted documents or natural-language negation.

Each evaluated rule emits a `[CHAT_INTENT]` JSON log with `historyId`, `source`,
`excluded`, `rule`, `matched`, and `reason`. For example, a real Word request
records `rule: "word"`, `matched: true`, `reason: "word-format"`; words found only
in an excluded skill or attachment do not trigger it. Logs contain reason codes
and context kinds, not user text, filenames, or evidence. These diagnostics are
server logs, not additions to the model prompt or `history_messages.metadata`.
