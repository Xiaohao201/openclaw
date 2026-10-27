# OpenClaw Windows 单机双实例部署说明

适用范围：原生 Windows、Control UI、RabbitMQ；2026-10-26。本次是代码交付和隔离验证，未切换当前服务，也未连接生产 RabbitMQ/MySQL。

## 实际行为

- 一个长期运行的 supervisor 监听固定入口端口，转发 HTTP 和 WebSocket；两个版本分别使用独立只读代码目录、不同后端端口。
- 候选 worker 在待命阶段只建立 IPC、加载入口模块，不启动 Gateway、消费者或定时任务。这是轻量待命，不是完整业务预热。
- 发布时入口暂停转发新请求，现有 WebSocket 保留。旧 Gateway 拒绝新的外部业务请求，仍允许已接收的插件任务和审批结果完成。停止消费者、定时触发器和配置热加载，再等待已接收任务、回复及会话写入完成。
- 确认旧进程退出后才激活候选。所有 worker 使用同一个绝对 `OPENCLAW_CONFIG_PATH` 和 `OPENCLAW_STATE_DIR`，保留现有 Gateway 锁，不使用多 Gateway 绕过开关。新进程读取最终会话文件和工作区，不复制旧快照。
- 新实例启动成功、插件服务没有报告启动失败后再切换路由。RabbitMQ 插件在托管模式下等待实际消费者注册，30 秒内未就绪会使启动检查失败。
- Control UI 使用同一个 runId 重试服务端明确标记“尚未接收”的请求；重连认证完成后再发，最多等待 120 秒。结果未知的请求不自动重放，保留草稿并在重连时加载历史，避免重复调用模型或外部工具。
- 候选激活失败时，先排空并确认候选进程退出，再重新启动前一版本，读取当前数据。回滚不恢复旧会话文件或数据库快照。

这是“入口地址稳定、业务单活、会话连续、短暂自动重连”的实现。切换窗口中新 HTTP 请求返回 503，新 WebSocket 连接暂时失败，Control UI 会重连；不是每个请求始终立即响应，也不是 TCP 永不断线。RabbitMQ 在无消费者的间隙由 broker 保留待处理消息。

## 准备条件

1. 使用包含本次修改的已提交版本构建，初始版本和候选版本都必须包含 `dist/deployment/worker.js`。原始旧版本不能直接作为托管回滚目标。
2. 依赖、平台、架构和 Node 主版本与构建环境匹配；版本目录不可在运行期间重新构建或改写。pnpm 依赖链接需要在目标机器有效；哈希清单不保证跨机依赖可移植。
3. 状态目录、配置文件、业务工作区及数据库保持同一份。显式配置的 workspace、agentDir、session.store 必须使用绝对路径或 `~/`，且不得位于将被替换的版本目录中。插件的可变文件路径同样要放到持久目录。
4. Gateway 配置显式使用 `gateway.auth.mode: "token"` 或 `"password"`，保留原凭证；`gateway.trustedProxies` 包含 `"127.0.0.1"`；`gateway.controlUi.allowedOrigins` 包含浏览器实际访问的稳定入口 origin。禁止通过关闭认证来适配代理。
5. 后端只绑定 `127.0.0.1`，使用 HTTP。本实现不承担 TLS 终止。公网或 HTTPS 场景需保留已有受信任 TLS 入口并单独核验来源和认证设置；不要直接把示例扩展为公网部署。
6. 本次验收范围只包含 Control UI + RabbitMQ。不要据此开启未经检查的其他 webhook、OpenAI HTTP 接口或渠道，再宣称它们具有相同的排空保证。

## 构建与首次迁移

在独立构建目录准备产物（命令只导出已提交 HEAD，不包含未提交改动）：

```powershell
pnpm deploy:prepare --output C:\openclaw-releases\release-001
pnpm deploy:verify C:\openclaw-releases\release-001
```

准备第二版本时使用不同目录。不要在 supervisor 所在目录、当前版本目录或现有 `dist` 上执行原地构建。两个进程并不能隔离同机构建的 CPU、内存和磁盘竞争。

首次迁移需要安排一次端口交接窗口：现有 Gateway 正占用的端口无法被 supervisor 同时绑定。先让现有任务结束，再停止旧启动方式，将该端口交给 supervisor。关闭原 Windows 计划任务或服务的自动拉起机制，避免它抢占端口或执行权。此步骤本次没有执行。

把 supervisor 运行目录保持不变，它的升级需要另行安排。新建独立配置文件，例如 `C:\openclaw-deploy\supervisor.json`（路径均为示例，父目录需先存在）：

```json
{
  "host": "127.0.0.1",
  "port": 18789,
  "slotPorts": [19001, 19041],
  "stateDir": "C:\\openclaw-data",
  "configPath": "C:\\openclaw-data\\openclaw.json",
  "initialRelease": "C:\\openclaw-releases\\release-001",
  "journal": "C:\\openclaw-deploy\\deployment-state.json",
  "startupTimeoutMs": 120000
}
```

端口之间至少间隔 20，仍需检查浏览器/CDP 等实际派生端口。如果需要同一内网的其他电脑访问，可在网络和来源配置核验后将 host 改为 `0.0.0.0`；默认仅本机访问。

```powershell
pnpm deploy:serve C:\openclaw-deploy\supervisor.json
```

启动先占用稳定端口，成功后才启动业务 worker。初次切换到本次 UI 代码后，刷新浏览器以加载新增的恢复逻辑。后续业务发布保持该 supervisor 进程运行。

## 发布与回滚

构建并验证候选版本后，在 supervisor 的标准输入中输入一行 JSON：

```json
{"release":"C:\\openclaw-releases\\release-002","compatibleState":true}
```

`compatibleState: true` 是发布者确认旧代码可以读取新代码可能写入的数据格式、配置和数据库结构；它不是程序自动推导出来的兼容性证明。有破坏性数据库迁移、会话格式升级或不可逆外部操作时，不应作此声明，也不应使用自动回滚流程。

日志阶段依次为 preparing、draining、activating、running。失败可能进入 rolling-back 或 blocked。启动等待默认 120 秒；超时不意味着可以强杀一个仍在写入的进程。退役没有强杀超时：若仍有任务或插件拒绝停止，会保留执行权并阻止第二个写入者，可能需要人工排查。

`deployment-state.json` 用临时文件重命名记录阶段。重启 supervisor 时，running 记录决定要启动的版本；如果记录停在中间阶段，程序拒绝猜测恢复。先核实是否还有旧 worker、锁和在途消息，再修复部署状态；不能仅删除锁文件强行启动第二个实例。

自动回滚范围是本次切换中的候选启动/就绪失败；不包含发布数小时后任意业务故障的自动判定，也不包含单机宕机、broker 数据丢失、外部工具恰好一次执行。托管进程不要混用原 `gateway restart` 或其他进程管理器的自动重启路径；需要重启时也通过发布当前已验证版本进行交接。

## 验证与剩余验收

已加入本地测试：代理 HTTP/WS 转发、来源头覆盖、同端口切换、旧进程先退出再激活、候选失败先退役再回滚、排空失败阻止接管、并行发布拒绝、RabbitMQ 就绪/排空、UI 未接收重试与未知结果不重放。子进程测试使用临时目录和随机端口，worker 是明确的模拟业务进程。

补充产物验证已通过：独立源码副本执行完整 `pnpm build` 和 `pnpm ui:build`；编译后的真实 worker 在临时配置下完成“待命无业务状态写入 → 最小 Gateway 激活及 /healthz 检查 → 排空退役”。该最小 Gateway 测试禁用真实渠道/插件，不等于 RabbitMQ/MySQL 联调。根项目及部署脚本的类型检查通过。部署准备/协调/监督脚本行覆盖率 85.48%，固定入口代理行覆盖率 95.77%；覆盖率分别按仓库测试项目统计。

真实产物冒烟脚本保存在同目录 `managed-worker-smoke.mjs`，可用 `node outputs/managed-worker-smoke.mjs <已构建版本目录>` 重新执行；它只创建临时配置和测试状态，不读取生产配置。

还需在隔离 RabbitMQ 队列和 MySQL 数据下完成真实业务验收：连续两轮会话、流式输出、长任务、取消消息、数据库失败、候选无法连接 broker、进程异常退出，以及旧版本读取候选写入数据的兼容性。当前没有该环境，因此不能把本地测试表述为生产端到端验收完成。

没有新增服务端持久化收件箱或跨进程请求结果账本。关闭浏览器会丢失内存中的待重试请求；结果未知时保留草稿供核对，而不承诺自动确定是否执行。RabbitMQ 的异常 nack 策略和外部副作用语义仍沿用业务实现。
