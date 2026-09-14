# 开发与贡献

## 环境

- Python 3.12+：运行服务和后端测试。
- Node.js 22+：前端检查、测试和格式化；运行应用无需 Node.js。
- PostgreSQL 驱动仅在使用该后端时需要：`python -m pip install -r requirements.txt`。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `server.py` | HTTP 路由、请求校验、静态文件及启动配置 |
| `store.py` | SQLite 持久化、工作空间、笔记、附件和备份 |
| `pgstore.py` | PostgreSQL 适配及便携备份交换 |
| `static/app.js` | 工作空间、项目、笔记导航与页面交互 |
| `static/notebook.js` | 单元格编辑器、表格和工具栏 |
| `static/notebook-core.mjs` | Markdown、CSV、文本变换和自动保存队列 |
| `static/style.css` | 桌面和竖屏样式 |
| `static/vendor/` | 保持原样的第三方代码及许可证 |
| `tests/` | 临时数据库、HTTP 集成及 JavaScript 单元测试 |

## 验证

```sh
npm ci
npm run check
npm test
npm run format:check
python -m unittest discover -s tests -v
```

前端修改后运行 `npm run format`。格式化不处理第三方文件。后端测试使用临时目录；PostgreSQL 测试默认跳过，只有设置专用的、可清空的 `PROCESS_LOG_TEST_DATABASE_URL` 后才运行，不能使用生产数据库。

提交前确认 `git diff --check` 通过，并检查 `git diff --cached --stat`。不提交数据库、附件、备份、连接凭据和机器专属部署配置。涉及数据格式的修改应验证旧数据兼容及备份恢复。

## 提交 GitHub

本地验证通过后，创建 GitHub 空仓库并将其地址设置为 `origin`。先查看 `git status` 和暂存区差异，再创建提交和推送。项目许可证由维护者决定，第三方许可证必须保留。
