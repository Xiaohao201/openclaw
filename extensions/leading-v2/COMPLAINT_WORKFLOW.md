# Complaint documents and background reports

For a single-link infringement assessment and complaint document, Suheng should
read the selected skill/template, obtain the target's actual text and requested
screenshots, assess the evidence, then create and verify the requested file with
the available document tools. Other articles on the same topic do not establish
what the target article says. Missing evidence must be identified explicitly.
Creating a document does not authorize submitting a complaint externally.

`opinion_analyze` remains available for background reports and batch analysis.
Its `RiskEvaluation` result is an opinion report, not a content-detection job.
It cannot be passed to the legacy backend letter generator as a detection result.

Task references are carried in tool results and conversation history:

- `opinion_analyze`, `opinion_report_export`, and `sheet_report_create` return
  `slug`. Pass that same value to `opinion_download_status`.
- `opinion_download_list` exposes `slug` for recovering a selected historical
  task. Status lookup does not fall back to the account's newest task; the current
  lookup searches the latest 50 downloads and reports an unknown result honestly.
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
