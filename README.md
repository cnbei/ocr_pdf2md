# ocr_pdf2md

本地网页工具：上传 PDF / 图片，调用飞桨 PaddleOCR 官方文档解析 API，导出 Markdown / JSON。

## 功能

- 批量上传与有限并发队列（SSE 进度）
- 多分栏预览（源文件 / Markdown / JSON）
- 多 Access Token 轮询，缓解 429 限流
- 结果按内容哈希缓存；MD 导出可选是否附带图片

## 快速开始

```bash
npm install
cp .env.example .env   # 可选；也可在网页「系统设置」里配置 Token
npm run dev
```

浏览器打开 http://127.0.0.1:8787

Access Token 获取：https://aistudio.baidu.com/account/accessToken

> Token 保存在本地 `data/settings.json` 或 `.env`，二者均已被 gitignore，请勿提交。

## 环境变量

见 `.env.example`：

- `PADDLEOCR_ACCESS_TOKENS`：多个 Token，换行或逗号分隔（推荐）
- `PADDLEOCR_ACCESS_TOKEN`：单个 Token（兼容）
- `PORT` / `HOST` / `CONCURRENCY`

## Railway 部署（省钱）

仓库已含 `Dockerfile` + `railway.toml`：

- **App Sleep**：闲时自动休眠，无流量不计常驻
- **低规格**：建议 0.5 vCPU / 0.5 GB 内存，`CONCURRENCY=1`
- **无常驻 SSE**：前端有任务才短轮询；关标签即停请求
- **不预拉图片**：导出时勾选「附带图片」再下载

```bash
railway up
railway domain
```

Token 请只写在 Railway Variables。本地开发默认仍可用；云上省钱模式由 `ECONOMY_MODE=1` 开启。

## 本机中继（推荐日常 OCR）

云端页面只当 UI；**上传与调百度走你家宽带**，避免 Railway 跨境传文件超时。

1. 本机项目目录：

```bash
npm install
npm run relay
```

2. 浏览器打开云端站点（或本机 `http://127.0.0.1:8787`）
3. **系统设置 → 启用本机中继** → 地址 `http://127.0.0.1:8787` → 测试连接 → 保存  
4. Token / 并发保存在**本机** `data/settings.json`（不要指望写进 Railway）

侧栏出现「本机中继」徽章即表示 API 已指向本机。
