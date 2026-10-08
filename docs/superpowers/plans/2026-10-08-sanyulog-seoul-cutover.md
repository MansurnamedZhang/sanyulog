# 三余记首尔部署与 R2 迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在首尔服务器以 `notes.896364.xyz` 发布通过精确 GitHub Checks 的三余记版本，迁移全部账号与数据，将有效媒体密文核对后放入专用私有 R2 桶，并保留源站和可验证回滚路径。

**Architecture:** 首尔新增独立 Docker 应用、PostgreSQL、受限本地 auth/附件/密钥挂载和宿主机 Nginx HTTPS；R2 只存本工具附件密文。源局域网实例先完整备份再短暂停写，迁移核对后保留但停止，避免双写。所有新资源与现有 AFFiNE、Nextcloud、Teleport、Infisical 等服务隔离。

**Tech Stack:** Ubuntu 24.04、Docker Compose、PostgreSQL 16、Python 3.12 镜像、Nginx、Certbot、Cloudflare DNS/R2、SSH/SCP、SHA-256、`pg_dump` / `pg_restore`。

**Spec:** `docs/superpowers/specs/2026-10-08-seoul-r2-hybrid-deployment-design.md`

**Dependency:** `docs/superpowers/plans/2026-10-08-sanyulog-private-r2-media.md` 的代码任务全部完成，精确提交已推送且对应 GitHub Checks 为 success。未满足时只做预检，不部署生产数据。

## Global Constraints

- 源实例为 `172.16.240.13:8765` 的 `process-log` 容器；不要删除或覆盖其数据库、auth、附件、加密密钥、Compose 或备份。停写只可在用户确认的维护窗口进行，切换后保留源容器但默认停止。
- 首尔目标为 `43.131.245.43`，站点 `notes.896364.xyz`；新项目根 `/home/ubuntu/apps/sanyulog`，备份根 `/home/ubuntu/backups/sanyulog`，Nginx 站点 `/etc/nginx/sites-available/notes.896364.xyz.conf`，应用只映射 `127.0.0.1:18765:8765`，PostgreSQL 不发布宿主机端口。执行前对每个路径和端口重新查重。
- 2026-10-08 只读发现的 Cloudflare account ID 为 `0910a2f37a347c249c2dce42169b9b65`、`896364.xyz` zone ID 为 `67edc27e351abaa1eee7d945a5b0b0f8`；这只是预期身份，所有外部写入前必须重新核对。
- 专用 R2 桶名 `sanyulog-media`；禁止 `r2.dev`、自定义对象直出域名、公共读和浏览器直连。R2 凭据仅限此桶对象读写；从受限只读文件注入，不打印或通过聊天传递值。
- 完整迁移包括 PostgreSQL 数据库、全部账号（含停用及未建 schema 账号）、会话、auth.db、配置、原始 32 字节密钥、所有被数据库引用的本地附件及其加密格式；不把数据库/auth/密钥上传 R2。
- 不改变其它 Cloudflare 桶、DNS 记录、Nginx 站点、容器或卷。任何校验失败即停止切换，保留现有状态用于诊断；不使用 `docker compose down -v`、`git reset --hard` 或宽路径删除。
- 切换后新域名的 Cookie 需用户重新登录，原密码哈希及服务器会话记录必须保持；生产验收不得为了测试创建真实用户笔记或附件。

## Review Focus

1. 源站快照中账号数与已初始化 schema 数不同：停用但未初始化账号仍迁移，不能因缺 schema 创建或丢弃账号（Task 4）。
2. 源容器停止后还有新写入或备份前后附件/数据库不一致：不得继续上传或切换，须重新取得一致快照（Task 4）。
3. Cloudflare 账号、zone、桶或证书指向错误资源：不得借用其它桶/域名，不能以 Cloudflare Edge 的 200 代替源站核验（Tasks 1–2、6）。
4. R2 对象数正确但密文不一致、缺账号前缀、公开桶可读：不得宣称迁移成功（Task 5）。
5. 切换后首尔新增写入而回滚旧站：不得直接切 DNS 或启动源容器，必须先停写并处理增量（Task 6）。

## File Map

- `ops/seoul/docker-compose.yml`：新应用与独立 PostgreSQL、专用网络/卷、loopback 端口、健康检查和只读密钥挂载；无真实凭据。
- `ops/seoul/notes.896364.xyz.conf`：维护页和最终 HTTPS 代理模板，保留证书及原始 Host/Proto。
- `ops/seoul/preflight.ps1`、`ops/seoul/snapshot-source.ps1`、`ops/seoul/verify-migration.ps1`：Windows 控制端的只读预检、一致快照与跨主机哈希核对；秘密内容只在受限目录。
- `ops/seoul/tests/preflight.tests.ps1`、`config.tests.ps1`、`snapshot-source.tests.ps1`、`verify-migration.tests.ps1`：使用本地假数据运行，不连接生产或打开真实凭据。
- `ops/seoul/README.md`：维护窗口、备份、R2 凭据安全交付、切换与回滚手册。
- `ops/seoul/evidence/<date>/`：忽略 Git 的最小证据和哈希清单，不含明文秘密或用户附件正文。
- 服务器运行时文件：`/home/ubuntu/apps/sanyulog/secrets/`、`/home/ubuntu/backups/sanyulog/`；不得提交 Git。

---

### Task 1: 精确发布基线与隔离预检

**Files:**
- Create: `ops/seoul/preflight.ps1`
- Create: `ops/seoul/tests/preflight.tests.ps1`
- Create: `ops/seoul/README.md`
- Modify: `.gitignore`（仅排除本项目证据和运行时秘密）

**Interfaces:**
- Consumes: 代码计划产出的 Git SHA、Checks 结果、镜像和 `r2_reconcile.py`。
- Produces: 时间戳化、无秘密的 preflight manifest：提交/Checks、两台主机服务与资源、既有端口/站点/DNS/R2 桶列表、源数据计数、目标未占用路径。

- [ ] **Step 1: 写失败预检测试**：本地假数据验证“Checks 未成功、目标域名/端口/目录已占用、源备份不可读、目标资源不足、Cloudflare 账号或 zone 不符”均拒绝进入部署；真实运行前只读探测不改变服务器。
- [ ] **Step 2: 运行 RED**：`pwsh -NoProfile -File ops/seoul/tests/preflight.tests.ps1`，预期因预检函数缺失失败；不得把失败当成可部署信号。
- [ ] **Step 3: 实现预检**：使用 `git rev-parse`、`gh run view`、只读 SSH、Cloudflare 查询、`docker ps/inspect`、`nginx -t`、`df/free/ss` 与源站 `/api/health`；输出不含 DATABASE_URL、Cookie、密钥、用户数据。仅精确 SHA 的 Checks=success 可放行。
- [ ] **Step 4: 运行 GREEN**：同一 PowerShell 测试通过；两台主机实际只读预检通过，保存被核实的占用清单与基线哈希。若缺少权限/容量，停在此处。
- [ ] **Step 5: 提交**：仅提交脚本、手册和 `.gitignore` 的精确改动，信息 `ops: add Sanyu Seoul preflight gates`。

### Task 2: 专用私有 R2 与首尔 HTTPS 维护入口

**Files:**
- Create: `ops/seoul/docker-compose.yml`
- Create: `ops/seoul/notes.896364.xyz.conf`
- Create: `ops/seoul/tests/config.tests.ps1`
- Modify: `ops/seoul/README.md`

**Interfaces:**
- Consumes: Task 1 的 account/zone/桶/端口/站点空闲结论。
- Produces: 专用 `sanyulog-media` 桶、受限 R2 凭据文件、首尔独立数据库和应用测试入口；公网域名在数据验收前只显示维护页。

- [ ] **Step 1: 写配置契约测试**：Compose 精确服务、网络、卷、`127.0.0.1:18765`、auth/附件/根密钥/R2 凭据只读挂载；Nginx 站点不代理到其它应用；不存在公开桶配置或明文秘密。
- [ ] **Step 2: 运行 RED**：`pwsh -NoProfile -File ops/seoul/tests/config.tests.ps1` 因文件缺失失败；同时重查 R2 桶与站点不存在。不得覆盖现有对象。
- [ ] **Step 3: 安全创建资源**：先建独立私有 R2 桶，验证 managed/custom public domains 均未启用；生成或由用户在 Cloudflare 控制台创建仅此桶 Object Read+Write 的账号令牌。若连接器无法直接把一次性秘密安全地写入服务器受限文件，暂停并让用户通过自己的 SSH/Teleport 会话写入 `/home/ubuntu/apps/sanyulog/secrets/r2.json`（普通文件、`0600`、容器 UID 可读）；不得在工具输出显示秘密。以隔离测试前缀验证 PUT/HEAD/GET/DELETE，然后只清理精确测试对象。
- [ ] **Step 4: 首尔隔离启动与 TLS**：先快照将修改的 Nginx 站点配置；创建仅本项目的数据库卷和网络，使用通过 Checks 的镜像；启动本地服务，以测试数据验证 `/api/health`、账号隔离和 R2 镜像。创建 `notes.896364.xyz` DNS/证书时，公网仍只显示维护页；`sudo nginx -t` 成功后才 reload。若证书失败，不关闭 TLS 校验或暴露 loopback 服务。
- [ ] **Step 5: 运行 GREEN 并记录**：同一 PowerShell 配置测试、`docker compose config --quiet`、容器健康、私有桶匿名拒绝、TLS 和维护页检查通过；保存资源 ID/摘要，不保存令牌值。仅提交本任务无秘密文件，信息 `ops: stage isolated Sanyu Seoul stack`。

### Task 3: 源站一致快照与受限传输

**Files:**
- Create: `ops/seoul/snapshot-source.ps1`
- Create: `ops/seoul/tests/snapshot-source.tests.ps1`
- Modify: `ops/seoul/README.md`

**Interfaces:**
- Consumes: Task 1 基线、Task 2 目标隔离资源和用户确认的维护窗口。
- Produces: 原站停写时的可恢复快照、SHA-256 manifest 和首尔同字节受限副本；源实例未删除。

- [ ] **Step 1: 写失败快照测试**：源容器仍接收写入、文件/目录为符号链接、根密钥缺失、auth.db 与附件未全量包含、pg_dump 非目标库、哈希不一致时必须拒绝；不得对这些失败执行恢复或 DNS 切换。
- [ ] **Step 2: 运行 RED**：`pwsh -NoProfile -File ops/seoul/tests/snapshot-source.tests.ps1` 因缺脚本失败；维护窗口未确认时仅允许预检，不停止源容器。
- [ ] **Step 3: 实现并执行快照**：在用户确认的短暂停写窗口，停仅 `process-log` 容器；对其专属 PostgreSQL 数据库作一致 `pg_dump`，打包精确 `auth.db`、全部账号附件、`state`、Compose 和原 `storage.key`，创建 `0700` 备份目录与 `0600` 文件，逐项检查清单和哈希。旧 PostgreSQL/其它容器照常运行。通过 SSH/SCP 经当前 Windows 用户+SYSTEM ACL 的临时目录传到首尔，仅在两端哈希一致后清理传输暂存；源备份长期保留。
- [ ] **Step 4: 运行 GREEN**：同一 PowerShell 快照测试通过；检查 PostgreSQL dump 可列出、归档成员白名单、密钥大小 32 字节、auth 用户/会话摘要、每个附件密文 SHA-256 与权限；源站数据不被删除。任何失败都先恢复源容器并停止迁移。
- [ ] **Step 5: 提交**：仅提交无秘密的脚本和手册，信息 `ops: add consistent Sanyu migration snapshot`。

### Task 4: 首尔恢复与私有 R2 媒体迁移

**Files:**
- Create: `ops/seoul/verify-migration.ps1`
- Create: `ops/seoul/tests/verify-migration.tests.ps1`
- Modify: `ops/seoul/README.md`

**Interfaces:**
- Consumes: Task 3 的 manifest/备份；代码计划的 `r2_reconcile.py`。
- Produces: 首尔隔离数据库/auth/密钥/本地附件和专用桶中逐对象可验证的密文镜像。

- [ ] **Step 1: 写失败迁移测试**：账号或会话哈希、数据库归一化内容、附件引用/密文 SHA-256/R2 读回摘要任一不一致，以及 R2 公开可读、停用账号被遗漏，均不得标记通过。
- [ ] **Step 2: 运行 RED**：`pwsh -NoProfile -File ops/seoul/tests/verify-migration.tests.ps1` 因验证脚本缺失失败。
- [ ] **Step 3: 恢复与同步**：仅在新 PostgreSQL 数据库中导入源 dump，安装原 auth.db 和 32 字节根密钥到受限挂载；同步所有账号本地密文。运行 `r2_reconcile.py inventory` dry-run，核对数据库有效引用与本地清单；只对 `sanyulog-media/v1/<storage_id>/` 执行 `sync --apply`，不得迁移本地孤儿、其它项目文件、auth、数据库或密钥。逐对象 HEAD 与 GET 读回计算密文 SHA-256，再用原密钥验证明文哈希/大小。
- [ ] **Step 4: 运行 GREEN**：同一 PowerShell 验证测试通过；迁移前后账号（含停用）、会话、项目、笔记、附件数量及归一化摘要相同；R2 仅有本工具的有效媒体对象，清单数量/字节/哈希完全一致；未登录私有 API 为 401、跨账号访问被拒绝；通过首尔本地服务和隔离恢复验证。
- [ ] **Step 5: 提交**：仅提交无秘密的验证脚本和手册，信息 `ops: verify Sanyu account and R2 migration`。

### Task 5: HTTPS 切换、人工登录与回滚封存

**Files:**
- Modify: `ops/seoul/README.md`
- Runtime evidence only: `ops/seoul/evidence/<date>/`（Git 忽略）

**Interfaces:**
- Consumes: Tasks 1–4 全部通过的证据；用户对新域名登录的确认。
- Produces: 正式可用的 `https://notes.896364.xyz`、受限首尔备份和明确的回滚状态；源容器保留但停止。

- [ ] **Step 1: 切换前 RED 检查**：维护页仍启用时正式域名不得接受业务写入；任何源/目标数据差异、R2 未同步、证书不可信、其它容器不健康都阻止放行。
- [ ] **Step 2: 启用新站**：确认首尔镜像精确 SHA/健康、数据库与私有桶校验后，`nginx -t` 再把该站点从维护页切到 loopback 代理，核对 Cloudflare DNS 仅改 `notes.896364.xyz`；不修改其它 DNS 记录。记录切换时间与源站停止状态。
- [ ] **Step 3: 真实验收**：从公网核对 HTTPS、登录页、未登录 `/api/state`/`/api/backup`/`/api/attachments/*` 为 401、错误 Host/Origin 拒绝、账号隔离、现有图片预览、音视频隔离 fixture 的 Range 行为、用户本人重登成功和保存/读取；浏览器 Cookie 需要按新域名重新登录。不得在生产用户笔记中创建测试内容。
- [ ] **Step 4: 备份与回归**：首尔专属 PostgreSQL、auth、密钥、附件、本项目 Compose/Nginx 和 R2 manifest 生成受限备份，复制至少一份离机并校验恢复材料；再次检查 AFFiNE、Nextcloud、Teleport、Infisical 等既有服务、Nginx、Docker OOM/restart、内存/Swap/磁盘以及 R2 匿名拒绝。
- [ ] **Step 5: 记录回滚与结束条件**：若目标无新增写入，可先停首尔业务，再恢复源容器并切回精确 DNS；若已有新增写入，必须先导出/核对增量，不能直接回滚。交付精确提交、Checks URL、镜像摘要、入口、账号/数据/对象清单和哈希、备份路径、未测项目。仅在这些证据全部成立时报告“已验收”。
