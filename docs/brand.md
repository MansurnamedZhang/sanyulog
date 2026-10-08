# 三余记 · Sanyu Notes

记下过程，沉淀思考。

「三余记」适合持续积累实验、工作流、工作笔记与日常思考，也呼应项目已有的 sanyulog 仓库名。英文名为 Sanyu Notes，界面使用「三余记」，完整产品名用于浏览器标题、文档和应用清单。原产品名为「过程簿」。

## 图标

![三余记图标](../static/brand/sanyu-mark.svg)

深绿圆角底承载三叠纸页，纸页上的连续书写轨迹形成 S 的意象，金色落点表示下一次记录。图标不依赖文字，适用于侧栏、浏览器标签和快捷方式。SVG 是主文件，PNG 和 ICO 都从它生成。

| 用途                            | 文件                                                        |
| ------------------------------- | ----------------------------------------------------------- |
| 矢量主标识与浏览器 SVG 图标     | `static/brand/sanyu-mark.svg`                               |
| 浏览器兼容图标，内含 16/32/64px | `static/brand/favicon.ico`                                  |
| 小尺寸 PNG                      | `static/brand/sanyu-16.png`、`sanyu-32.png`、`sanyu-64.png` |
| Apple 触屏图标，180px           | `static/brand/apple-touch-icon.png`                         |
| 应用图标，192/512px             | `static/brand/icon-192.png`、`icon-512.png`                 |
| 应用名称与快捷方式元数据        | `static/manifest.webmanifest`                               |

| 颜色 | 色值      | 用途                   |
| ---- | --------- | ---------------------- |
| 松绿 | `#254F42` | 品牌主色与浏览器主题色 |
| 墨绿 | `#183C34` | 图标底色与深色文字     |
| 纸白 | `#FFFEFA` | 纸页与浅色背景         |
| 暖金 | `#C69F5A` | 书写轨迹落点           |

## 重新生成图标

安装开发依赖与 Playwright Chromium 后运行：

```sh
npm ci --ignore-scripts
npx playwright install chromium
npm run build:brand
```

也可通过 `UI_BROWSER_PATH` 指定本机 Chrome 可执行文件。脚本只重建上述 PNG 和 ICO；SVG 主文件手工维护。

应用清单提供名称与图标元数据，不提供离线编辑。旧图标链接继续保留，避免已有书签或旧页面失效。此次更名保留 `process-log` 包名、环境变量、Cookie、浏览器存储键、数据库及备份格式，以兼容既有部署和记录。
