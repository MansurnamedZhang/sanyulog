# 三余记首尔预检（Task 1）

本目录当前只实现精确发布基线和只读隔离门禁，不部署、不停写、不创建桶/DNS/容器，不运行迁移。Task 2–5 尚未由本脚本实现。`readyForStaging=true` 只说明本次观察满足预检，`deploymentAuthorized` 永远为 `false`；外部写入仍须按已批准计划单独授权并即时复查。

## 执行与证据

要求控制端 PowerShell 7.2+、Git、已认证且只读使用的 `gh`、OpenSSH；本地测试另使用项目 `.venv/Scripts/python.exe` 执行标准库模拟的 Linux probe。Linux 主机需 Python 3、Docker、`df/free/ss`；源主机需 curl，源容器已有 psycopg；目标需非交互 `sudo -n nginx -t/-T`。不安装依赖、不提升权限、不接受新主机指纹。SSH 固定 BatchMode/IdentitiesOnly/StrictHostKeyChecking，密钥参数仅为既有身份文件路径；脚本不读取文件内容、不接收密码。源 `hans@172.16.240.13`；目标 `ubuntu@43.131.245.43`。

```powershell
pwsh -NoProfile -File ops/seoul/tests/preflight.tests.ps1

# 先按下方格式由控制端生成新鲜 Cloudflare 证据；不要复制样例作为真实证据。
pwsh -NoProfile -File ops/seoul/preflight.ps1 `
  -ReleaseSha 450f11d64ce8fa77f9968b870602f18d174937b8 `
  -ChecksRunId 37766550561 `
  -CloudflareEvidencePath ops/seoul/evidence/<UTC时间>/cloudflare.json `
  -SourceIdentityFile C:\Users\hans\.ssh\id_ed25519_codex_dev_linux `
  -TargetIdentityFile <已有授权的首尔身份文件路径>
```

退出码 `0` 表示只读预检满足门禁；`2` 表示至少一项拒绝/未验证。stdout 是带 UTC 时间的白名单 JSON manifest；原始 SSH/SQL/gh/nginx 错误文本不透传。非零退出后不得忽略 blocker 继续部署。没有目标身份时不向用户索取密码；由控制端在自己的受控 SSH 会话补做目标核验。

保存位置约定为 `ops/seoul/evidence/<UTC时间>/preflight.json`，只在本项目忽略目录下保存。创建目录和写入输出前，控制端须确认非链接/非 junction，并设置 Windows 仅当前用户和 SYSTEM 可访问的 ACL（Linux 目录 0700、文件 0600）；Git ignore 不是访问控制。脚本本身只输出 manifest，不创建或更改证据目录的权限、不覆盖既有文件。记录原始退出码，不能把输出重定向成功当作预检成功。禁止把数据库 URL、Cookie、令牌、密码、原密钥、用户名或笔记正文放入该目录。

可点加载脚本单独做只读诊断（无自动执行）：

```powershell
. ./ops/seoul/preflight.ps1
$source = Get-SeoulHostObservation -Role source `
  -IdentityFile C:\Users\hans\.ssh\id_ed25519_codex_dev_linux `
  -BackupPath /home/hans/services/process-log/backups/v0.11.1-20261008-161548
# 不把完整原始观察直接发聊天；仅输出必要的聚合计数。
$source.counts
```

## Cloudflare 控制端证据接口

PowerShell **不直接查询 Cloudflare API**，不接受 Cloudflare 凭据。控制端使用已授权的只读连接器，核对 account 和 zone 归属，完成该 zone **全部分页** DNS 查询和该 account **全部分页** R2 桶查询，然后仅写下列字段。它是控制端声明的实时只读快照，不是加密签名，也不是脚本独立验证过的 API 结果；`complete=true` 只能在全部分页成功后设置。任何调用失败、漏页、旧快照不得用空列表代替。

约定文件：`ops/seoul/evidence/<UTC时间>/cloudflare.json`。下面是**格式示例，不是已核验的实时证据**；使用实际新鲜 UTC 时间，样例中的现有 DNS/桶须全部替换成实际完整列表。

```json
{
  "observedAtUtc": "2026-10-08T12:00:00Z",
  "provenance": "controller-attested-read-only",
  "complete": true,
  "accountId": "0910a2f37a347c249c2dce42169b9b65",
  "zoneId": "67edc27e351abaa1eee7d945a5b0b0f8",
  "zoneName": "896364.xyz",
  "zoneStatus": "active",
  "dns": [{"name": "example.896364.xyz", "type": "A"}],
  "buckets": [{"name": "example-existing-bucket"}]
}
```

不保存 DNS content、TXT 内容、账户邮箱、API 响应原文或任何 token。允许确实没有记录时的空数组；缺失字段、null、未完成分页、身份不符、未来时间或超过 15 分钟都拒绝。目标 DNS 名大小写/末尾点会归一化；已存在 `notes.896364.xyz` 或 `sanyulog-media` 拒绝。外部写入前须重新查询，15 分钟只是预检最大年龄，不是占用锁。

`observedAtUtc` 必须是带 `Z`（推荐）或明确 `±HH:mm` 偏移的 ISO-8601 JSON 字符串。CLI 保留该字段原始字符串，避免 PowerShell 自动转换日期时丢失时区。直接调用门禁时也接受 UTC Kind 的 DateTime 或保留偏移的 DateTimeOffset；拒绝 Local/Unspecified DateTime、无时区字符串和本地化日期格式。年龄严格为 0–900 秒，不因时区问题放宽窗口。

## 门禁和观测边界

- 发布：`git rev-parse <完整 SHA>^{commit}`，`gh run view <明确 run ID>` 的仓库 URL、push 事件、`headSha`、Checks 名、completed/success、非空成功 jobs；另须成功的镜像 build/import/record 三个 CI 步骤。`r2_reconcile.py` 基于指定提交的原始 Git 文本字节（保留末尾换行）作 SHA-256，而非当前工作树文件。CI 构建/导入成功不是发布镜像摘要、部署或实际 R2 成功；Task 2 仍须制作并核对该 SHA 的可追溯镜像。
- 源站：实际查询 Docker 运行服务名/状态、全部卷/网络名、精确 `process-log` 健康和 image ID、loopback `/api/health`、资源与监听/容器发布 TCP 端口。源 Nginx 通过成功的 `dpkg-query` 包状态查询及 PATH/`/usr/sbin/nginx` 检查确认：存在则实际 `nginx -t/-T` 采集站点；确认不存在则记录 `nginxChecked=true`、`nginxStatus=not-installed`、`nginxOk=false`、空站点列表。查询失败、缺字段或未知状态不允许用空列表冒充已检查；manifest 对缺失列表保存 null 并标为不完整。仅对既有受限备份目录读取普通文件并作不解析内容的摘要，拒绝符号链接、特殊文件及不可读子目录；不会验证恢复、生成新备份或把备份上传云端。默认备份名来自批准设计，可用 `SourceBackupPath` 指定同一 backup 根下的一个明确子目录。
- 源计数：现有容器内部使用现有数据库连接环境，仅用于 PostgreSQL READ ONLY / REPEATABLE READ 聚合 SELECT；连接信息不进入 shell argv、输出或异常。SQLite auth 库 `mode=ro` + query_only，读取账号启停标记与 storage ID 仅为内部 schema 映射，外传只有账号、启用账号、会话、已初始化 schema、项目、笔记本、附件数量。无 Auth/Store 构造器、建库、建 schema、密钥读取或 R2 操作。未初始化停用账号仍计入账号数；跨 SQLite/PostgreSQL 的活跃计数不是切换一致性快照。
- 目标：Nginx `-t` 和配置中 server_name 的只读解析；Docker 名称/状态、卷和网络名；TCP 18765；项目根 `/home/ubuntu/apps/sanyulog`、备份根 `/home/ubuntu/backups/sanyulog`、两个 Nginx 站点路径均必须不存在且祖先无 symlink。`sanyulog` 前缀容器/卷/网络拒绝。目标路径所在文件系统至少 10 GiB 可用、MemAvailable 至少 1 GiB；两台主机的容量必须为 0 至 Int64.MaxValue 的整数类型，拒绝字符串、Boolean、浮点数（即使数学上为整数）、NaN 和 Infinity。这是保守启动底线，不是压测/容量保证，正式恢复另核对备份体积与增长空间。
- Docker NAT：两台主机都按完整 container ID 只读批量 inspect，仅投影 `Id`、`HostConfig.PortBindings`、`NetworkSettings.Ports`，不读完整 inspect 或 Env。每批最多 100 个、总数最多 4096；前后重查 ID 集合，缺/重复/新增/消失或任一 inspect 失败均拒绝。`dockerTcpHostPorts` 包含已停止容器的配置绑定；目标其中任一 TCP HostPort=18765 即拒绝，独立于 `ss` 和 docker ps 的展示字符串。无法解释的端口映射也拒绝，不静默漏报。
- 未取得完整只读观测时失败关闭。manifest 中占用列表仅包含格式合法的名称/端口；被拒绝的任意字符串不转抄。所有完整 host/Cloudflare 观察须在预检 15 分钟窗口内完成。源容器当前镜像不会误当成待发布镜像。

预检通过后仍必须完成 HTTPS/维护入口、私有桶访问校验、用户确认的维护窗口、一致备份/恢复、全部账号与附件哈希核对、人工重新登录及回滚封存。不得为了测试写生产用户数据；不得停源站、删除旧容器/卷/备份，或改动其他项目。
