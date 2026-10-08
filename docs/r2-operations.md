# 三余记私有 R2 运维与恢复手册

本手册对应首尔 Python + PostgreSQL + 私有 R2 方案，不是 Workers/D1 部署。执行前核对[批准设计](superpowers/specs/2026-10-08-seoul-r2-hybrid-deployment-design.md)、目标账号、专属容器、挂载路径和精确 Git SHA；下列路径是本工具的部署契约，若实际挂载不同，先修订受限运维清单，再执行。本文不代表已创建桶、已构建镜像或已部署。不得向生产笔记写入测试数据。

## 1. 发布门禁与镜像

仅发布经过独立审核的精确提交，并等待该 SHA 的 GitHub Checks 成功。Checks 在 Linux 安装 `requirements.txt` 中固定版本的 Python 依赖和 `npm ci` 锁定依赖，使用独立 PostgreSQL 16 服务运行数据库测试，执行 POSIX 权限测试、前端检查/格式/测试、安装 Playwright Chromium 后运行 `npm run test:ui`。后者包含真实浏览器的登录后媒体播放、拖动与 CSP/视口验收，不只是静态 HTML 断言。

随后执行 `docker build -t sanyulog:r2-check .` 和无凭据的 `docker run --rm sanyulog:r2-check python -c "import server, r2_media, r2_reconcile"`。CI 输出实际检出的 SHA 与本地构建 image ID；image ID 不是镜像仓库的 manifest digest。交付清单保留 Checks 链接、SHA、构建日志、依赖清单、image ID；若另行获准推送镜像仓库，再记录实际 repo digest。PR 的合并测试 SHA 不等于分支 SHA，正式交付须核对实际通过门禁的提交。

Dockerfile 只 COPY 明确列出的 Python 模块、固定依赖与 `static/`；不能改成 `COPY . .`。R2 凭据、原始加密密钥、认证库、数据库、备份和运维清单均不得进入 Git、镜像或镜像构建参数。没有 Docker 的本机只能验证复制载荷与导入，不能声称 Docker 构建通过；Windows 跳过的 POSIX 与无 PostgreSQL 时跳过的测试必须单独列明，以该 SHA 的 Linux Checks 补齐。

## 2. 专用私有桶和受限凭据

仅使用专用桶 `sanyulog-media`，先核对归属和名称冲突，不复用其他项目的桶或宽权限凭据。关闭 `r2.dev`，不连接公开对象域名，不允许匿名读取，不设置浏览器 CORS，遵循官方[公开桶访问说明](https://developers.cloudflare.com/r2/buckets/public-buckets/)。仅给本工具服务端凭据授予该桶的 Object Read & Write 权限（含对象列举），不授予其他桶或账号管理权限，参见官方[R2 凭据与桶范围](https://developers.cloudflare.com/r2/api/tokens/)。浏览器始终通过同源、已授权的附件 API 访问；不得输出预签名长期链接。

R2 凭据仅在部署 Linux 上通过受控安全渠道写入专用文件，文件必须是 JSON 对象且恰好包含两个非空字符串字段 `access_key_id`、`secret_access_key`。不要把值放进聊天、Git、Compose 明文环境、命令行、shell 历史、构建参数、日志或测试。本文不提供任何凭据值；不得启用 SDK debug 日志或输出整个环境。

| 用途 | 宿主机受限路径 | 容器路径 | 权限与挂载 |
| --- | --- | --- | --- |
| R2 凭据 | `/home/hans/services/process-log/secrets/r2.json` | `/run/secrets/r2.json` | 文件 UID/GID `1000:1000`、恰好 `0600`、只读 bind |
| 原始 32 字节密钥 | `/home/hans/services/process-log/secrets/storage.key` | `/run/secrets/storage.key` | 保留原值、UID/GID `1000:1000`、`0600`、只读 bind |
| 完整认证库 | `/home/hans/.local/share/process-log-auth/auth.db` | `/auth/auth.db` | 专用受限目录，服务 UID 1000 可读写 |
| 本地附件密文镜像 | `/home/hans/services/process-log/attachments` | `/attachments` | 专用受限目录，服务 UID 1000 可读写 |
| 状态与审计清单 | `/home/hans/services/process-log/state` | `/state` | 专用受限目录，服务 UID 1000 可读写 |

`secrets` 和运维输出目录用 `0700`，受限父目录不能是符号链接。凭据文件自身及其容器内所有父路径均不得是符号链接；禁止硬编码秘密到 Compose。只读挂载不会替代权限检查：镜像以 UID/GID 1000 运行，root 所有的 `0600` 文件无法被该用户读取。凭据被安全交付后，Linux 运维员仅检查元数据和权限，不读取到终端：

```bash
stat -c '%a %u:%g %F %n' /home/hans/services/process-log/secrets /home/hans/services/process-log/secrets/r2.json
test ! -L /home/hans/services/process-log/secrets/r2.json
test "$(stat -c '%a:%u:%g' /home/hans/services/process-log/secrets/r2.json)" = '600:1000:1000'
# 对实际应用容器确认只读 bind、容器 UID、原有服务的所有挂载和父路径。
docker exec --user 1000:1000 process-log python -c 'from pathlib import Path; from r2_media import R2Credentials; R2Credentials.load(Path("/run/secrets/r2.json")); print("credential file validated")'
```

每个检查须成功才继续；不要打印 `R2Credentials` 的字段、读取文件内容或使用 `docker inspect` 输出全部环境。代码严格要求 POSIX 的普通文件、恰好 `0600`、属主为 root 或有效 UID，且当前进程能读；Windows ACL 不被当作 Linux 私密性证明。

应用启用 R2 时同时设置以下非秘密配置（凭据值不在环境中）：

- `PROCESS_LOG_R2_ACCOUNT_ID`：核对后的 Cloudflare 32 位小写十六进制账号 ID。
- `PROCESS_LOG_R2_BUCKET=sanyulog-media`。
- `PROCESS_LOG_R2_CREDENTIALS_FILE=/run/secrets/r2.json`。
- `PROCESS_LOG_ENCRYPTION_KEY_FILE=/run/secrets/storage.key`，必须保留原始密钥。
- 原有 `DATABASE_URL`、`PROCESS_LOG_DATA=/state`、`PROCESS_LOG_ATTACHMENTS=/attachments`、`PROCESS_LOG_AUTH_DB=/auth/auth.db`、鉴权、HTTPS Origin、可信代理继续按独立受限部署配置提供；不要把数据库认证值写入本手册或构建日志。

全部三个 R2 变量都不存在时维持旧部署的本地行为。任意变量存在（即使为空）却未完整提供、缺少加密密钥、凭据不安全/不可读或账号配置无效，都拒绝启动，不静默降级为 local-only。启动成功只证明配置和依赖可用，不证明 R2 网络、权限或对象已对账；必须继续隔离联调。应用端口仅对宿主机 loopback 开放，入口验收前维持维护页。

## 3. 备份与隔离恢复门禁

先停写或使用经验证的一致性备份流程，保留本工具专属 PostgreSQL 数据库备份、完整 `auth.db`（包含停用账号和会话）、全部账号的本地附件密文、原始 `storage.key`、受限部署配置与挂载清单。数据库/认证库/配置/根密钥不得上传到 R2；R2 仅存附件密文。旧实例容器、数据、密钥与既有备份均保留。

在受限独立目录记录备份文件的 SHA-256、时间、源 SHA 和镜像身份；核对源数据停写、一致性和磁盘空间。不能只比较文件数量。将备份恢复到隔离目录、隔离数据库/卷，使用原密钥验证 `.plbackup` 和数据库可恢复、所有数据库引用的附件可解密且明文哈希/长度正确、账号（含停用）与笔记/附件 ID、引用及摘要一致。不要用生产库做恢复演练，不生成新密钥覆盖旧密钥。

本地密文镜像是现有备份/恢复的完整来源；R2 故障不应让原备份不可用。本地恢复完成后仍须按下一节重新 sync 并读回核对，才能宣布云端媒体恢复完成。保持备份和原配置可恢复，记录实际恢复演练证据与限制，不以单元测试代替现场恢复验收。

## 4. inventory → dry-run → 单账号 apply

以下命令只在授权部署/恢复窗口运行，当前代码任务不得执行生产上传。确认应用容器名为本工具的 `process-log`，所有路径均对应表中受限挂载，`DATABASE_URL` 已由该容器原有安全配置提供。输出不含文件名/笔记正文/凭据，但仍属于受限账号清单；宿主机运行 `umask 077`，把 stdout manifest 和 stderr 审计日志保存到预先创建的专用受限目录，不在共享日志中展示。使用不同文件名保留每次运行证据，不覆盖之前清单。

```bash
# Bash；此函数不读取或显示任何凭据值。
reconcile() {
  docker exec --user 1000:1000 process-log python r2_reconcile.py "$@" \
    --auth-db /auth/auth.db --attachments-root /attachments \
    --key-file /run/secrets/storage.key
}
reconcile inventory
```

`inventory` 默认只读，列出全部认证账号，包括停用和未初始化账号；不创建缺失 schema，不实例化 Store 来探测账号。未初始化账号保留完整认证记录，不对其运行 sync/prune apply，也不为了消除 `account_unavailable` 创建 schema；逐个处理已初始化账号，单独记录未初始化状态。PostgreSQL 附件根是 `/attachments`，其它账号位于 `/attachments/accounts/<storage_id>`；SQLite 的根必须是 `<data>/attachments`，其它账号位于 `<data>/accounts/<storage_id>`。不能把 PostgreSQL 的路径规则用于 SQLite。

操作者从已核对的认证清单选定单个 `storage_id`（`owner` 或 32 位小写十六进制 ID），禁止根据浏览器输入选择。先设置 `verified_storage_id` 为该账号，检查非空与格式后 dry-run：

```bash
[[ -n "${verified_storage_id:-}" ]] || exit 1
[[ "$verified_storage_id" == owner || "$verified_storage_id" =~ ^[a-f0-9]{32}$ ]] || exit 1
reconcile sync --storage-id "$verified_storage_id" --bucket sanyulog-media
# 仅在审阅 dry-run、备份/恢复门禁和账号范围后，明确批准本次写入：
reconcile sync --storage-id "$verified_storage_id" --bucket sanyulog-media --apply
# 再次只读核对；保存该次 manifest 与退出码。
reconcile sync --storage-id "$verified_storage_id" --bucket sanyulog-media
```

未传 `--apply` 不上传、不删对象。apply 必须显式指定单个经实时认证库存核对的账号和精确专用桶，序列化旧 manifest 不是写入/删除授权。逐对象验证密文 SHA-256、大小、元数据、读回内容和使用原密钥解密后的明文哈希/长度；ETag 不当作 SHA-256。上传 key 为 `v1/<storage_id>/<plaintext_sha256>`，内容类型固定 `application/octet-stream`，已有 key 不覆盖，明文相同而随机 nonce 不同可幂等复用经验证的对象。

退出码 `0` 仅表示本命令 complete；`inventory` 的 complete 仅表示本地清单通过，`cloud_verified` 始终为 false。退出码 `2` 表示未完成（包括 dry-run 发现待上传/待清理、缺失或损坏）；`1` 为验证/访问错误；CLI 参数不合法也会返回 `2`，须结合输出判断。任何错误/未完成都不能当作云端恢复成功。

单文件明文上限仍为 25 MiB。历史超限附件被标记 `oversize`、保持未同步且使对账不完整；不得删除、截断、自动压缩、强行上传或把它算作已迁移。先保留本地数据与备份，报告阻塞项并请求单独方案。

## 5. 中断恢复与精确 GC

运行中断后不凭超时推断成功；保留 `run_id`、时间、状态和受限日志，重跑同账号 dry-run，重新读取实时 DB 引用和本地/R2 差异，再按授权 apply。现有对象先验签/读回，不能通过覆盖冲突对象修复错误。数据库引用、本地文件、R2 当前差异是持久待办来源，不依赖内存队列；恢复本地状态并不代表云端完成。

删除 API 立即撤销数据库引用，旧附件 ID 不能继续读取。仅当该账号实时 DB 已无同哈希引用时才可物理清理；共享哈希仍有引用就保留。GC 先核对可靠备份、账号范围和 dry-run，再单独授权：

```bash
[[ -n "${verified_storage_id:-}" ]] || exit 1
[[ "$verified_storage_id" == owner || "$verified_storage_id" =~ ^[a-f0-9]{32}$ ]] || exit 1
reconcile prune --storage-id "$verified_storage_id" --bucket sanyulog-media
# 明确审核本次删除清单后才执行：
reconcile prune --storage-id "$verified_storage_id" --bucket sanyulog-media --apply
```

apply 在写入锁/数据库事务保护下重新读取引用，完整验证专用桶内 `v1/<storage_id>/` 列举后才删除；不跨账号、不跨桶、不递归本地目录、不跟随链接、不删临时/未知命名文件。审计记录 `prune_intent`、`pruned` 或失败状态，失败留待下次 dry-run 重现；中断后必须重新核对。不要手工全桶清空，也不要用“目录没有 DB 记录”作为删除其他账号的授权。物理删除通常不可恢复，只能从已验证备份恢复，因此禁止跳过备份门禁。

## 6. 降级、回滚与交接

R2 读取失败/缺失/损坏时，只从已授权同账号的本地密文回退，并重新验签、核对明文哈希/长度，产生不含秘密的降级告警；双副本都无法验证则拒绝返回。R2 上传失败不向用户报告成功；保留本地暂存孤儿供受限 GC，不改变已有附件引用。开启 R2 时不能把“读取可回退”误解为“断网仍可成功上传”。

如需 local-only 降级，先停写，确认所有有效附件在本地且验证通过、备份可恢复，再从专属部署配置同时移除三个 R2 变量后重启；空字符串不等于移除。保留原始加密密钥、数据库与认证挂载。local-only 期间新增/删除导致云端差异，重新启用前重复单账号 dry-run→apply 与云端核对。

正式 DNS/入口切换前任何镜像、配置、数据、R2 或 HTTPS 验收失败，保留旧实例数据，隔离新服务，不开放新站写入。切换后默认旧实例保持停写且可恢复，禁止双主。若首尔已接收新写入，不能直接启动旧实例并切回 DNS：先停写首尔、完整备份并核对增量，明确合并方案或取得接受数据回退的授权。回滚保留首尔卷、R2 桶、清单和备份，不运行 `docker compose down -v` 或删除桶，不触及其它服务。

交接给首尔迁移执行者：精确 SHA 与成功 Checks、镜像身份/构建清单、受限配置文件路径与权限验证、备份哈希及隔离恢复证据、含停用账号的数据清单、逐账号 R2 读回核对、未登录/跨账号拒绝、Host/Origin、HTTPS 与媒体 Range 验收、其它服务健康、明确回滚窗口和未完成项。代码已提交、CI 已通过、镜像已构建、现场已部署、数据迁移已验收是不同状态，必须分别报告。
