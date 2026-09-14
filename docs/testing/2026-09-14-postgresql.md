# PostgreSQL 验证记录 · 2026-09-14

## 结果

- 完整 Python 测试：32 项通过，0 失败、0 错误、0 跳过。
- `tests/test_pgstore.py` 中 6 项测试均实际执行。
- PostgreSQL 补充验证：2 项通过，覆盖多工作空间及独立 CSV 表格。

完整测试命令：

```sh
python -B -m unittest discover -s tests -v
```

测试前安装 `requirements.txt`，并将 `PROCESS_LOG_TEST_DATABASE_URL` 指向独立、可清空的测试数据库。GitHub Actions 的临时 PostgreSQL 服务可运行仓库内的完整测试。

## 补充覆盖

使用 `NotebookTests` 的工作空间和 CSV 表格测试逻辑，替换为临时 PostgreSQLStore fixture：

- 工作空间创建、重命名、项目移动、拒绝删除非空空间、拒绝无效空间、移回默认空间后删除空空间。
- 工作空间数据在 PostgreSQL 与 SQLite 便携备份间往返一致。
- CSV 表格保存、备份恢复、Markdown 导出及非法 CSV 拒绝。

可使用 `python -B scripts/test_postgres_extra.py` 重复这两项补测（需先配置独立测试库）。

上述 2 项为本轮独立补测，不计入仓库默认测试发现的 32 项。临时 fixture 首次初始化误删模板设置，修正为仅重置工作空间设置后，在全新临时数据库中重跑通过；产品源码无需修复。

## 隔离与清理

测试使用新建 PostgreSQL 容器、独立内部 Docker 网络，无宿主机端口发布；数据库使用临时内存存储。测试 runner 只读挂载临时源码目录，不挂载正式数据库、附件或配置，也不加入生产网络。测试结束后已清理临时容器、网络和源码目录，正式应用健康检查仍正常。

此记录证明上述版本的数据库测试结果，不替代后续代码变更后的重新验证，也不包含浏览器交互验证。
