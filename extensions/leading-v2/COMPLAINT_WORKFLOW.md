# Complaint documents and background reports

For a single-link infringement assessment and complaint document, Suheng should
read the selected skill/template, obtain the target's actual text and requested
screenshots, assess the evidence, then create and verify the requested file with
the available document tools. Other articles on the same topic do not establish
what the target article says. Missing evidence must be identified explicitly.
Creating a document does not authorize submitting a complaint externally.

For direct `complaint_submit` batches, provide `linkJudgments` with exactly one
`{ link, judgment }` entry per URL (20–6000 characters per judgment). Each reason
must refer only to that URL's evidence and the user's stated grounds. Keep
unverified claims distinct from established facts; an AI label or missing source
alone does not establish falsehood. The top-level `judgment` is a batch summary.
Single-link calls may continue to use the top-level `judgment` alone.

The current backend takes one task-level judgment. The plugin therefore creates
one task per link, sending only its own reason and classification. It validates
all reasons and obtains missing classifications before any submission. Explicit
`role` identifies the reporter; `subjectScope` identifies the affected subject
and must not override a personal reporter's selected identity.

Batch results list `submittedLinks`. On a backend rejection, they also identify
`failedLinks` and the remaining `pendingLinks`; a transport exception instead
returns `unknownLinks`, which must be checked before retrying. Do not resubmit the
whole batch or describe partial submission as complete. Submission confirms only
backend acceptance, not platform acceptance or removal. Legacy detection-based
submissions retain their existing backend behavior.

## Report submission status

`complaint_submit` returning `success=true`, `submitted=true`, or `submittedLinks`
confirms only that the report service accepted the task. Tell the user:
“举报任务已提交至举报服务，是否已提交到目标平台尚待状态查询确认。”
Do not shorten this to “举报提交成功” or claim submission to the target platform.
This applies to both direct-judgment and detection-based submissions, including
the accepted portion of a partially failed batch.

When the user asks about progress or platform submission needs confirmation:

1. Keep the `batchId` and per-link `taskRefs` returned by `complaint_submit`, including
   partial failures. Call `complaint_task_status({ batchId })` to query every link
   in that batch using its saved task ID. A 100-link batch is not limited by the
   task-list page size. Queries use at most four concurrent backend requests.
2. If the batch ID is missing from conversation history, use
   `complaint_task_status({ listBatches: true, page: 1, size: 20 })` to list the
   current user's persisted batches, then match links and creation time. Do not
   automatically select the newest batch. Historical tasks created before batch
   tracking can still be found through the legacy task list and `taskId` detail
   query, but ambiguous matches must not be presented as this batch's results.
3. A normalized `done` state (`Done` submission status) confirms submission to the
   target platform, not platform acceptance, agreement with the report, or action.
   Pending/running, failed/stopped, and unknown states must not be described as
   successful platform submissions. An empty result does not confirm execution.
4. Only `offline=true` confirms that the link was detected as removed or invalid.
   Keep this separate from submission status. Query `success=true` only means the
   status request succeeded.

Avoid tight polling and do not promise automatic progress notifications without
actually arranging them.

Batch records are stored under the runtime state directory in
`leading-v2-complaint-batches/<hashed-user-id>/<batch-id>.json`. Each invocation
creates a separate UUID, so repeated URLs and concurrent users do not share a
latest-task slot. Records survive process restarts on the same persistent state
volume; multiple hosts need the same state volume or user affinity. The batch
lookup validates the trusted current user before making backend requests and
still authenticates every request using that user's API key. This local ownership
check does not replace authorization in backend task-detail endpoints.

Each request is checkpointed before and after submission. An interrupted request
remains uncertain; pending requests that were never attempted are reported
separately. Missing task IDs from an older backend, missing/ambiguous detail rows,
and failed status queries are explicitly unknown rather than guessed from recent
tasks. A failed initial checkpoint prevents submission; later storage failures
stop the remaining requests and return available task references for recovery.
Batch summaries separate submitted, processing, failed, stopped, unknown, and
not-submitted links; the offline count is an independent observation, not another
submission outcome. No automatic retries or completion notifications are installed.

Create opinion reports and response documents from the available evidence using
the selected skill/template and file-generation tools. The legacy backend opinion
analysis, content generation, report export, and download tools have been retired.
An opinion report is not a content-detection job and cannot be passed to the legacy
backend letter generator as a detection result.

Task references are carried in tool results and conversation history:

- `job_list` exposes `jobId`, link, label, and status for selecting the relevant
  content-detection job. Do not select an unrelated job merely because it is new.
- `letter_generate` requires this explicit `jobId`, fetches that exact job through
  the authenticated backend, and requires completed detection with violation
  findings. It returns the same `jobId` for `letter_fetch`.
- `letter_fetch` also requires `jobId`. Empty document content does not establish
  that generation is still running.

Pending tasks must not force unrelated evidence gathering or material preparation
to stop. Avoid tight status polling. A completed result may be used immediately for
authorized follow-up work; failures must not be reported as completed analysis.
These tools do not install completion callbacks or scheduled wakeups. Do not promise
automatic continuation or notifications without actually arranging them.

Older conversations that lack task references can recover them from the matching
task list. Do not silently reuse account-wide last-task state. No database migration
or new backend endpoint is required for this workflow change.
