# 路绘 · 公交线路可视化制图台

用于可视化一条或多条公交线路的地图制图工具，支持高德既有公交数据、自定义导航线路、共线并排、站点管理和高清导出。

## 主要能力

- 纸感、地图册、暗色和卫星底图，地名与道路标注可独立开关
- 多线路共线段自动等宽并排，保持线路顺序稳定
- 标准实线、细实线、中空实线、短/中/长虚线和点划线
- 既有公交查询，以及带首末站、中途站、途经点和导航偏好的自定义线路
- 图例与线路标签二选一：同色线路标签可拖动、方向键微调，并随存档和 PNG/SVG 导出保留位置
- 标签可切换仅线路号、仅数字和完整名称，也可双击标签或在底图面板单独编辑文字
- 标签宽度随完整文字自适应；“标签移回线路”会吸附到最近的线路位置
- 线路、站点的显示控制与 PNG/SVG 框选导出
- SVG 中每条公交线路保持为单一路径元素
- 自动存档与手动存档

## 公开版

GitHub Pages：<https://arcadiayite.github.io/route-atlas-bus-map/>

公开版不会把项目使用的高德 Key 或安全密钥写入仓库、构建产物或 GitHub Actions。访客需要在页面中填写自己的高德 Web 端 Key 与 `securityJsCode`，数据只保存在当前浏览器。公开版的自动存档和手动存档也使用浏览器本地存储。

## 本地开发

需要 Node.js `>=22.13.0`。

```bash
npm install
npm run dev
```

本地完整版本通过忽略的 `.env.local` 配置：

```text
AMAP_WEB_KEY=你的 Web 端 Key
AMAP_SECURITY_CODE=你的安全密钥
```

不要提交 `.env.local`、API Key、安全密钥或访问令牌。

## 构建

```bash
npm run build
npm run build:pages
```

- `npm run build`：生成 Sites/Cloudflare Worker 版本。
- `npm run build:pages`：生成不含服务器接口和项目密钥的 GitHub Pages 静态版。

推送到 `main` 后，`.github/workflows/deploy-pages.yml` 会自动构建并发布公开版。
