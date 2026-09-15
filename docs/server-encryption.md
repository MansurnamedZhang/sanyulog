# 服务器托管加密

设置 `PROCESS_LOG_ENCRYPTION_KEY_FILE` 后，服务器使用 AES-256-GCM 加密存储。
未设置时保持旧版明文模式；已经加密的数据库缺少或使用错误密钥时拒绝启动。

## 保护范围

- SQLite / PostgreSQL：项目名称、笔记标题/状态/目标/参数/标签/结论、时间线、全部单元格、工作空间与模板配置、附件名称和 MIME 类型。
- 附件文件内容，以及通过完整备份接口生成的 `.plbackup` 文件。
- ID、时间、版本号、关联关系、附件大小及内容哈希文件名仍为明文元数据。

服务器持有解密密钥，浏览器仍收到正文；此功能不增加登录、分享密码或访问控制，也不替代 HTTPS。
主动导出的 Markdown、PNG、PDF 是明文。已下载文件、原有备份、服务器快照和 PostgreSQL WAL/旧数据页不会被追溯加密。

## 密钥与 Docker 配置

密钥是随机生成的 **32 字节二进制文件**，不是登录密码。只生成一次，不能在每次部署时重新生成。
在独立于数据目录和 Git 仓库的位置生成，例如在已创建并限制访问的 secrets 目录执行：

```sh
python -c "import os; p='storage.key'; f=os.open(p, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600); os.write(f, os.urandom(32)); os.close(f)"
```

确保容器应用用户可读取密钥；限制其他用户访问。在现有 app 服务中合并以下设置：

```yaml
services:
  app:
    environment:
      PROCESS_LOG_ENCRYPTION_KEY_FILE: /run/secrets/process_log_storage_key
    secrets:
      - process_log_storage_key
secrets:
  process_log_storage_key:
    file: /absolute/private/path/storage.key
```

密钥不得写入镜像、仓库、日志或普通数据备份。另行保管至少一份离线密钥副本；仅有数据备份、没有原始密钥无法恢复。
第一版不提供密钥轮换；不要直接替换或删除密钥文件。

## 迁移与回滚

1. 停止所有应用写入，备份原数据库、附件、应用版本和部署配置，核验备份可用。
2. 配置独立密钥文件，只启动一个应用实例。首次启动在事务中转换数据库字段，随后以原子替换方式转换附件。SQLite 清理当前数据库空闲页；磁盘快照和历史备份仍需另外管理。
3. 若中途中断，使用同一密钥重启；数据库迁移已完成的标记会防止重复转换，附件逐个检查并继续。
4. 对比迁移前后的 API 数据、附件字节摘要，检查数据库字段/文件实际为密文，验证备份与恢复。
5. 回滚必须同时恢复迁移前的应用、数据库与附件，不能让不支持加密的旧版本打开新数据库。保留独立密钥副本。

恢复加密备份需要相同密钥。旧 ZIP 可以导入加密实例，导入完成后按当前配置存为密文。
自动生成的历史恢复前备份在加密模式下内容也是加密信封，即使历史命名仍以 `.zip` 结尾；其内容只能通过应用恢复。
PostgreSQL 应在维护窗口按数据库维护流程处理旧元组/WAL/副本/历史备份，不能把逻辑字段迁移理解为旧明文的物理擦除。

## 验证

`python -m unittest discover -s tests -v` 包含 SQLite 迁移、明文扫描、错误/缺失密钥、损坏密文、附件、旧 ZIP 导入及加密备份往返测试。
设置专用 `PROCESS_LOG_TEST_DATABASE_URL` 后同时运行 PostgreSQL 测试；不要指向真实数据数据库。
