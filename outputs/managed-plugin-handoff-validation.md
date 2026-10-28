# 三个插件交接改造验证记录

日期：2026-10-28。交付分支：v3。

## 实现范围

- `acpx-runtime`：待命准入、探测就绪、执行流真实完成计数、超时延期、保留持久会话。
- `browser-control`：默认 HTTP 服务和可选进程内服务均接入执行阶段；路由计数不随客户端断开提前释放；受管清理失败向上传递。
- `device-pair-notifier`：待命不轮询，单次轮询互斥，暂停等待发送及落盘，订阅命令和轮询共用状态事务，原子替换状态文件。
- 宿主：新增兼容的 handoff v2 契约，入口排空后等待核心空闲，再关闭执行能力；恢复时先恢复执行能力；新 SDK 入口为 `openclaw/plugin-sdk/service-runtime`。
- 缺少契约、探测失败和初始化失败不能通过 readiness；错误包含服务标识和原因。
- 同步修复 Windows 测试中的路径分隔符假设、Fetch 保留端口选择与过短的本地网络测试超时；未降低业务断言。

## 自动化验证

范围测试命令：

```powershell
pnpm test src/plugins/service-work.test.ts src/plugins/services.test.ts src/plugins/lazy-service-module.test.ts src/gateway/lifecycle extensions/acpx extensions/browser extensions/device-pair
```

结果：五个测试配置共 783 项通过，12 项按现有条件跳过。跳过项包括需显式启用的真实进程 smoke；该 smoke 另行运行。覆盖待命、分阶段暂停/恢复、嵌套工作、排空预算、未完成持久会话、消费者提前结束、浏览器 HTTP/dispatcher 门禁、客户端断开、通知发送和并发订阅更新。

新增模块使用 V8 定向覆盖率及四项 80% 门槛，明确包含生产文件，避免默认排除规则产生空报告：

| 模块                                                | 语句   | 分支   | 函数 | 行     |
| --------------------------------------------------- | ------ | ------ | ---- | ------ |
| `src/plugins/service-work.ts`                       | 100%   | 90.9%  | 100% | 100%   |
| `src/gateway/lifecycle/drain.ts`                    | 94.44% | 83.33% | 100% | 94.11% |
| `extensions/acpx/src/managed-runtime.ts`            | 100%   | 100%   | 100% | 100%   |
| `extensions/browser/src/browser/service-handoff.ts` | 100%   | 100%   | 100% | 100%   |

这些数值针对列出的新增模块，不代表整个仓库或三个完整插件的覆盖率。

最终检查结果：

- `pnpm tsgo`：通过。
- `pnpm build`：通过；未发现 `INEFFECTIVE_DYNAMIC_IMPORT` 警告。
- `pnpm test:extension acpx`：28 项通过，1 项需要显式启用的 smoke 跳过；该 smoke 独立执行通过。
- 懒加载失败清理分支复测：8 项通过。
- 本次变更的 37 个 TypeScript 文件通过 type-aware Oxlint，0 警告、0 错误；提交文件通过 Oxfmt 与 `git diff --check`。
- `pnpm plugin-sdk:api:check`：通过；API 哈希变化对应新增公开入口及 v2 类型契约。
- `pnpm check:import-cycles`：通过，0 个运行时值循环。
- `pnpm check:madge-import-cycles`：未通过。现有 Brave 插件的 `brave-web-search-cache.runtime.ts` 与 `brave-web-search-cache.ts` 存在静态循环；两条导入在本次修改前的 HEAD 已存在，两文件均未修改。不将整个仓库检查标为全绿，也没有更改基线、忽略项或这些文件。

## 真实进程测试范围

`extensions/acpx/src/managed-gateway.smoke.test.ts` 通过 `OPENCLAW_MANAGED_PLUGINS_SMOKE=1` 启用，调用已构建的 CLI，启动外部 supervisor 与真实 Gateway 工作进程；同时启用三个目标插件，使用隔离配置、状态目录及模拟 ACP 协议子进程。

测试检查首次健康、replace 后工作进程标识变化、ACP 和浏览器真实加载日志、最终排空停止事件。最终独立运行 1 项通过，总用时约 296 秒，包含两次冷启动和收尾。没有使用真实模型、RabbitMQ 凭据、Telegram 凭据或用户浏览器 profile，因此不替代生产队列端到端验收，也不证明实际浏览器进程的所有平台清理路径均已实测。

## 部署与已知边界

1. 在更新并构建完整 v3 release 后运行 `pnpm openclaw gateway supervise --release .`。首次启动 supervisor 与后续向已运行 supervisor 发送 replace 请求是不同操作；不要为每次升级重复启动第二个 supervisor。升级目标应为已经构建完成的独立 release 目录。
2. 配置热加载继续沿用现有机制；需要重启时交由外部 supervisor。三个插件没有新增关闭、重启宿主或杀死 supervisor 的工具。
3. 冷启动有明显等待。一次隔离 Windows 测试中，从旧实例停用到候选实例就绪约 71 秒；这是该机器的观测，不是 SLA。队列可以等待，不能称为零停顿或无感即时回复。
4. acpx 0.5.3 没有公开的无损释放已准备持久客户端的接口。会话已 ensure 但尚未完成执行轮次时，会拒绝交接并恢复旧实例；不会通过删除会话、私有字段或强杀规避。
5. 保守排空先等待已接工作和核心空闲，避免切断任务后续所需的 ACP/浏览器能力。独立入口持续有新工作会推迟升级，超时恢复旧实例；尚未实现跨所有入口传播可信“既有任务延续”身份。
6. 不迁移活动流、Node 内存或 WebSocket；浏览器页面状态也不保证跨进程原样恢复。通知发送成功后进程突然崩溃仍可能重发，未宣称跨崩溃 exactly-once。
7. 同账户运行的模型执行工具或 ACP 子进程不构成系统权限隔离。生产上“夙衡不能关闭自身系统”的绝对约束，仍需独立 supervisor 账户与受限工作进程权限，本次插件适配没有代替这项部署工作。

## 资源检查

官方插件内存分析脚本在当前 Windows 环境因绝对路径被当作 ESM URL 而失败。使用相同插件入口的独立 Node 子进程和 `pathToFileURL` 复核加载成功，峰值 RSS：基线约 39.2 MiB，ACP 219.9 MiB，浏览器 298.7 MiB，配对插件 312.4 MiB。此记录是加载成本，不是运行中内存泄漏或长时间稳定性证明。
