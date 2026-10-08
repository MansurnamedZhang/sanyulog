# 三余记首尔预检与隔离配置（Tasks 1–2）

本目录包含精确发布基线、只读隔离门禁，以及 Task 2 的声明式 Compose/Nginx 配置与本地契约测试。预检和测试不部署、不停写、不创建桶/DNS/容器，不运行迁移。Task 2 的实际资源创建和联调另由控制端执行；Tasks 3–5 尚未实现。`readyForStaging=true` 只说明本次观察满足预检，`deploymentAuthorized` 永远为 `false`；外部写入仍须按已批准计划单独授权并即时复查。

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

## Task 2：配置边界与两套数据区

`docker-compose.yml` 使用 JSON（YAML 1.2 子集），便于 PowerShell 原生解析语义、无需安装 YAML 模块。配置只有 `app`、`postgres` 两个服务；专用 bridge 允许应用出站访问私有 R2，不加入其它服务网络。PostgreSQL 16 不发布端口，应用只发布 `127.0.0.1:18765:8765`。服务没有全局 `container_name`；Compose 项目名前缀隔离网络和卷。

| 运行用途 | `SANYU_PROJECT` | 主机根目录 | 数据库名 | 卷 / 网络 |
| --- | --- | --- | --- | --- |
| 纯合成联调 | `sanyulog-fixture` | `/home/ubuntu/apps/sanyulog-fixture` | `sanyulog-fixture` | `sanyulog-fixture_pgdata` / `sanyulog-fixture_private` |
| 正式恢复 | `sanyulog` | `/home/ubuntu/apps/sanyulog` | `sanyulog` | `sanyulog_pgdata` / `sanyulog_private` |

控制端必须限制 `SANYU_PROJECT` **只允许表中两个字面值**，不能是任意路径/用户输入；Compose 的必填插值不是枚举验证。禁止额外 `-p`、`COMPOSE_PROJECT_NAME`、覆盖文件或 `COMPOSE_FILE` 改写对应关系。每次用显式 `-f` 和唯一 env 文件；先清除控制 shell 中旧的 `SANYU_*`（非系统变量），避免 shell 优先级覆盖已核对的槽位。项目名同时决定所有绑定目录、env 文件和数据库名，不能独立拼接生产与 fixture 路径。

两套应用不能同时绑定 18765。fixture 必须 `stop` 并检查已停止、端口释放后，才启动生产应用；不要 `down -v`。测试目录、数据库、卷和密钥保留为明确标记的可恢复 fixture，清理需另行逐一核实授权。不得把源数据恢复到 fixture；不得把 fixture 的 auth、state、密钥或 dump 导入生产。不要为了通过健康检查而提前启动空的生产应用：它会初始化数据库/auth，生产首次启动必须在 Tasks 3–4 完整恢复和核验后。

Task 1 预检原样执行于首次 staging 前。资源建好后预检会因“目标已存在”而拒绝，不能绕过或把该失败改成通过；后续控制端需保存新资源 ID/Compose project label/路径/哈希，按本次已创建资源清单核对所有权，不覆盖同名未知对象。fixture 根目录及其祖先、fixture 前缀卷/网络/容器也要额外查重；当前 Task 1 门禁并不替代这项检查。

### 受限目录与秘密文件

每个根目录下仅使用 `auth/`、`attachments/`、`state/`、`runtime/`、`secrets/`。创建/复制前逐层拒绝 symlink、junction、特殊文件；已存在文件先核实归属和哈希，不覆盖未知内容。应用 UID/GID 为 `1000:1000`（Dockerfile 与 Compose 一致）；确认目标主机 UID 映射，没有 rootless/userns remap 差异，否则暂停调整所有权方案。

`secrets/` 目录本身为 UID/GID `1000:1000`、`0700`；`runtime/` 为部署操作员所有、`0700`。应用根目录维持 `0700`，不为证书验证放宽权限。Nginx 的 ACME challenge 使用应用根目录之外的 `/var/www/notes.896364.xyz-acme`，不能因此扩大应用、秘密或数据目录的权限。

- `auth/`、`attachments/`、`state/`：UID/GID `1000:1000`，目录 `0700`，数据普通文件 `0600`；**可写**绑定。SQLite 会话和 WAL 需要写权限，附件上传/删除和账号 state 也需要写权限，不应把这些数据目录设成只读。
- `secrets/storage.key`：UID/GID `1000:1000`、`0600`、32 字节普通文件，只读绑定到 `/run/secrets/storage.key`。生产必须是源站原始密钥的同字节副本，核对摘要和长度，不显示内容，不生成替代密钥。fixture 另生成随机测试密钥，不接触原密钥。
- `secrets/r2.json`：UID/GID `1000:1000`、**精确 `0600`**，只读绑定到 `/run/secrets/r2.json`。JSON 恰含 `access_key_id`、`secret_access_key` 两个非空字符串字段。Linux 凭据读取器逐级拒绝符号链接；root-owned `0600` 对非 root 应用不可读，不能仅因权限位看似正确而放行。不得打印 JSON 或解析后的值。
- `secrets/postgres-password`：root:root、`0600` 普通文件，只读绑定到 `/run/secrets/postgres-password`。官方 PostgreSQL 镜像的默认 root entrypoint 读取 `_FILE` 后降权，故不要擅自给 postgres 服务加 `user:`；初始化后改文件不会轮换已有数据库密码。按实际选定镜像确认此行为与健康后才能继续。[官方 entrypoint 源码](https://github.com/docker-library/postgres/blob/master/docker-entrypoint.sh)
- `runtime/app.env`：部署操作员所有、`0600`，目录 `0700`，Git 忽略；**只含**应用实际支持的 `DATABASE_URL`，主机名必须为此项目 `postgres`、端口 5432、用户 `sanyulog`、数据库名为对应槽位。密码与该槽位 password 文件一致，使用安全随机 URL-safe 值或正确 URL 编码；禁止借用现有服务 URL。应用没有 `DATABASE_URL_FILE` 接口，Compose 通过 `env_file` 注入；该秘密仍存在于容器环境，Docker 管理员可读取，不能声称它是文件-only 注入。仅数据库密码采用这一例外，R2 与原密钥始终为只读文件。

不能在命令参数、聊天、CI、截图、shell history、日志或 Git 中提供值。不要运行/回传完整 `docker inspect`、`env`、`printenv` 或带值的 `docker compose config`。Compose 的 `config --quiet` 仅在控制端捕获 stderr、不外传未经审查的错误原文时使用；失败日志也可能含 env 值。不要开启 `set -x`。本地测试完全不打开上述真实文件；Git ignore 不等于访问控制。

### 精确发布与服务器镜像

批准的应用代码为 `450f11d64ce8fa77f9968b870602f18d174937b8`，对应 [Checks](https://github.com/MansurnamedZhang/sanyulog/actions/runs/37766550561)。后来增加的 ops 提交不是该代码发布 SHA。CI 记录的 `sha256:ea080836…` 是 GitHub runner 的本地 image ID，**不是可下载的 registry digest**。不尝试拉取这个 ID。

控制端重新核验该精确 SHA / Checks 后，在首尔从该 SHA 构建（下面只示意无秘密构建命令，不代表已执行）：

```bash
docker build --label org.opencontainers.image.revision=450f11d64ce8fa77f9968b870602f18d174937b8 \
  -t sanyulog:450f11d64ce8fa77f9968b870602f18d174937b8 \
  'https://github.com/MansurnamedZhang/sanyulog.git#450f11d64ce8fa77f9968b870602f18d174937b8'
docker image inspect sanyulog:450f11d64ce8fa77f9968b870602f18d174937b8 \
  --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
```

固定 Git context 避免从 ops HEAD 或脏工作树构建。保存构建命令、成功状态、源码 SHA、服务器新 image ID；还要以该 image ID 运行无凭据 import 检查 `import server, r2_media, r2_reconcile`。不通过 tag 名或 label 单独推定来源。基础镜像和依赖可能随时间变化，所以服务器 ID 不要求等于 CI ID；若构建失败则停止，不回退旧镜像。

`SANYU_IMAGE_ID` 必须是经上述核验的 `sha256:` + 64 位小写十六进制本地 image ID；Compose `pull_policy: never` 且无 build section，启动用 `--no-build --pull never`，缺镜像就失败。保存 postgres:16-bookworm 实际 RepoDigest 和 `.Id` 作为此轮证据；当前配置固定 major 16 而非声称锁定了该标签的不可变字节。

无秘密的 `runtime/compose.env`（仍 `0600`、忽略 Git）记录 `SANYU_PROJECT`、`SANYU_IMAGE_ID`、`SANYU_PROXY_IP`。`SANYU_PROXY_IP` 只能是本槽位实际 Docker bridge gateway/应用观测到的 Nginx 对端 **单个 IP**，不能放网段、通配符或 Cloudflare 客户端头。首次仅启动 postgres 以建立网络时，可临时设为 `127.0.0.1`，**此时不得启动 app**；检查 `<project>_private` 的网关和所有权后替换为实际 IP，重新 quiet 校验后才启动 app。最终以隔离请求验证代理对端与登录限速边界。

```bash
# 仅在人工验证槽位、文件权限、image ID、网络归属以及无外部占用后执行。
# 下列两个路径必须始终属于同一槽位；生产用另一套 env，不能直接复制执行。
docker compose --env-file /home/ubuntu/apps/sanyulog-fixture/runtime/compose.env \
  -f /home/ubuntu/apps/sanyulog-fixture/docker-compose.yml config --quiet
docker compose --env-file /home/ubuntu/apps/sanyulog-fixture/runtime/compose.env \
  -f /home/ubuntu/apps/sanyulog-fixture/docker-compose.yml up -d --no-build --pull never postgres
# 控制端检查专用网关、更新 compose.env，再 quiet 校验，才允许启动 app。
```

这不是自动部署脚本。配置文件复制到对应根目录后，绑定路径仍由已核对的 `SANYU_PROJECT` 决定。启动前确认 PostgreSQL 镜像已受控 pull/import；`--pull never` 不会替操作员下载镜像。所有命令错误由控制端脱敏，不能直接转发秘密。数据库健康检查不输出密码，应用健康检查只访问容器内 `/api/health`；健康状态不证明迁移或 R2 完整。

### 私有 R2 与 fixture 防污染

控制端每次外部写入前重新核对 account `0910a2f37a347c249c2dce42169b9b65`、zone `67edc27e351abaa1eee7d945a5b0b0f8`、桶与 DNS 全部分页、首尔命名/端口/路径和现有服务基线。仅创建专用 `sanyulog-media`，不复用现有桶；确认 managed public URL 关闭、自定义对象域名列表为空、不设浏览器 CORS。只申请该桶的 **Object Read & Write** 权限，不申请 account/admin 桶管理权限。

若连接器无法把一次性凭据直接交付到受限文件且不返回值，暂停，由用户在自己的 SSH/Teleport 会话中写入 `/home/ubuntu/apps/sanyulog/secrets/r2.json`；不要请用户发到聊天。fixture 需要其独立 `secrets/r2.json`，可由同一受控服务器会话作同桶受限凭据的普通文件复制（逐路径验证、不用 symlink、不外传值）。复制不扩大 token 权限；不要复制源数据库、auth 或原密钥到 fixture。

测试分两层：

1. SDK 权限探针只在 `_staging/<本轮随机ID>/<明确对象名>` 操作自己生成的合成密文，先确认精确 key 不存在，以防覆盖；执行 PUT、HEAD、GET 并核对字节/摘要，再 DELETE **该唯一 key**，确认不存在。只输出操作状态与摘要，不打印返回的授权头、签名 URL 或凭据。不使用 prefix 批删，也不把真实附件用于探针。
2. 应用联调使用 fixture 的独立 auth/DB/目录。应用对象 key 固定 `v1/<storage_id>/<digest>`，不能用配置伪造任意测试前缀。因此 bootstrap owner 仅作账号管理，**禁止 owner 上传测试媒体**，避免触碰迁移后 `v1/owner/`。另建两名纯合成非 owner 账号；在受控内存中确认它们的随机 storage ID 与源站全部账号（包括停用账号）不相交，才允许上传。测试媒体仅在这两个 ID 下，用精确 key 清单验证跨账号拒绝、镜像/回退、删除和 Range；绝不扫描/删除 `v1/` 或生产账号前缀。

fixture 在正式迁移前停止；保留受限清单及本地资产。明确列出的测试对象需清理并验证该轮剩余对象为零，或在迁移清单中明示保留且阻止最终“仅有效媒体”验收；不得把 fixture 对象算成生产成功。匿名拒绝还要验证真实 R2 入口权限及 public/custom domain 状态，不能仅靠“没有公开配置”或一个不存在 key 的 404 推断私有。

### Nginx 与 HTTPS 维护入口

`notes.896364.xyz.conf` 中两个活动 server 仅服务这个域名；HTTP 除 ACME challenge 外、HTTPS 所有路径/方法均返回 503 维护页，无活动 `proxy_pass`。最终业务代理完整保留在注释区，**只有 Task 5 数据/R2/认证及用户验收门禁通过后**，才能替换 HTTPS 的那个 `location /`；不能把它追加成重复 location。代理固定本项目 loopback，传原 Host/协议，覆盖客户端伪造的 X-Forwarded-For；64 MiB 入口余量供 25 MiB 附件 JSON/base64 信封，应用自身限额不变。若 Cloudflare 开启代理，`$remote_addr` 默认可能是边缘节点，不能把这称为真实访客 IP；不为本任务修改其它站点的全局 real_ip 信任配置。

首次没有证书时：保存既有 Nginx `-t` 成功和其它站点基线；确认两个目标 site 文件不存在，再只暂存模板**第一个 HTTP server 块**。ACME webroot 固定为站点专用 `/var/www/notes.896364.xyz-acme`，与 `0700` 应用根目录完全分离；不得用应用根目录中的 symlink 指向它，也不得放宽应用根目录权限。创建前确认该精确路径不存在、祖先无 symlink 且 Nginx worker 可遍历；若已存在则先验证归属，不复用其他站点目录。仅新建的站点 webroot、`.well-known/`、`acme-challenge/` 目录使用 root:root `0755`，公开 challenge 普通文件 `0644`；不能把 auth、附件、env、密钥或备份复制进这个公共目录。先 `sudo nginx -t` 成功才 reload。DNS 只新增 `notes.896364.xyz` 指向首尔，首次建议 DNS-only 以直接验证 origin，不触碰其它记录。

使用 Certbot **certonly + webroot**（`--webroot-path /var/www/notes.896364.xyz-acme`）为唯一域名申请证书，禁止 `--nginx` 自动重写其它站点。申请前在该 webroot 的 `.well-known/acme-challenge/` 下创建本轮唯一、无秘密的探针普通文件；用正确 Host 经 HTTP 请求相同 challenge 路径，必须得到 200 和精确探针字节，缺失探针为 404，同时 `GET /` 和 `POST /api/state` 仍为 503。先验证此行为再申请证书；测试后只移除精确探针文件，不删除 webroot 或其他 challenge。证书成功存在、权限正常后，备份本次 HTTP-only site 为受限、可恢复的普通文件，再安装完整维护模板；再次 `nginx -t` 成功才 reload。证书失败保持 HTTP 维护，不装引用不存在证书的 HTTPS 块、不关闭 TLS 验证、不公开 18765。不添加 default_server 或 wildcard，也不改现有 enabled sites；核对其它站点 root/config 摘要保持原样。

上线维护阶段需独立检查 origin `https://notes.896364.xyz`（用正确 SNI/Host 的 `--resolve ...:443:43.131.245.43`，不用 `-k`）、证书链/域名/期限，及经 DNS 的请求结果。`GET /`、`GET /api/health`、`POST /api/state` 必须仍是 503 维护响应，不是后端 200/401；保留 ACME challenge 可验证性。Docker 内/local `/api/health` 则单独应为 healthy/200。需要浏览器内部 fixture 联调时另走受控 SSH 本地隧道，不提前开放公网业务代理，也不关闭 Secure Cookie；具体夹具会话测试不得输出 Cookie。

### 验证分层与停止条件

```powershell
pwsh -NoProfile -File ops/seoul/tests/config.tests.ps1
pwsh -NoProfile -File ops/seoul/tests/preflight.tests.ps1
```

本地配置测试解析真实 Compose 字段和 Nginx 活动指令树，验证隔离、挂载、敏感字段边界与维护默认态；不打开 env/secret 文件，不联网，不启动容器。它不能替代真实 `docker compose config --quiet`、Linux 文件权限、Docker health、`nginx -t`、证书/TLS、匿名 R2 拒绝、R2 CRUD 和 fixture 账号隔离验收。本机没有 Docker/Nginx 时明确标为未运行，而不是跳过后写“Task 2 完成”。

任何失败保留源站正常服务和本轮诊断材料，不停源站、不开始恢复、不启用最终代理；不自动重试一次性 token 创建。控制端记录新资源 ID、UTC 时间、服务状态、source SHA、image ID、非秘密配置 SHA-256、已修改单个 site 的备份路径与脱敏测试摘要。秘密安全交付、即时占用复查或人工权限缺失时暂停，由用户处理。本文仅是 Task 2 配置交付，**不是首尔资源/HTTPS/R2 已验收的证据**。

接口参考：[Compose services / binds / env_file](https://docs.docker.com/reference/compose-file/services/)、[R2 桶范围凭据](https://developers.cloudflare.com/r2/api/tokens/)、[Nginx return 指令](https://nginx.org/en/docs/http/ngx_http_rewrite_module.html#return)。
