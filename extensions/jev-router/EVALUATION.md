# Initial JEV routing smoke evaluation

Date: September 24, 2026. Model: `typesafe/jev-1.13` via OpenRouter Decisions.
Input: the 16 synthetic bilingual cases in `eval/seed.json`. Exactly one live
request per case, no retries; timeout 2000 ms, confidence threshold 0.8,
candidate retention threshold 0.2. No real conversation data was submitted.

| Measurement                                    | Observed result |
| ---------------------------------------------- | --------------- |
| Route labels matching the authored expectation | 15/16 (93.75%)  |
| Fallbacks                                      | 7/16 (43.75%)   |
| Required tools retained, including fallbacks   | 9/9             |
| Required tools retained on non-abstained cases | 7/7             |
| Candidate count reduction across all cases     | 43.75%          |
| Decision p50                                   | 458 ms          |
| Decision p95                                   | 1504 ms         |
| Transport/response-validation failures         | 0               |

Six abstentions were expected: write, send, execute, missing context, unknown
local path, and a requested capability absent from the candidate pool. One
additional abstention occurred on `read-and-search`, due to low confidence. Its
original candidate pool was preserved. None of the measured cases lost a
required tool. Thresholds were not tuned after this run.

This is an authored smoke set, not a held-out production benchmark. Candidate
reduction includes direct-answer cases and must not be equated with token-cost
savings. The test measures the decision stage; it does not run the proposed
tools, compare a main-model baseline, measure full task success, or report billed
cost. Latencies include the local network path and may not generalize.

The appropriate next step is a larger independently labeled held-out evaluation
and a complete-task baseline comparison. The evidence does not yet justify a
generic tool-selection interface or hard filtering of the live tool set.
