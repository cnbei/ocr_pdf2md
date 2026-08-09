import "dotenv/config";
import cors from "cors";
import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ZipArchive } from "archiver";
import { Model } from "@paddleocr/api-sdk";
import {
  ALLOWED_MODELS,
  JobQueue,
  formatBytes,
  safeBasename,
} from "./jobs.js";
import { TokenPool, normalizeTokens } from "./token-pool.js";
import { ResultCache } from "./cache.js";
import {
  ensureMarkdownImages,
  listFilesRecursive,
} from "./images.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const OUTPUT_DIR = path.join(ROOT, "outputs");
const CACHE_DIR = path.join(ROOT, "cache");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const IS_RAILWAY = Boolean(
  process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID,
);

interface AppSettings {
  accessTokens: string[];
  concurrency: number;
}

/** 支持 PADDLEOCR_ACCESS_TOKENS（多行/逗号）与旧的单值 PADDLEOCR_ACCESS_TOKEN */
function tokensFromEnv() {
  return normalizeTokens(
    [process.env.PADDLEOCR_ACCESS_TOKENS, process.env.PADDLEOCR_ACCESS_TOKEN]
      .filter(Boolean)
      .join("\n"),
  );
}

let settings: AppSettings = {
  accessTokens: tokensFromEnv(),
  concurrency: Math.max(1, Math.min(8, Number(process.env.CONCURRENCY || 2) || 2)),
};

const tokenPool = new TokenPool();

async function ensureDirs() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
}

function applyTokensToPool() {
  tokenPool.setTokens(settings.accessTokens);
}

async function loadSettings() {
  const envTokens = tokensFromEnv();
  try {
    if (!existsSync(SETTINGS_PATH)) {
      if (envTokens.length && !IS_RAILWAY) await saveSettings();
      applyTokensToPool();
      return;
    }
    const raw = await fs.readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppSettings> & {
      accessToken?: string;
    };

    // Railway / 环境变量优先：容器重启后磁盘上的 settings 不可靠
    if (envTokens.length) {
      settings.accessTokens = envTokens;
    } else if (
      Array.isArray(parsed.accessTokens) ||
      typeof parsed.accessToken === "string"
    ) {
      const merged = [
        ...(Array.isArray(parsed.accessTokens) ? parsed.accessTokens : []),
        ...(typeof parsed.accessToken === "string" ? [parsed.accessToken] : []),
      ];
      settings.accessTokens = normalizeTokens(merged);
    }

    if (Number.isFinite(Number(parsed.concurrency))) {
      // 环境变量 CONCURRENCY 已在启动时读入；仅当未显式设置时用文件值
      if (!process.env.CONCURRENCY) {
        settings.concurrency = Math.max(
          1,
          Math.min(8, Math.floor(Number(parsed.concurrency))),
        );
      }
    }
  } catch (err) {
    console.warn("[settings] 读取失败，将使用环境变量/默认值", err);
    if (envTokens.length) settings.accessTokens = envTokens;
  }
  applyTokensToPool();
}

async function saveSettings() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    SETTINGS_PATH,
    JSON.stringify(
      {
        accessTokens: settings.accessTokens,
        // 兼容旧字段：保留第一个，方便手工查看
        accessToken: settings.accessTokens[0] || "",
        concurrency: settings.concurrency,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function requireTokens() {
  if (!tokenPool.hasTokens()) {
    throw Object.assign(
      new Error(
        "未配置 Access Token。请打开「系统设置」添加飞桨 AI Studio Access Token（支持多个）。",
      ),
      { status: 503, code: "MISSING_TOKEN" },
    );
  }
}

function publicSettings() {
  return {
    ...tokenPool.publicView(),
    // 兼容旧前端字段
    tokenMasked: tokenPool.publicView().tokens[0]?.masked ?? null,
    concurrency: settings.concurrency,
    tokenHelpUrl: "https://aistudio.baidu.com/account/accessToken",
  };
}

await ensureDirs();
await loadSettings();

const resultCache = new ResultCache(CACHE_DIR);
await resultCache.ensureReady();

const queue = new JobQueue(
  UPLOAD_DIR,
  OUTPUT_DIR,
  tokenPool,
  resultCache,
  settings.concurrency,
);
const MAX_BATCH_FILES = 500;
const MAX_ENQUEUE_FILES = 200;
const SUPPORTED_EXT = /\.(pdf|png|jpe?g|bmp|tif{1,2}|webp)$/i;

/** Multer/busboy 常把 UTF-8 文件名按 latin1 解，这里还原中文名 */
function decodeFilename(name: string) {
  if (!name) return name;
  try {
    return Buffer.from(name, "latin1").toString("utf8");
  } catch {
    return name;
  }
}

function isSupportedUpload(file: { originalname: string; mimetype: string }) {
  const name = decodeFilename(file.originalname);
  return (
    file.mimetype === "application/pdf" ||
    file.mimetype.startsWith("image/") ||
    SUPPORTED_EXT.test(name)
  );
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const id = randomUUID().slice(0, 8);
    const original = decodeFilename(file.originalname);
    cb(null, `${Date.now()}-${id}-${safeBasename(original)}`);
  },
});

// 不在 fileFilter 里抛错：混入不支持格式时跳过，不阻断整批
const upload = multer({
  storage,
  limits: {
    fileSize: 200 * 1024 * 1024,
    files: MAX_BATCH_FILES,
  },
});

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(PUBLIC_DIR));

function publicJob(job: ReturnType<JobQueue["list"]>[number]) {
  return {
    id: job.id,
    sourceName: job.sourceName,
    mimeType: job.mimeType,
    size: job.size,
    sizeLabel: formatBytes(job.size),
    model: job.model,
    pageRanges: job.pageRanges ?? null,
    status: job.status,
    error: job.error ?? null,
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    pageCount: job.pageCount ?? null,
    remoteJobId: job.remoteJobId ?? null,
    progress: job.progress ?? null,
    retryCount: job.retryCount ?? 0,
    notBefore: job.notBefore ?? null,
    fromCache: Boolean(job.fromCache),
    contentHash: job.contentHash ?? null,
    isPdf:
      job.mimeType === "application/pdf" ||
      job.sourceName.toLowerCase().endsWith(".pdf"),
    isImage: /^image\//.test(job.mimeType) || /\.(png|jpe?g|bmp|tif{1,2}|webp)$/i.test(job.sourceName),
    downloads:
      job.status === "done"
        ? {
            markdown: `/api/download/${job.id}/md`,
            json: `/api/download/${job.id}/json`,
          }
        : null,
    previewUrl: `/api/jobs/${job.id}/file`,
  };
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    ...publicSettings(),
    models: ALLOWED_MODELS,
    stats: queue.stats(),
  });
});

app.get("/api/settings", (_req, res) => {
  res.json({
    ...publicSettings(),
    stats: queue.stats(),
  });
});

app.get("/api/jobs", (_req, res) => {
  res.json({
    jobs: queue.list().map(publicJob),
    stats: queue.stats(),
  });
});

app.get("/api/jobs/:id", async (req, res) => {
  const job = queue.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  const result = job.status === "done" ? await queue.readResult(job.id) : null;
  res.json({
    job: publicJob(job),
    markdown: result?.markdown ?? null,
    pages: result?.pages ?? null,
    json: result ?? null,
  });
});

app.get("/api/jobs/:id/file", (req, res) => {
  const job = queue.get(req.params.id);
  if (!job || !existsSync(job.filePath)) {
    res.status(404).json({ error: "源文件不存在" });
    return;
  }
  res.setHeader("Content-Type", job.mimeType || "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(job.sourceName)}`,
  );
  createReadStream(job.filePath).pipe(res);
});

app.post("/api/jobs", upload.array("files", MAX_BATCH_FILES), async (req, res) => {
  try {
    requireTokens();
    const incoming = (req.files as Express.Multer.File[] | undefined) || [];
    if (!incoming.length) {
      res.status(400).json({
        error: "请至少上传一个文件",
        skipped: [],
      });
      return;
    }

    const accepted: Express.Multer.File[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];

    for (const file of incoming) {
      const name = decodeFilename(file.originalname);
      file.originalname = name;
      if (isSupportedUpload(file)) {
        accepted.push(file);
      } else {
        skipped.push({
          name,
          reason: "不支持的格式（仅 PDF/PNG/JPG/BMP/TIF/WEBP）",
        });
        await fs.unlink(file.path).catch(() => undefined);
      }
    }

    const overflow = accepted.splice(MAX_ENQUEUE_FILES);
    for (const file of overflow) {
      skipped.push({
        name: file.originalname,
        reason: `超过单次入队上限 ${MAX_ENQUEUE_FILES}，已忽略`,
      });
      await fs.unlink(file.path).catch(() => undefined);
    }

    if (!accepted.length) {
      res.status(400).json({
        error: `没有可解析的文件。已跳过 ${skipped.length} 个不支持项（仅支持 PDF/PNG/JPG/BMP/TIF/WEBP）`,
        skipped,
      });
      return;
    }

    const modelRaw = String(req.body.model || Model.PaddleOCRVL16);
    if (!queue.isAllowedModel(modelRaw)) {
      for (const file of accepted) {
        await fs.unlink(file.path).catch(() => undefined);
      }
      res.status(400).json({
        error: `不支持的模型：${modelRaw}`,
        models: ALLOWED_MODELS,
        skipped,
      });
      return;
    }

    const pageRanges =
      typeof req.body.pageRanges === "string" && req.body.pageRanges.trim()
        ? req.body.pageRanges.trim()
        : undefined;

    const created = await queue.enqueue(accepted, {
      model: modelRaw,
      pageRanges,
    });
    const cacheHits = created.filter((j) => j.fromCache).length;

    res.status(202).json({
      created: created.map(publicJob),
      skipped,
      acceptedCount: created.length,
      skippedCount: skipped.length,
      cacheHits,
      stats: queue.stats(),
    });
  } catch (err) {
    const status =
      typeof err === "object" && err && "status" in err
        ? Number((err as { status: number }).status)
        : 500;
    res.status(Number.isFinite(status) ? status : 500).json({
      error: err instanceof Error ? err.message : "入队失败",
    });
  }
});

app.post("/api/jobs/:id/retry", async (req, res) => {
  const job = await queue.retry(req.params.id);
  if (!job) {
    res.status(404).json({ error: "任务不存在" });
    return;
  }
  res.json({ job: publicJob(job), stats: queue.stats() });
});

app.delete("/api/jobs/:id", async (req, res) => {
  const ok = await queue.remove(req.params.id);
  if (!ok) {
    const job = queue.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: "任务不存在" });
      return;
    }
    res.status(409).json({ error: "运行中的任务不能删除" });
    return;
  }
  res.json({ ok: true, stats: queue.stats() });
});

app.post("/api/jobs/clear-finished", async (_req, res) => {
  const removed = await queue.clearFinished();
  res.json({ removed, stats: queue.stats() });
});

app.patch("/api/settings", async (req, res) => {
  try {
    const body = req.body ?? {};
    let tokenUpdated = false;

    if (Object.prototype.hasOwnProperty.call(body, "concurrency")) {
      const concurrency = Number(body.concurrency);
      if (!Number.isFinite(concurrency)) {
        res.status(400).json({ error: "concurrency 必须是数字" });
        return;
      }
      settings.concurrency = Math.max(1, Math.min(8, Math.floor(concurrency)));
      queue.setConcurrency(settings.concurrency);
    }

    if (body.clearTokens === true || body.clearToken === true) {
      settings.accessTokens = [];
      tokenUpdated = true;
    }

    if (typeof body.removeTokenIndex === "number") {
      const idx = Math.floor(body.removeTokenIndex);
      if (idx >= 0 && idx < settings.accessTokens.length) {
        settings.accessTokens.splice(idx, 1);
        tokenUpdated = true;
      }
    }

    // 追加：accessTokens 数组 / accessToken 字符串 / 多行文本
    const toAdd = normalizeTokens([
      ...(Array.isArray(body.accessTokens) ? body.accessTokens : []),
      ...(typeof body.accessToken === "string" ? [body.accessToken] : []),
      ...(typeof body.addTokens === "string" ? [body.addTokens] : []),
      ...(Array.isArray(body.addTokens) ? body.addTokens : []),
    ]);

    if (body.replaceTokens === true && toAdd.length) {
      settings.accessTokens = toAdd;
      tokenUpdated = true;
    } else if (toAdd.length) {
      settings.accessTokens = normalizeTokens([
        ...settings.accessTokens,
        ...toAdd,
      ]);
      tokenUpdated = true;
    }

    if (tokenUpdated) {
      applyTokensToPool();
      queue.notifyTokensChanged();
    }

    await saveSettings();
    res.json({
      ...publicSettings(),
      tokenUpdated,
      stats: queue.stats(),
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "保存设置失败",
    });
  }
});

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = () => {
    res.write(
      `data: ${JSON.stringify({
        jobs: queue.list().map(publicJob),
        stats: queue.stats(),
      })}\n\n`,
    );
  };

  send();
  const unsubscribe = queue.subscribe(send);
  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

function parseIncludeImages(value: unknown, fallback = true): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(s)) return false;
  if (["1", "true", "yes", "on"].includes(s)) return true;
  return fallback;
}

app.get("/api/download/:jobId/:format", async (req, res) => {
  const { jobId, format } = req.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) {
    res.status(400).json({ error: "无效 jobId" });
    return;
  }

  if (format !== "md" && format !== "json") {
    res.status(400).json({ error: "format 仅支持 md 或 json" });
    return;
  }

  const outDir = path.join(OUTPUT_DIR, jobId);
  const fileName = format === "md" ? "result.md" : "result.json";
  const filePath = path.join(outDir, fileName);
  if (!existsSync(filePath)) {
    res.status(404).json({ error: "文件不存在或尚未完成" });
    return;
  }

  const job = queue.get(jobId);
  const baseName = job
    ? safeBasename(job.sourceName).replace(/\.[^.]+$/, "")
    : jobId;
  const includeImages =
    format === "md" &&
    parseIncludeImages(req.query.images ?? req.query.includeImages, true);

  // JSON / 纯 MD：直接下载单文件
  if (format === "json" || !includeImages) {
    const ext = format === "json" ? "json" : "md";
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(`${baseName}.${ext}`)}`,
    );
    res.setHeader(
      "Content-Type",
      format === "json"
        ? "application/json; charset=utf-8"
        : "text/markdown; charset=utf-8",
    );
    createReadStream(filePath).pipe(res);
    return;
  }

  await ensureMarkdownImages(outDir).catch((err) =>
    console.warn("[images] 单文件导出补图失败", err),
  );

  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(`${baseName}.zip`)}`,
  );

  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on("error", (err: Error) => {
    console.error("[zip]", err);
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  archive.pipe(res);
  archive.file(filePath, { name: `${baseName}/${baseName}.md` });
  const imgFiles = await listFilesRecursive(path.join(outDir, "imgs"));
  for (const abs of imgFiles) {
    const rel = path.relative(outDir, abs).split(path.sep).join("/");
    archive.file(abs, { name: `${baseName}/${rel}` });
  }
  await archive.finalize();
});

async function exportDoneJobs(
  req: express.Request,
  res: express.Response,
  format: string,
  ids: string[],
  includeImages: boolean,
) {
  if (format !== "md" && format !== "json") {
    res.status(400).json({ error: "format 仅支持 md 或 json" });
    return;
  }

  const withImages = format === "md" && includeImages;

  // 只导出已完成；队列未全部完成也可随时导出，不影响进行中任务
  const candidates = ids.length
    ? ids.map((id) => queue.get(id)).filter(Boolean)
    : queue.list();

  const done = candidates.filter(
    (job): job is NonNullable<typeof job> =>
      Boolean(job && job.status === "done"),
  );

  type ExportItem = {
    jobId: string;
    outDir: string;
    baseName: string;
    filePath: string;
  };

  const items: ExportItem[] = [];
  for (const job of done) {
    const ext = format === "md" ? "md" : "json";
    const outDir = path.join(OUTPUT_DIR, job.id);
    const filePath = path.join(outDir, `result.${ext}`);
    if (!existsSync(filePath)) continue;
    items.push({
      jobId: job.id,
      outDir,
      baseName: safeBasename(job.sourceName).replace(/\.[^.]+$/, ""),
      filePath,
    });
  }

  if (!items.length) {
    res.status(400).json({
      error: "当前没有已完成的可导出结果（可等部分完成后再导出）",
      doneCount: done.length,
    });
    return;
  }

  // 重名时加后缀
  const used = new Map<string, number>();
  for (const item of items) {
    const count = used.get(item.baseName) || 0;
    used.set(item.baseName, count + 1);
    if (count > 0) item.baseName = `${item.baseName}-${count + 1}`;
  }

  // 仅在需要附带图片时补齐（旧结果也可修复）
  if (withImages) {
    for (const item of items) {
      await ensureMarkdownImages(item.outDir).catch((err) =>
        console.warn(`[images] 导出补图失败 ${item.baseName}`, err),
      );
    }
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="paddleocr-${format}-done-${items.length}.zip"`,
  );

  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on("error", (err: Error) => {
    console.error("[zip]", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || "打包失败" });
    } else {
      res.end();
    }
  });
  archive.pipe(res);

  for (const item of items) {
    if (format === "json") {
      archive.file(item.filePath, { name: `${item.baseName}.json` });
      continue;
    }
    if (!withImages) {
      archive.file(item.filePath, { name: `${item.baseName}.md` });
      continue;
    }
    // 每个文档一个目录，保证 imgs/ 相对路径可用
    archive.file(item.filePath, {
      name: `${item.baseName}/${item.baseName}.md`,
    });
    const imgFiles = await listFilesRecursive(path.join(item.outDir, "imgs"));
    for (const abs of imgFiles) {
      const rel = path.relative(item.outDir, abs).split(path.sep).join("/");
      archive.file(abs, { name: `${item.baseName}/${rel}` });
    }
  }

  await archive.finalize();
}

app.get("/api/download-batch", async (req, res) => {
  const format = String(req.query.format || "md");
  const idsParam = String(req.query.ids || "");
  const ids = idsParam
    ? idsParam.split(",").map((x) => x.trim()).filter(Boolean)
    : [];
  const includeImages = parseIncludeImages(
    req.query.images ?? req.query.includeImages,
    true,
  );
  await exportDoneJobs(req, res, format, ids, includeImages);
});

app.post("/api/download-batch", async (req, res) => {
  const format = String(req.body?.format || "md");
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map((x: unknown) => String(x))
    : [];
  const includeImages = parseIncludeImages(
    req.body?.includeImages ?? req.body?.images,
    true,
  );
  await exportDoneJobs(req, res, format, ids, includeImages);
});

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    let message = err instanceof Error ? err.message : "服务器错误";
    message = decodeFilename(message);
    // multer 常见限制错误转成可读中文
    if (/File too large/i.test(message)) {
      message = "单个文件超过 200MB 限制";
    } else if (/Too many files/i.test(message)) {
      message = `单次上传超过 ${MAX_BATCH_FILES} 个文件限制`;
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(400).json({ error: message });
  },
);

app.listen(PORT, HOST, () => {
  console.log(`PaddleOCR 服务已启动: http://${HOST}:${PORT}`);
  if (IS_RAILWAY) {
    console.log("运行环境: Railway（Token / 并发优先读环境变量）");
  }
  console.log(`批量队列并发: ${queue.getConcurrency()}（可在系统设置中调整）`);
  if (!tokenPool.hasTokens()) {
    console.warn(
      "警告: 未配置 Access Token。请打开网页「系统设置」添加（支持多个），或设置环境变量 PADDLEOCR_ACCESS_TOKENS / PADDLEOCR_ACCESS_TOKEN。",
    );
  } else {
    console.log(
      `Access Token 池: ${tokenPool.count()} 个（多 Token 可分摊官方限流）`,
    );
  }
});
