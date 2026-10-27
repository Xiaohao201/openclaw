# Scheduled task capacity and diagnostics

## 定时任务参数说明（运维参考）

以下是当前代码默认值，部署包含这些改动的版本后生效。这些保护参数目前由代码定义，
不是 `schedule_tasks` 表里的可编辑配置，也没有新增对应的环境变量或前端设置项。

| 参数                 | 当前值          | 具体含义                                                                 |
| -------------------- | --------------- | ------------------------------------------------------------------------ |
| 全局运行并发         | 8               | 单个调度进程最多同时执行 8 个定时任务，所有用户共用                      |
| 每用户运行并发       | 1               | 同一用户同时最多执行 1 个定时任务                                        |
| 全局等待队列         | 100             | 最多保留 100 次等待执行的任务，不包含正在运行的任务                      |
| 每用户等待队列       | 2               | 每个用户最多保留 2 次等待执行的任务，不包含其运行中的任务                |
| 同任务等待数量       | 1               | 同一任务最多保留 1 次待执行；再次触发时合并，不新增排队项                |
| 最大排队时间         | 10 分钟         | 从首次进入队列起算，重复触发合并不会重新计时；达到期限后在后续检查中跳过 |
| 单次模型任务执行期限 | 15 分钟         | 从该次任务向模型派发时起算，不包含前面的排队时间                         |
| 模型运行状态等待窗口 | 30 秒           | 等待任务结束，并检查超时、取消状态；不是调度扫描频率                     |
| 调度扫描间隔         | 60 秒           | 默认每分钟扫描到期计划；任务到点不保证在该秒立即启动                     |
| 连续失败停用阈值     | 5 次            | 实际执行连续失败达到 5 次后停用计划，成功执行会清零失败次数              |
| 执行事件保留量       | 最近 1,000 条   | 按事件计数，不是 1,000 个任务；一个任务可产生多条事件                    |
| 单条事件原因长度     | 最多 1,000 字符 | 事件中的原因文本会截断，详细上下文结合服务日志查看                       |

### 并发、排队和重复触发如何配合

例如 100 个不同用户的任务同时到期，最多先启动 8 个，其余排队等待。
同一用户即使创建多个计划，也只有 1 个可以运行，另有最多 2 个等待。
队列满时跳过本次触发，并记录全局容量不足或用户容量不足；不会无限增加等待项。

例如某任务每分钟触发一次，但一次执行需要 5 分钟：09:00 开始运行，09:01
可以保留一次等待执行，09:02、09:03 等后续触发合并到这一次等待中。
前一次结束后，等待项在满足并发条件时启动，不会补跑所有错过的分钟。
入队仍受全局和每用户队列上限约束；合并不会延长最初的 10 分钟等待期限。

运行数与排队数分开计算：上限为 8 个运行中加 100 个等待中。
过期、合并、容量不足不会增加 `fail_count`，本次触发被跳过后，计划仍可在下一周期触发。
`last_run_at` 记录实际派发时间；`next_run_at` 在本次触发被容量限制拒绝时也会向后推进。

### 单次执行超过 15 分钟如何处理

15 分钟限制针对 `agent_prompt` 的一次完整模型任务，包含其中的模型思考、工具调用
及等待过程，不是每次模型调用都重新获得 15 分钟，也不是所有定时任务共用 15 分钟。
它不是从创建计划开始算，也不包含等待队列中的时间。

达到期限后，请求取消该次执行，继续等待确认其已结束，然后才释放并发位置。
取消请求被接受不等于执行已经结束。检查可能滞后一个 30 秒等待窗口，
取消本身也可能需要时间，因此 15 分钟不是精确的强制终止时刻。
超时执行确认结束后按执行失败处理；它不会直接删除计划，但仍适用连续 5 次失败停用规则。

如果始终无法确认结束，该任务会持续占用位置并记录异常；8 个位置全部卡住时，
后续定时任务无法启动，排队任务仍会过期。当前没有额外的强制终止宽限期，
也没有自动杀死独立进程或容器的恢复机制。服务正常停止也需要等待已接收的执行结束。
已经发出的外部操作不能依靠取消请求保证撤回。

### 独立通道和生效范围

定时任务使用 `leading-v2-schedule-0` 至 `leading-v2-schedule-7` 共 8 个执行通道，
与即时聊天的 `main` 通道分开。这里隔离的是顶层执行容量，仍共享 CPU、内存、模型额度、
数据库连接和工具资源；它不是独立进程或容器隔离，也不能保证聊天完全不受资源竞争影响。
仅提交后台任务的动作，在提交完成后结束本地执行，其远端任务需要独立的并发和超时保护。

上述并发和排队限制仅在单个调度进程内生效，同一计划库只能由一个调度实例负责。
多个实例不会自动共用“全局 8 个”的限额，也没有分布式防重复执行锁。
等待队列保存在内存中，服务重启后不会恢复这些等待项。

### 执行记录及排查位置

最近 1,000 条事件保存在插件服务状态目录的 `leading-v2-schedule-executions.json`，
同时可在服务日志中搜索 `[LEADING_V2_SCHED]`。事件包含任务 ID、用户 ID、时间、状态
及适用时的原因；模型执行日志还包含对应的 run ID。

| 事件              | 含义                                                   | 是否增加失败次数 |
| ----------------- | ------------------------------------------------------ | ---------------- |
| `queued`          | 已进入等待队列                                         | 否               |
| `running`         | 已开始派发执行                                         | 否               |
| `completed`       | 执行成功                                               | 清零             |
| `failed`          | 执行失败，包括确认结束的执行超时或全部结果投递渠道拒绝 | 是               |
| `merged`          | 重复触发已合并到现有等待项                             | 否               |
| `queue_full`      | 全局等待队列已满，本次跳过                             | 否               |
| `user_queue_full` | 该用户等待队列已满，本次跳过                           | 否               |
| `queue_expired`   | 等待达到 10 分钟，本次跳过                             | 否               |
| `cancelled`       | 服务停止或等待项失效等原因取消                         | 否               |

一项任务可能产生“排队、运行、成功”三条事件，因此 1,000 条事件不等于 1,000 次执行。
事件文件可在重启后读取，超过上限会淘汰最旧事件；它不是永久审计记录。
这些状态尚未增加到前端展示中，也不需要修改数据库表结构。

### 参数维护位置

- `src/schedule/scheduler.ts`：`SCHEDULE_LIMITS` 定义并发、排队容量与排队期限；
  `MAX_FAILS` 定义失败停用阈值；`start()` 定义默认扫描间隔。
  每用户运行 1 个、同任务只保留 1 个等待项由调度逻辑保证。
- `src/schedule/actions/agent-prompt-action.ts`：`EXECUTION_TIMEOUT_MS` 定义 15 分钟执行期限，
  `WAIT_WINDOW_MS` 定义 30 秒等待窗口。内部依赖允许覆盖执行期限，但当前不是用户配置入口。
- `src/schedule/execution-journal.ts`：`KEEP_EVENTS` 定义事件保留数量。
- `index.ts`：连接调度器、事件文件以及运行取消接口。

并发 16、32 是后续压测候选值，不是自动扩容档位。调整前应观察任务完成耗时、聊天延迟、
内存、排队时间和模型错误率；增加并发不能保证吞吐按比例增长。

## Implementation reference

The leading-v2 scheduler admits work without waiting for the preceding user's model
run. Defaults are defined in `src/schedule/scheduler.ts`:

| Limit                                | Default                   |
| ------------------------------------ | ------------------------- |
| Running scheduled actions            | 8 per scheduler process   |
| Running actions per user             | 1                         |
| Waiting occurrences                  | 100 total, 2 per user     |
| Waiting occurrences of the same task | 1                         |
| Maximum queue age                    | 10 minutes                |
| Agent execution deadline             | 15 minutes after dispatch |

Due triggers for a queued task merge without refreshing its queue age. A running
task may have one waiting occurrence, subject to the queue limits. Missed intervals
are not replayed. Queue overflow, expiry, deletion, and shutdown cancellation do
not increment `fail_count`. Actual runner failures still increment it; five
consecutive failures disable a task. Successful runs clear the failure count.

`last_run_at` records actual dispatch, not admission. The next due time advances
even when an occurrence is rejected. Waiting tasks use the latest locally loaded
schedule; each scan refreshes the store after draining outstanding writes. Queued
work is memory-resident and is discarded on shutdown/restart; this is a monitoring
scheduler, not a durable queue for transactions that must run exactly once.

Agent runs use the eight stable lanes `leading-v2-schedule-0` through
`leading-v2-schedule-7`, rather than the interactive `main` lane. Each lane has one
execution position. This isolates top-level scheduling capacity, not CPU, memory,
provider quotas, database pools, or tools' independently spawned subagents.
Backend-submission actions hold their slot through submission, not until the remote
backend job finishes; remote services must enforce their own execution limits.

The runner polls settlement every 30 seconds. A pending wait timeout or failed wait
RPC retains capacity. At the execution deadline (or service shutdown), it requests
cancellation through the public agent harness and continues to retain its position
until the run's terminal state is confirmed. Cancellation acknowledgement alone
does not release capacity. If the runtime cannot confirm settlement, capacity and
graceful shutdown remain blocked, with diagnostic warnings; investigate the runtime
rather than starting replacement jobs. The deadline check can lag by one polling
window and cannot interrupt an already-dispatched external side effect.

## Deployment scope

Run exactly one scheduling owner against a schedule database. The admission limits
and reservations are in-process; they are not a distributed database lease. Do not
enable scheduling in multiple replicas or overlap old/new owners during a rollout.
Stop the old owner and let accepted runs settle before starting its replacement.
Deploying multiple schedulers safely requires a separate lease/fencing design.

No database migration is required. User-visible schedule rows keep the existing
schema. Frontend presentation of the new outcome categories is not changed here.

## Investigating outcomes

`[LEADING_V2_SCHED]` structured events include task ID, user ID, timestamp, outcome,
and a bounded reason where applicable. Recent events also persist independently of
MySQL in `leading-v2-schedule-executions.json` under the plugin service state directory.
The journal keeps the latest 1,000 events, survives restarts, and coalesces writes.
It is bounded operational diagnostics, not a complete audit trail. Protect it like
other service logs. Runner logs additionally correlate task IDs with model run IDs.

Outcomes: `queued`, `running`, `completed`, `failed`, `merged`, `queue_full`,
`user_queue_full`, `queue_expired`, and `cancelled`. A generated reply rejected by
every delivery transport is a failed run, not a successful delivery.

## Validation and rollout

Run `pnpm test extensions/leading-v2/src/schedule` before deployment. Tests exercise
bounded admission with 120 due tasks, per-user serialization, coalescing, expiration,
deleted tasks, shutdown draining, nonterminal wait timeouts, RPC outages, and confirmed
cancellation. They do not establish real Qwen throughput. Start at concurrency 8;
measure completion latency, interactive latency, resident memory, queue age, and
provider errors before trying 16 or 32 in a controlled load test.
