# Windows 运行时故障恢复部署

本说明对应 v3 的 `pnpm deploy:serve` 托管部署。代码修改和本地隔离测试不会安装服务，也不会连接生产 RabbitMQ/MySQL。原有双实例发布准备条件继续适用，见 [部署说明](windows-managed-deployment-runbook.md)。

## 能力与边界

- 活动 worker 意外退出：关闭新请求入口，保存诊断，按退避策略恢复当前已验证版本。
- 连续 `/healthz` 探测失败：先请求旧 worker 退役；确认退出后才启动替代进程。探测只判断网关存活，不把模型或数据库业务请求失败直接解释为进程故障。
- 旧进程无法退出：默认 30 秒后进入 `blocked`，不会强杀后自动启动第二个写入者。
- 发布、恢复和停止共享生命周期互斥。主动停止取消恢复等待；发布中按计划退出不会被误判为运行时崩溃。
- 恢复预算和待确认执行权写入磁盘。重启 supervisor 不会清空预算；发现之前记录的 PID 仍存活或无法确认时拒绝启动。PID 被复用也会保守阻断，不会误杀其他程序。
- 父进程消失时沿用 worker 的 IPC 断开退役机制。未引入原生 Windows Job Object；若遗留 worker 卡住，执行权检查会阻断接管，需要人工核验。
- 不重放结果不明确的业务请求，不保证中断任务恰好执行一次。正常恢复会短暂返回 503，客户端需要重连。

## 配置

`pnpm deploy:prepare --output <新版本目录>` 在构建和产物校验成功后，自动创建同级的 `supervisor/supervisor.json`。例如输出 `C:\Users\PC\Desktop\release\001`，配置位于 `C:\Users\PC\Desktop\release\supervisor\supervisor.json`。默认沿用当前用户的 `~/.openclaw/openclaw.json` 和状态目录；遵循 `OPENCLAW_HOME`、`OPENCLAW_STATE_DIR` 和 `OPENCLAW_CONFIG_PATH` 环境变量。默认入口为 `127.0.0.1:18789`，worker 端口为 19001 和 19041。

已有 supervisor 配置和部署状态保持原样，准备下一版本不会修改 `initialRelease` 或切换运行中的服务。首次创建的管理目录在 Windows 上只授权当前账户、SYSTEM 和管理员；其他平台使用 0700。已有目录缺少配置时会要求人工检查，避免重置现有目录的权限。Gateway 配置必须已存在；生成器不改写认证、代理、来源设置或凭证。启动前仍需检查部署说明中的 Gateway 配置和首次端口交接条件。

对于已经构建并校验过的版本，可以只补生成配置，无需重建：

```powershell
pnpm deploy:prepare --configure C:\Users\PC\Desktop\release\001
pnpm deploy:serve C:\Users\PC\Desktop\release\supervisor\supervisor.json
```

`--configure` 先校验发布产物，再生成或保留配置；`--verify` 保持只读。若构建成功但配置生成失败，修正所提示的问题后使用 `--configure`，不要对已有版本目录重新执行 `--output`。`supervisor` 是保留的管理目录名称，不应用作发布版本目录名。Windows 服务账户若不是当前用户，仍需按下文单独授予该账户所需权限。

旧 supervisor 配置仍兼容。可在 `supervisor.json` 增加以下字段；省略时使用这些默认值：

```json
{
  "recovery": {
    "maxAttempts": 5,
    "windowMs": 900000,
    "delaysMs": [5000, 15000, 30000, 60000],
    "healthIntervalMs": 10000,
    "healthTimeoutMs": 3000,
    "healthFailures": 3,
    "retireTimeoutMs": 30000
  }
}
```

预算是 15 分钟内最多 5 次恢复尝试，成功恢复也不立即清零。用尽后保持 `blocked`，排查原因后显式执行 `recover`。启动/发布就绪仍由 `startupTimeoutMs` 管理。退役超时只代表“阻断接管”，不代表允许强制终止。

## 本机管理

在稳定的 supervisor 代码目录运行：

```powershell
pnpm deploy:control C:\openclaw-service\supervisor.json status
pnpm deploy:control C:\openclaw-service\supervisor.json deploy C:\openclaw-releases\release-002 --compatible-state
pnpm deploy:control C:\openclaw-service\supervisor.json recover
pnpm deploy:control C:\openclaw-service\supervisor.json stop
```

`--compatible-state` 是发布者确认新旧版本数据兼容，程序不会自动证明。`recover` 只在 blocked 状态可用，并要求本 supervisor 所有旧 worker 已退出；它会显式重置恢复预算。

管理命令使用 `${journal}.commands` 本地目录，不开放网络管理端口。**能够写入该目录，就具有发布和停止服务的权限。** journal 父目录及管理目录只应允许服务账户、管理员和指定运维账户访问。Windows 的 Node `mode: 0600` 不替代 NTFS ACL，必须完成下方权限准备后再启动。

请求文件先改名为 `.processing`，再执行。进程崩溃后遗留的 `.processing` 不自动重放；命令等待超时会报告请求 ID，结果可能未知，应先核验状态和诊断，不要盲目重复发布。正常响应读取后会清理；超时遗留响应需由运维按请求 ID 核对清理。未领取的 `.request` 仍可能被执行。

## Windows 服务准备

使用 [WinSW 2.x 官方发行版](https://github.com/winsw/winsw/releases)，自行核验来源和校验信息。配置生成器遵循 [WinSW XML 文档](https://github.com/winsw/winsw/blob/v2/doc/xmlConfigFile.md)，不会下载二进制或安装服务。

在目标电脑以管理员 PowerShell 创建一个新的专用目录。不要对项目根目录、用户目录或现有共享数据目录照搬权限重置：

```powershell
$serviceDir = 'C:\openclaw-service'
if (Test-Path -LiteralPath $serviceDir) { throw '目录已存在，请先检查权限，勿覆盖现有服务' }
New-Item -ItemType Directory -Path $serviceDir | Out-Null
$operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls $serviceDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)M' "*${operatorSid}:(OI)(CI)F"
if ($LASTEXITCODE -ne 0) { throw '目录权限设置失败，不能继续启动' }
```

把 supervisor 配置放在该目录，`journal` 也指向该目录中的 `deployment-state.json`。配置内的 Gateway 配置、状态、工作区、浏览器数据和日志路径必须指向目标电脑真实的持久化绝对路径。服务默认使用 `LocalService`，其 HOME、PATH、凭证和浏览器会话与登录用户不同，不能直接沿用旧用户的 `~/` 路径。

为 LocalService 明确授予持久数据目录所需的读写权限，以及 supervisor 代码、Node、发布产物和真实 pnpm 依赖目录的读取/执行权限。确保依赖链接在该账户下可访问。不要直接给整个用户目录或磁盘放宽权限。如果业务依赖当前用户凭证，先由管理员配置合适的专用服务账户和 ACL，再进行联调。

在稳定 supervisor 代码目录生成服务定义：

```powershell
pnpm deploy:windows-service C:\openclaw-service\supervisor.json C:\openclaw-service
```

生成 `OpenClawSupervisor.xml`，将核验后的 WinSW 2.x 文件放在旁边并重命名为 `OpenClawSupervisor.exe`。检查 XML 中 Node 和源码目录、服务账户、日志目录后，在计划好的首次迁移窗口执行：

```powershell
& 'C:\openclaw-service\OpenClawSupervisor.exe' install
& 'C:\openclaw-service\OpenClawSupervisor.exe' start
```

安装前应先结束旧网关的业务任务并停止旧启动方式，关闭旧计划任务或其他自动拉起机制。固定入口端口必须交给 supervisor，不能让两个管理器争抢。

服务设置为延迟自动启动；supervisor 非正常退出后分别等待 15 秒、60 秒重启，再次失败则停止，避免无限循环。worker 的恢复预算独立保留。WinSW 捕获 supervisor 和 worker 的标准输出/错误，按 10 MiB 轮转、保留 8 个归档。

正常维护使用 Windows 服务停止命令：

```powershell
& 'C:\openclaw-service\OpenClawSupervisor.exe' stop
```

WinSW 会调用本机 `stop` 管理命令，等待进程退出。它的最终停止超时为 5 分钟，届时包装器可能强制终止进程；这不保证业务排空成功。不要用服务强制停止代替日常发布。重启后的执行权/journal 检查仍会拒绝不明确的接管。

## 故障排查

`deploy:prepare` 在解压时若提示 `CLAUDE.md: Can't create`，请更新 v3 后重试。根目录的损坏链接已恢复为 `AGENTS.md`，发布解压也会跳过各级 `CLAUDE.md` AI 指引别名，避免依赖 Windows 创建符号链接的权限；`AGENTS.md` 和业务源码仍保留。发布准备仅导出已提交的版本，所以仅在工作目录编辑文件不会修复旧提交中的归档。之前失败的输出目录可能已部分解压，重试时使用新的目录，例如 `release-002`，不要覆盖已有发布目录。

以 journal 为 `deployment-state.json` 为例：

| 文件                                  | 用途                                                     |
| ------------------------------------- | -------------------------------------------------------- |
| `deployment-state.json`               | 当前发布版本和切换阶段                                   |
| `deployment-state.json.recovery.json` | 重试时间、阻断状态、待确认 worker PID                    |
| `deployment-state.json.events.jsonl`  | 带时间的退出、退避、恢复和阻断记录；另保留 `.1` 轮转文件 |
| `logs/*.out.log`、`logs/*.err.log`    | WinSW 捕获的完整程序输出                                 |

先执行 `status`，再根据日志核验退出原因。恢复预算耗尽：解决原因后执行 `recover`。旧 worker 仍活着：检查具体 PID 的命令行、资源占用和业务状态，确认任务/消息处理结果；不要仅删除锁文件或恢复状态文件。journal 停在 preparing、draining、activating 等发布中间阶段时仍要求人工核验，不自动猜测回滚。

## 目标机验收

使用隔离队列、测试数据库和非生产端口：

1. 启动服务，检查入口和连续对话。
2. 仅终止测试 worker，确认 PID 改变、入口恢复、退出码和重试记录落盘。
3. 模拟持续健康失败和退役失败，确认不产生第二个业务实例。
4. 连续崩溃至预算用尽，重启 supervisor 后确认仍 blocked，再测试人工恢复。
5. 发布期间保持业务任务，验证排空、候选失败回滚及没有重复消费者。
6. 在恢复退避期间主动停止服务，确认不会再拉起 worker。
7. 终止测试 supervisor，核验旧 worker 退出或接管被阻断，不能出现两个写入者。
8. 重启目标 Windows，验证服务账户权限、自动启动、日志轮转及实际业务依赖。

这些目标机步骤尚未在生产电脑执行。本地测试使用模拟 worker 验证进程生命周期；不能替代真实 RabbitMQ/MySQL、浏览器和服务账户验收。

## 本次本地验证（2026-11-04）

- 恢复/协调/本机管理/执行权/IPC：28 项测试通过，包含终止独立 supervisor 进程后再次启动的验证。
- 现有代理、产物准备和 Windows 服务 XML：25 项测试通过。
- 恢复实现四个模块合计：行覆盖率 89.44%，分支覆盖率 80.24%，函数覆盖率 91.76%，语句覆盖率 89.50%。
- `pnpm build` 通过；未发现 `INEFFECTIVE_DYNAMIC_IMPORT` 警告。根项目类型检查及部署脚本/测试的独立严格类型检查通过。
- 修改文件的 lint 通过。完整 `pnpm check` 曾在 lint 阶段失败；本次新增问题已清理，原有 `outputs/managed-worker-smoke.mjs`、`src/infra/mysql-pool.test.ts`、`extensions/phone-reader/src/gallery.ts` 和 `extensions/rabbitmq-consumer/src/video-link-parse-tool.ts` 的 lint 问题未在本任务中改动，因此不宣称全仓检查通过。
- 未安装 WinSW，未切换目标电脑服务，未执行生产端到端测试或完整全仓测试。
