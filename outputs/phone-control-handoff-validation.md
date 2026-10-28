# Phone control 交接补充与启用插件核对

日期：2026-10-28。目标分支：v3。

## 日志确认的启用插件

来源为用户提供的 `gateway ready (16 plugins: ...)` 日志。这是该次启动的已加载列表，不代表所有服务最终已就绪，也不是直接读取生产配置文件的结果。

| 插件              | 后台服务契约核对                              |
| ----------------- | --------------------------------------------- |
| acpx              | `acpx-runtime`，v2 execution                  |
| browser           | `browser-control`，v2 execution               |
| daily-risk-tips   | v1；工具工作由核心任务排空                    |
| device-pair       | `device-pair-notifier`，v1                    |
| feed-search       | v1；核心任务排空后关闭连接池                  |
| full-text-search  | 未注册独立后台服务                            |
| leading-v2        | v1；调度器、通知器及状态落盘                  |
| legal-check       | v1；兼容服务                                  |
| milvus            | v1；工具工作由核心任务排空                    |
| phone-control     | `phone-control-expiry`，本次补齐 v2 execution |
| phone-reader      | 未注册独立后台服务                            |
| rabbitmq-consumer | v1；消息入口排空                              |
| report-generator  | v1；监听器、轮询任务排空                      |
| risk-judge        | v1；工具工作由核心任务排空                    |
| talk-voice        | 未注册独立后台服务                            |
| wechat-group-push | 未注册独立后台服务                            |

以上检查基于 v3 的插件注册源码。未发现另一个完全缺失 handoff 的已注册服务；契约存在不等于生产依赖可用。RabbitMQ、数据库、ACP 等仍需实际配置和连接验证。

## 修复行为

`phone-control-expiry` 原先启动立即轮询，仅提供 start/stop，因此被受管服务预检拒绝。这不是 `--release` 参数问题。

现在初始化后保持待命，resume 立即检查到期授权，等待撤权配置及状态写入完成。该服务属于 execution 阶段，宿主先恢复这些服务再恢复消息入口。失败时受管恢复报错并停止轮询，不以成功掩盖撤权失败。

轮询使用单次执行和完成后安排下一次定时器。pause 停止新轮询，等待真实工作完成；超时不取消配置写入。stop 同样等待排空。普通非受管启动保留立即检查及失败后重试的行为。

没有改变 `/phone` 的管理员权限判断，没有新增宿主关闭或重启工具。本次没有解决原有手动授权命令与定时撤权同时修改配置的全部并发问题，也没有改变损坏授权状态文件的既有读取策略。

## 验证

- Phone control 两个测试文件共 12 项通过，包括真实插件注册、授权到期后恢复撤权、待命无写入、慢写入排空、超时不取消、重复恢复、失败重试及普通模式兼容。
- 新增 expiry service 的定向 V8 覆盖率：语句/行 100%，分支 95.83%，函数 100%；不代表整个插件覆盖率。
- 真实 Gateway 测试扩大为同时启用 ACP、browser、device-pair、phone-control。隔离配置使用模拟 ACP 子进程，不使用用户的 RabbitMQ、模型或通知凭据。
- `pnpm build`、`pnpm tsgo`、变更文件的 Oxfmt、type-aware Oxlint 和 `git diff --check` 通过；构建未出现 `INEFFECTIVE_DYNAMIC_IMPORT` 警告。
- 四插件真实进程测试通过：首次启动、替换为不同工作进程、排空停止，共约 290 秒。没有通过禁用 phone-control 绕过错误。

本次不宣称生产 16 插件组合已做完整端到端联调，不承诺零停顿或跨崩溃 exactly-once。
