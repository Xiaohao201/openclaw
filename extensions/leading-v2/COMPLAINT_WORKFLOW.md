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
