# Conversation snapshots

New RabbitMQ chat runs save their Pi transcripts under the configured agent
sessions directory:

```text
agents/rabbitmq-<user_id>/sessions/<history_messages.session_id>/<history_messages.id>.jsonl
```

Before each run, the consumer copies the active transcript byte for byte into the
new row's file, then updates `sessions.json` to select it. The run appends its user,
assistant, and tool entries through OpenClaw's normal session machinery. Each
completed file therefore contains the conversation through that turn and can be
opened independently by Pi's SessionManager. Internal session and entry IDs stay
unchanged to preserve parent links and the existing context prefix.

Existing transcripts are not renamed, moved, or deleted. When an existing
conversation continues, its old transcript supplies the initial context for the
first new snapshot. Later turns leave earlier snapshots unchanged. A retry may
continue its currently selected file, but cannot overwrite an older snapshot.

The consumer prepares snapshots between serialized chat turns. It verifies that
the database record belongs to the requested user and session, rejects unsafe
directory names and linked transcript files, and locks the source while copying.
A preparation failure prevents the new agent run from starting.

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
