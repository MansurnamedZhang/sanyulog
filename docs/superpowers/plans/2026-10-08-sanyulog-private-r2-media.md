# 三余记私有 R2 媒体适配 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变附件 ID、账号隔离、AES-GCM 密文格式和现有本地备份语义的前提下，为三余记增加私有 R2 密文镜像、受控读取、对账与安全媒体预览。

**Architecture:** 本地加密文件是可恢复的持久副本，R2 是独立私有密文镜像且优先提供读取。服务器负责会话与账号归属校验、R2 读写和降级回退；浏览器永不接触 R2 凭据或对象 URL。迁移对账工具只扫描本工具数据库引用与受限目录，不向其它桶或账号前缀写入。

**Tech Stack:** Python 3.12、现有 `Store` / `PostgreSQLStore`、`boto3==1.43.109`、Cloudflare R2 S3 API、原生 HTTP/JS、`unittest`、Node 测试与 GitHub Checks。

**Spec:** `docs/superpowers/specs/2026-10-08-seoul-r2-hybrid-deployment-design.md`

## Global Constraints

- 保持现有 25 MiB 单文件上传上限、250 MiB 完整备份上限、七天会话、`X-Process-Log-Account` 账号校验、`StorageCipher` 的 `PROCESSLOG-AESGCM-1\x00` 密文及 `attachment:<plaintext_sha256>` AAD 不变。
- R2 桶固定为私有 `sanyulog-media`；对象 key 为 `v1/<storage_id>/<plaintext_sha256>`，Content-Type 固定 `application/octet-stream`，不启用公开 URL、客户端预签名 URL 或通配 CORS。
- 仅从受限凭据文件加载 R2 Access Key ID 与 Secret Access Key；不把值写进代码、Compose 明文环境、测试快照、日志或错误响应。文件在 Linux 必须是普通文件、非符号链接、`0600`。
- 源端和目标端均保留本地加密文件；R2 失败不能使备份失效，上传失败不得返回成功；解密和 SHA-256 校验失败不得返回内容。
- 不改变现有数据库附件记录结构和认证库格式，不删除已有本地附件或账号数据。迁移、GC 与测试不得处理其它项目的 R2 桶。
- 每个代码任务遵循 RED→GREEN；最终运行 `python -m unittest discover -s tests -v`、`npm run check`、`npm run format:check`、`npm test`、`npm run test:ui` 和 `git diff --check`。发布必须等待精确提交的 GitHub Checks 成功。

## Review Focus

1. 同一明文哈希但不同加密 nonce 的对象：只在明文一致时复用或替换，绝不把不同明文当同一对象（Task 1 测试）。
2. 上传过程中 R2 PUT、HEAD 或数据库 INSERT 失败：用户看不到成功，重试幂等，本地/R2 孤儿不可访问（Task 2 测试）。
3. 被停用或未初始化账号、错误 `storage_id`、跨账号相同哈希：不得创建新 schema、泄露或删除其它账号对象（Task 3 测试）。
4. 删除记录/项目时的级联引用、同账号共享哈希和 R2 短暂故障：API 访问立即撤销，物理清理只能限定前缀且可重试（Task 3 测试）。
5. 错误、多个、后缀和超界 Range，以及伪造视频/音频 MIME：不返回未授权字节、不内联主动内容（Task 4 测试）。

## File Map

- `r2_media.py`：私有 S3 客户端、受限凭据加载、对象 key 与密文校验；不处理用户登录或数据库。
- `store.py` / `pgstore.py` / `account_stores.py`：把既有本地加密附件接入镜像，保持数据库、账号、备份和恢复语义。
- `r2_reconcile.py`：从只读认证库、数据库引用和附件根构建清单，幂等同步和受限 GC；默认 dry-run。
- `server.py`、`static/notebook.js`、`static/notebook-export.mjs`：运行时配置、受控媒体 Range/预览及前端呈现。
- `tests/test_r2_media.py`、`tests/test_r2_store.py`、`tests/test_r2_reconcile.py`、`tests/test_http.py`、`tests/notebook.test.mjs`：故障、加密、隔离、备份和 HTTP/UI 回归。
- `requirements.txt`、`Dockerfile`、`docs/r2-operations.md`：固定依赖、镜像与恢复/对账运维说明；不得包含真实凭据。

---

### Task 1: 私有 R2 密文客户端与配置

**Files:**
- Create: `r2_media.py`
- Create: `tests/test_r2_media.py`
- Modify: `requirements.txt`

**Interfaces:**
- Produces: `R2Credentials.load(path: Path) -> R2Credentials`，`R2Mirror(client, bucket: str)`，`object_key(storage_id: str, digest: str) -> str`，`R2Mirror.put_ciphertext(storage_id, digest, ciphertext, cipher) -> None`，`get_ciphertext(storage_id, digest) -> bytes`，`delete_ciphertext(storage_id, digest) -> None`。
- `R2Mirror` 只接收注入的 S3 客户端；`create_r2_client(account_id, credentials)` 使用 `https://<account_id>.r2.cloudflarestorage.com`、`region_name="auto"` 与有界超时。凭据文件为只含 `access_key_id`、`secret_access_key` 的 JSON。

- [ ] **Step 1: 写失败测试**：`tests/test_r2_media.py` 覆盖合法 owner/32 位十六进制账号与 64 位 SHA-256、路径穿越拒绝、凭据权限/符号链接拒绝、PUT→HEAD→GET 密文 SHA-256/长度一致、已有对象明文相同但 nonce 不同、已有对象内容冲突拒绝、SDK 错误不泄漏凭据。
- [ ] **Step 2: 运行 RED**：`python -m unittest discover -s tests -p 'test_r2_media.py' -v`；预期因模块/接口缺失失败，而非环境导入错误。
- [ ] **Step 3: 实现接口**：在 `requirements.txt` 固定 `boto3==1.43.109`；`r2_media.py` 对服务器已加密 blob 计算并核对密文 SHA-256 元数据，使用原 `StorageCipher` 验证明文哈希；不把 S3 ETag 当作 SHA-256。[PyPI 发布记录](https://pypi.org/project/boto3/1.43.109/)、[R2 boto3 用法](https://developers.cloudflare.com/r2/examples/aws/boto3/)
- [ ] **Step 4: 运行 GREEN 与基础回归**：目标测试通过；`python -m unittest discover -s tests -v` 通过。
- [ ] **Step 5: 提交**：仅提交这三个文件，信息 `feat: add private R2 ciphertext client`。

### Task 2: 账号分区的上传、读取与本地回退

**Files:**
- Modify: `store.py`
- Modify: `pgstore.py`
- Modify: `account_stores.py`
- Modify: `server.py`
- Create: `tests/test_r2_store.py`
- Modify: `tests/test_multiaccount_http.py`

**Interfaces:**
- Consumes: Task 1 的 `R2Mirror`。
- Produces: `Store(..., media_mirror=None, storage_id='owner')`、`PostgreSQLStore(..., media_mirror=None, storage_id='owner')`；`AccountStores` 从已认证 principal 的 `storage_id` 选择对应镜像前缀。未配置 R2 时保持旧行为。

- [ ] **Step 1: 写失败测试**：加密上传在 R2 确认前不插入附件记录；PUT/HEAD/INSERT 故障不报告成功；同内容重试不会产生重复可见数据；R2 读取优先且校验明文 SHA-256/大小；R2 缺失、超时或损坏仅从同账号本地镜像回退且重新校验；双副本坏数据拒绝；跨账号附件 ID 和哈希隔离。
- [ ] **Step 2: 运行 RED**：`python -m unittest discover -s tests -p 'test_r2_store.py' -v` 与 `python -m unittest discover -s tests -p 'test_multiaccount_http.py' -v`；预期新增用例因缺少镜像接线或行为而失败。
- [ ] **Step 3: 最小实现**：将 `Store.add_attachment/read_attachment` 的本地密文写入与解密校验挂入 `R2Mirror`；`PostgreSQLStore` 沿用同一逻辑；`server.make_server` 从 `PROCESS_LOG_R2_ACCOUNT_ID`、`PROCESS_LOG_R2_BUCKET`、`PROCESS_LOG_R2_CREDENTIALS_FILE` 装配镜像，不允许只配置部分字段。不得实例化账号 Store 来探测停用用户。
- [ ] **Step 4: 运行 GREEN 与回归**：目标用例及 `python -m unittest discover -s tests -v` 通过；验证未配置 R2 的旧实例测试不变。
- [ ] **Step 5: 提交**：仅提交本任务文件，信息 `feat: mirror account media to private R2`。

### Task 3: 可审计的清单、恢复对账与无引用清理

**Files:**
- Create: `r2_reconcile.py`
- Create: `tests/test_r2_reconcile.py`
- Modify: `store.py`
- Modify: `pgstore.py`
- Modify: `tests/test_encryption.py`

**Interfaces:**
- Consumes: Task 1 对象接口与 Task 2 的账号前缀/本地镜像。
- Produces: `build_inventory(auth_db, database_url, attachments_root, key_file) -> list[MediaItem]`、`sync_inventory(items, mirror, *, apply=False) -> SyncReport`、`prune_unreferenced(items, mirror, *, apply=False) -> PruneReport`。命令行 `python r2_reconcile.py inventory|sync|prune` 默认 dry-run；`--apply` 只接受预先校验的当前账号、对象 key 和专用桶。

- [ ] **Step 1: 写失败测试**：遍历全部账号（含停用）而不创建缺失 schema；只按数据库附件引用生成清单，拒绝孤儿、符号链接、路径越界和文件哈希不符；中断后重复同步不覆盖不同明文；恢复后对账补齐 R2；记录删除和项目级联删除后不再可读；共享哈希有引用时不删；GC 失败可在下次 dry-run 中重现，并只触及 `v1/<storage_id>/`。
- [ ] **Step 2: 运行 RED**：`python -m unittest discover -s tests -p 'test_r2_reconcile.py' -v`；预期因接口缺失失败。
- [ ] **Step 3: 最小实现**：只读连接枚举 `auth.db`、PostgreSQL/SQLite 的已存在数据区和本地附件；输出不含文件名明文、密钥或笔记内容的受限 manifest。`Store` 与 `PostgreSQLStore` 删除/恢复后触发待对账状态，物理清理依赖经核对的无引用扫描；本地备份继续读取本地密文，R2 未同步完成时不得标记云端恢复完成。
- [ ] **Step 4: 运行 GREEN 与回归**：目标用例、`tests/test_encryption.py`、`tests/test_pgstore.py` 及完整 Python suite 通过。
- [ ] **Step 5: 提交**：仅提交本任务文件，信息 `feat: reconcile encrypted media and scoped cleanup`。

### Task 4: 受控图片/音视频预览与 HTTP Range

**Files:**
- Modify: `server.py`
- Modify: `static/notebook.js`
- Modify: `static/notebook-export.mjs`
- Modify: `tests/test_http.py`
- Modify: `tests/test_auth_http.py`
- Modify: `tests/notebook.test.mjs`

**Interfaces:**
- Consumes: Task 2 `Store.read_attachment(id) -> (metadata, plaintext)`。
- Produces: `Handler.send_attachment(metadata, content, *, preview: bool, range_header: str | None) -> None`；所有 `GET /api/attachments/<id>` 先经会话/归属验证，再解析最多一个字节区间。

- [ ] **Step 1: 写失败测试**：未登录/跨账号即使带 Range 也返回 401；图片继续安全内联；仅受支持且内容签名相符的 MP4/WebM/MP3/Ogg/WAV 可预览；`bytes=0-3`、后缀区间、超界及多区间分别得到规范的 `206`/`416`，并有正确 `Content-Range`、`Accept-Ranges`、长度与 `no-store`；HTML/SVG/伪 MIME 只能下载；Notebook 与导出页使用同源受控链接。
- [ ] **Step 2: 运行 RED**：`python -m unittest discover -s tests -p 'test_http.py' -v`、`python -m unittest discover -s tests -p 'test_auth_http.py' -v`、`npm test`；预期新增用例失败。
- [ ] **Step 3: 最小实现**：在 `server.py` 用经过数据库授权的明文字节实现单区间返回，保留现有安全响应头与 `Content-Disposition`；`static/notebook.js` 和 `static/notebook-export.mjs` 对已白名单媒体使用 `<audio>/<video>`，其它类型保持下载；不加转码或公共缓存。
- [ ] **Step 4: 运行 GREEN 与浏览器回归**：Python 目标用例、`npm test` 和 `npm run test:ui` 通过；使用隔离测试数据验证浏览器媒体控件，不写生产笔记。
- [ ] **Step 5: 提交**：仅提交本任务文件，信息 `feat: add authenticated media preview and ranges`。

### Task 5: 运维契约、完整回归与可发布提交

**Files:**
- Create: `docs/r2-operations.md`
- Modify: `Dockerfile`（仅在新增模块未被 COPY 时补入）
- Modify: `.github/workflows/checks.yml`（仅在现有 Checks 未覆盖新增测试时补入）
- Test: `tests/test_deployment.py`

**Interfaces:**
- Consumes: Tasks 1–4 的配置、对账、HTTP 与测试。
- Produces: 可按精确提交构建的镜像和不含凭据的部署/恢复 runbook；交给首尔迁移计划使用。

- [ ] **Step 1: 写失败契约测试**：镜像包含 `r2_media.py`、`r2_reconcile.py`；不包含凭据；未配置 R2 的旧部署仍能启动；启动时部分 R2 配置拒绝；公开 API 不输出桶密钥；受限配置项在 runbook 中有可验证的路径和权限。
- [ ] **Step 2: 运行 RED**：`python -m unittest discover -s tests -p 'test_deployment.py' -v`；预期新契约未满足。
- [ ] **Step 3: 补足镜像与说明**：文档写明专用桶/最小权限、`0600` 凭据文件、dry-run→apply 对账、备份恢复、降级与回滚；只按测试缺口调整 Dockerfile/Checks。
- [ ] **Step 4: 全量验证**：`python -m unittest discover -s tests -v`、`npm run check`、`npm run format:check`、`npm test`、`npm run test:ui`、`docker build -t sanyulog:r2-check .` 和 `git diff --check` 全部成功；核对服务无 R2 配置时兼容旧行为。
- [ ] **Step 5: 提交并通过 Checks**：提交任务文件，推送经授权分支/提交；仅在 GitHub Checks 对该精确 SHA 为 success 后把 SHA、镜像摘要和构建清单交给首尔部署计划。不得因为“已提交”而声称“已部署”。
