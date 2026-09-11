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
