import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  Model,
  PaddleOCRAPIError,
  RateLimitError,
} from "@paddleocr/api-sdk";
import type { TokenPool } from "./token-pool.js";
import type { ResultCache } from "./cache.js";
import { ensureMarkdownImages } from "./images.js";

export const ALLOWED_MODELS = [
  Model.PaddleOCRVL16,
  Model.PaddleOCRVL15,
  Model.PaddleOCRVL,
  Model.PPStructureV3,
] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];
export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobProgress {
  totalPages: number;
  extractedPages: number;
}

/** 因官方 429 限流自动重新入队的最大次数 */
const MAX_RATE_LIMIT_RETRIES = 30;

export interface JobRecord {
  id: string;
  sourceName: string;
  storedName: string;
  filePath: string;
  mimeType: string;
  size: number;
  model: AllowedModel;
  pageRanges?: string;
  status: JobStatus;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  pageCount?: number;
  remoteJobId?: string;
  progress?: JobProgress;
  /** 提交该任务使用的 Token（轮询/状态必须用同一个） */
  tokenUsed?: string;
  /** 限流自动重试次数 */
  retryCount?: number;
  /** 最早可再次调度的时间戳（限流退避） */
  notBefore?: number;
  /** 文件内容 sha256，用于结果缓存 */
  contentHash?: string;
  /** 命中本地缓存，跳过官方 API */
  fromCache?: boolean;
  /** 手动重试时跳过缓存，强制重新解析 */
  skipCache?: boolean;
}

export interface JobResultPayload {
  jobId: string;
  remoteJobId?: string;
  model: string;
  sourceName: string;
  dataInfo: unknown;
  pages: unknown[];
  markdown: string;
}

type Listener = (jobs: JobRecord[]) => void;

export class JobQueue {
  private jobs = new Map<string, JobRecord>();
  private order: string[] = [];
  private active = 0;
  private concurrency: number;
  private listeners = new Set<Listener>();
  /** 提交任务的最小间隔，避免并发启动时瞬间打满官方配额 */
  private submitGapMs = 2500;
  private lastSubmitAt = 0;
  private submitChain: Promise<void> = Promise.resolve();
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private uploadDir: string,
    private outputDir: string,
    private tokenPool: TokenPool,
    private resultCache: ResultCache,
    concurrency = 2,
  ) {
    this.concurrency = Math.max(1, Math.min(8, concurrency));
    this.syncThrottle();
  }

  setConcurrency(n: number) {
    this.concurrency = Math.max(1, Math.min(8, Math.floor(n)));
    this.syncThrottle();
    this.pump();
  }

  getConcurrency() {
    return this.concurrency;
  }

  notifyTokensChanged() {
    this.tokenPool.resetClients();
    this.syncThrottle();
  }

  private syncThrottle() {
    const tokenCount = Math.max(1, this.tokenPool.count());
    // 多 Token 时缩短提交间隔；单 Token 仍保守
    this.submitGapMs = Math.max(
      800,
      Math.round((this.concurrency * 900) / tokenCount),
    );
  }

  private isRateLimitError(err: unknown) {
    if (err instanceof RateLimitError) return true;
    const message = err instanceof Error ? err.message : String(err);
    return this.isRateLimitMessage(message);
  }

  private isRateLimitMessage(message: string) {
    return /429|Rate limit|请求频率过高|rate limit|限流/i.test(message);
  }

  private moveToQueueEnd(jobId: string) {
    this.order = this.order.filter((id) => id !== jobId);
    this.order.push(jobId);
  }

  private scheduleWake() {
    const now = Date.now();
    const delays = this.list()
      .filter((j) => j.status === "queued" && j.notBefore && j.notBefore > now)
      .map((j) => (j.notBefore as number) - now);
    if (!delays.length) return;
    const delay = Math.max(200, Math.min(...delays));
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.pump();
    }, delay);
  }

  /** 把已因 429 失败的任务捞回队列（无需手动点重试） */
  private rescueRateLimitedFailures() {
    let rescued = 0;
    for (const job of this.list()) {
      if (job.status !== "failed" || !job.error) continue;
      if (!this.isRateLimitMessage(job.error)) continue;
      if ((job.retryCount || 0) >= MAX_RATE_LIMIT_RETRIES) continue;
      if (!existsSync(job.filePath)) continue;

      job.status = "queued";
      job.finishedAt = undefined;
      job.startedAt = undefined;
      job.remoteJobId = undefined;
      job.progress = undefined;
      job.tokenUsed = undefined;
      job.notBefore = Date.now() + 8000;
      job.error = `限流自动重试，等待重新调度（已失败重试 ${job.retryCount || 0}/${MAX_RATE_LIMIT_RETRIES}）`;
      this.moveToQueueEnd(job.id);
      rescued += 1;
    }
    if (rescued > 0) {
      console.warn(`[auto-retry] 已将 ${rescued} 个限流失败任务重新入队`);
      this.emit();
    }
  }

  private requeueAfterRateLimit(job: JobRecord, message: string) {
    const nextCount = (job.retryCount || 0) + 1;
    job.retryCount = nextCount;

    if (nextCount > MAX_RATE_LIMIT_RETRIES) {
      job.status = "failed";
      job.finishedAt = new Date().toISOString();
      job.error = `${message}（已自动重试 ${MAX_RATE_LIMIT_RETRIES} 次仍失败）`;
      console.error(
        `[auto-retry] ${job.sourceName} 限流重试次数耗尽（${MAX_RATE_LIMIT_RETRIES}）`,
      );
      return;
    }

    const delay = Math.min(180_000, 8000 + nextCount * 4000);
    job.status = "queued";
    job.startedAt = undefined;
    job.finishedAt = undefined;
    job.remoteJobId = undefined;
    job.progress = undefined;
    job.tokenUsed = undefined;
    job.notBefore = Date.now() + delay;
    job.error = `限流自动重试 ${nextCount}/${MAX_RATE_LIMIT_RETRIES}，${Math.round(delay / 1000)}s 后再次排队`;
    this.moveToQueueEnd(job.id);
    console.warn(
      `[auto-retry] ${job.sourceName} 因限流重新入队 ${nextCount}/${MAX_RATE_LIMIT_RETRIES}，延迟 ${Math.round(delay / 1000)}s`,
    );
  }

  private async sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private backoffMs(attempt: number) {
    return (
      Math.min(60_000, 2500 * 2 ** Math.min(attempt - 1, 4)) +
      Math.floor(Math.random() * 600)
    );
  }

  /** 提交阶段：可在多个 Token 间切换以分摊限流 */
  private async withTokenFailover<T>(
    fn: (client: ReturnType<TokenPool["getClient"]>, token: string) => Promise<T>,
    label: string,
    maxAttempts = 12,
  ): Promise<{ value: T; token: string }> {
    let attempt = 0;
    while (true) {
      attempt += 1;
      const { token, waitMs } = this.tokenPool.pick();
      if (waitMs > 0) await this.sleep(waitMs);
      const client = this.tokenPool.getClient(token);

      try {
        const value = await fn(client, token);
        return { value, token };
      } catch (err) {
        if (!this.isRateLimitError(err)) throw err;

        const backoff = this.backoffMs(attempt);
        this.tokenPool.markRateLimited(token, backoff);
        this.submitGapMs = Math.min(12_000, this.submitGapMs + 400);

        if (attempt >= maxAttempts) {
          throw new Error(
            `官方 API 限流（HTTP 429），已在 ${this.tokenPool.count()} 个 Token 间切换重试 ${attempt} 次仍失败。可再添加 Token，或降低并发。`,
          );
        }

        const available = this.tokenPool.availableCount();
        console.warn(
          `[rate-limit] ${label} token=${token.slice(0, 4)}… 冷却 ${Math.round(backoff / 1000)}s；可用 Token ${available}/${this.tokenPool.count()}；重试 ${attempt}/${maxAttempts}`,
        );

        // 还有别的 Token 可用时尽快切换，不必干等当前 Token 冷却完
        if (available === 0) await this.sleep(Math.min(backoff, 8000));
        else await this.sleep(200);
      }
    }
  }

  /** 同一 Token 上的状态轮询重试（任务已绑定 Token，不能换号查） */
  private async withSameTokenRetry<T>(
    token: string,
    fn: () => Promise<T>,
    label: string,
    maxAttempts = 8,
  ): Promise<T> {
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        return await fn();
      } catch (err) {
        if (!this.isRateLimitError(err) || attempt >= maxAttempts) {
          if (this.isRateLimitError(err)) {
            throw new Error(
              `查询任务状态触发限流（HTTP 429），已重试 ${attempt} 次。可稍后再试或增加 Token。`,
            );
          }
          throw err;
        }
        const backoff = this.backoffMs(attempt);
        this.tokenPool.markRateLimited(token, backoff);
        console.warn(
          `[rate-limit] ${label} 同 Token 重试 ${attempt}/${maxAttempts}，等待 ${Math.round(backoff / 1000)}s`,
        );
        await this.sleep(backoff);
      }
    }
  }

  /** 串行化提交入口，保证多任务不会同时 POST jobs */
  private enqueueSubmit<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.submitChain.then(async () => {
      const wait = Math.max(0, this.lastSubmitAt + this.submitGapMs - Date.now());
      if (wait > 0) await this.sleep(wait);
      this.lastSubmitAt = Date.now();
      return fn();
    });
    this.submitChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    const snapshot = this.list();
    for (const listener of this.listeners) listener(snapshot);
  }

  list(): JobRecord[] {
    return this.order
      .map((id) => this.jobs.get(id))
      .filter((job): job is JobRecord => Boolean(job));
  }

  get(id: string) {
    return this.jobs.get(id);
  }

  stats() {
    const jobs = this.list();
    const queued = jobs.filter((j) => j.status === "queued").length;
    const running = jobs.filter((j) => j.status === "running").length;
    const done = jobs.filter((j) => j.status === "done").length;
    const failed = jobs.filter((j) => j.status === "failed").length;
    const total = jobs.length;
    const processed = done + failed;
    const runningJobs = jobs.filter((j) => j.status === "running");
    const current = runningJobs[0] ?? null;
    const currentProgress = current?.progress;
    return {
      total,
      queued,
      running,
      done,
      failed,
      processed,
      concurrency: this.concurrency,
      active: this.active,
      queuePercent: total ? Math.round((processed / total) * 100) : 0,
      currentJobId: current?.id ?? null,
      currentJobName: current?.sourceName ?? null,
      currentExtractedPages: currentProgress?.extractedPages ?? 0,
      currentTotalPages: currentProgress?.totalPages ?? 0,
      currentPercent:
        currentProgress && currentProgress.totalPages > 0
          ? Math.min(
              100,
              Math.round(
                (currentProgress.extractedPages / currentProgress.totalPages) *
                  100,
              ),
            )
          : current
            ? 0
            : 100,
    };
  }

  isAllowedModel(model: string): model is AllowedModel {
    return (ALLOWED_MODELS as readonly string[]).includes(model);
  }

  async enqueue(
    files: Array<{
      originalname: string;
      path: string;
      mimetype: string;
      size: number;
    }>,
    options: {
      model: AllowedModel;
      pageRanges?: string;
    },
  ) {
    const created: JobRecord[] = [];
    let cacheHits = 0;

    for (const file of files) {
      const id = randomUUID();
      const contentHash = await this.resultCache.hashFile(file.path);
      const cached = await this.resultCache.lookup(
        contentHash,
        options.model,
        options.pageRanges,
      );

      const job: JobRecord = {
        id,
        sourceName: file.originalname,
        storedName: path.basename(file.path),
        filePath: file.path,
        mimeType: file.mimetype || "application/octet-stream",
        size: file.size,
        model: options.model,
        pageRanges: options.pageRanges,
        status: "queued",
        createdAt: new Date().toISOString(),
        retryCount: 0,
        contentHash,
        fromCache: false,
        skipCache: false,
      };

      if (cached) {
        const outDir = path.join(this.outputDir, id);
        await this.resultCache.materializeToOutput(cached.dir, outDir);
        // 刷新 json 内的 jobId / sourceName，避免展示旧任务信息
        try {
          const raw = await fs.readFile(path.join(outDir, "result.json"), "utf8");
          const parsed = JSON.parse(raw) as JobResultPayload;
          parsed.jobId = id;
          parsed.sourceName = file.originalname;
          await fs.writeFile(
            path.join(outDir, "result.json"),
            JSON.stringify(parsed, null, 2),
            "utf8",
          );
        } catch {
          // ignore rewrite errors; files still usable
        }

        job.status = "done";
        job.fromCache = true;
        job.pageCount = cached.meta.pageCount;
        job.progress = {
          totalPages: cached.meta.pageCount,
          extractedPages: cached.meta.pageCount,
        };
        job.finishedAt = new Date().toISOString();
        job.startedAt = job.finishedAt;
        cacheHits += 1;
      }

      this.jobs.set(id, job);
      this.order.unshift(id);
      created.push(job);
    }

    this.emit();
    this.pump();
    if (cacheHits > 0) {
      console.log(`[cache] 命中 ${cacheHits}/${files.length} 个文件，已直接标记完成`);
    }
    return created;
  }

  async retry(id: string) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status !== "failed" && job.status !== "done") return job;
    if (!existsSync(job.filePath)) {
      job.status = "failed";
      job.error = "原文件已删除，无法重试";
      this.emit();
      return job;
    }
    job.status = "queued";
    job.error = undefined;
    job.startedAt = undefined;
    job.finishedAt = undefined;
    job.pageCount = undefined;
    job.remoteJobId = undefined;
    job.progress = undefined;
    job.tokenUsed = undefined;
    job.notBefore = undefined;
    job.fromCache = false;
    job.skipCache = true; // 手动重试强制走官方 API
    this.moveToQueueEnd(job.id);
    this.emit();
    this.pump();
    return job;
  }

  async remove(id: string) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === "running") return false;
    this.jobs.delete(id);
    this.order = this.order.filter((x) => x !== id);
    await fs.unlink(job.filePath).catch(() => undefined);
    await fs.rm(path.join(this.outputDir, id), { recursive: true, force: true });
    this.emit();
    return true;
  }

  async clearFinished() {
    const ids = this.list()
      .filter((j) => j.status === "done" || j.status === "failed")
      .map((j) => j.id);
    for (const id of ids) await this.remove(id);
    return ids.length;
  }

  private pump() {
    this.rescueRateLimitedFailures();

    const now = Date.now();
    while (this.active < this.concurrency) {
      // 优先调度小文件，避免大 PDF 长期占满并发导致体感很慢
      const next = this.list()
        .filter(
          (j) =>
            j.status === "queued" &&
            (!j.notBefore || j.notBefore <= now),
        )
        .sort((a, b) => {
          const retryA = a.retryCount || 0;
          const retryB = b.retryCount || 0;
          if (retryA !== retryB) return retryA - retryB;
          return a.size - b.size;
        })[0];
      if (!next) break;
      this.active += 1;
      next.status = "running";
      next.startedAt = new Date().toISOString();
      // 保留限流提示到真正开始提交前；开始后清掉
      next.error = undefined;
      next.notBefore = undefined;
      this.emit();
      void this.run(next).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }

    this.scheduleWake();
  }

  private async run(job: JobRecord) {
    try {
      if (!job.contentHash && existsSync(job.filePath)) {
        job.contentHash = await this.resultCache.hashFile(job.filePath);
      }

      // 运行前再查一次缓存（手动重试 skipCache=true 时跳过）
      if (!job.skipCache && job.contentHash) {
        const cached = await this.resultCache.lookup(
          job.contentHash,
          job.model,
          job.pageRanges,
        );
        if (cached) {
          const outDir = path.join(this.outputDir, job.id);
          await this.resultCache.materializeToOutput(cached.dir, outDir);
          job.status = "done";
          job.fromCache = true;
          job.pageCount = cached.meta.pageCount;
          job.progress = {
            totalPages: cached.meta.pageCount,
            extractedPages: cached.meta.pageCount,
          };
          job.finishedAt = new Date().toISOString();
          job.error = undefined;
          this.emit();
          return;
        }
      }

      if (!this.tokenPool.hasTokens()) {
        throw Object.assign(
          new Error("未配置 Access Token。请在系统设置中添加。"),
          { status: 503, code: "MISSING_TOKEN" },
        );
      }

      const request = {
        filePath: job.filePath,
        model: job.model,
        pageRanges: job.pageRanges,
        options: {
          useLayoutDetection: true,
          prettifyMarkdown: true,
          restructurePages: true,
          mergeTables: true,
          relevelTitles: true,
        },
      };

      // 提交可在多 Token 间 failover；提交后状态查询绑定同一 Token
      const { value: submitted, token } = await this.enqueueSubmit(() =>
        this.withTokenFailover(
          (client) => client.submitDocumentParsing(request),
          `submit:${job.sourceName}`,
        ),
      );
      job.remoteJobId = submitted.jobId;
      job.tokenUsed = token;
      // 提交成功后恢复基础节流，避免限流后间隔一直偏大
      this.syncThrottle();
      this.emit();

      const client = this.tokenPool.getClient(token);
      const deadline = Date.now() + 900_000;
      const pollMs = Math.max(
        1500,
        Math.round((this.concurrency * 500) / Math.max(1, this.tokenPool.count())),
      );
      while (true) {
        if (Date.now() > deadline) {
          throw new Error("等待官方 API 结果超时");
        }
        const status = await this.withSameTokenRetry(
          token,
          () => client.getStatus(submitted.jobId),
          `status:${job.sourceName}`,
          8,
        );
        if (status.progress) {
          job.progress = {
            totalPages: Number(status.progress.totalPages || 0),
            extractedPages: Number(status.progress.extractedPages || 0),
          };
          this.emit();
        }
        if (status.state === "done") break;
        if (status.state === "failed") {
          throw new Error(status.errorMsg || "远端任务失败");
        }
        await this.sleep(pollMs);
      }

      const result = await this.withSameTokenRetry(
        token,
        () => client.waitDocumentParsingResult(submitted),
        `result:${job.sourceName}`,
        6,
      );

      const markdown = pagesToMarkdown(result.pages);
      const payload: JobResultPayload = {
        jobId: job.id,
        remoteJobId: result.jobId,
        model: job.model,
        sourceName: job.sourceName,
        dataInfo: result.dataInfo ?? null,
        pages: result.pages.map((page, index) => ({
          pageIndex: index,
          markdownText: page.markdownText,
          prunedResult: page.prunedResult ?? null,
          markdownImages: page.markdownImages ?? {},
          outputImages: page.outputImages ?? {},
        })),
        markdown,
      };

      const outDir = path.join(this.outputDir, job.id);
      await fs.mkdir(outDir, { recursive: true });
      const jsonText = JSON.stringify(payload, null, 2);
      await fs.writeFile(path.join(outDir, "result.md"), markdown, "utf8");
      await fs.writeFile(path.join(outDir, "result.json"), jsonText, "utf8");

      // 省钱模式可跳过预拉图片（导出勾选「附带图片」时再下载）
      const skipPrefetch =
        process.env.SKIP_IMAGE_PREFETCH === "1" ||
        process.env.ECONOMY_MODE === "1";
      if (!skipPrefetch) {
        const imgStats = await ensureMarkdownImages(outDir, result.pages).catch(
          (err) => {
            console.warn(`[images] ${job.sourceName} 下载失败`, err);
            return { total: 0, downloaded: 0, failed: 0 };
          },
        );
        if (imgStats.total > 0) {
          console.log(
            `[images] ${job.sourceName}: ${imgStats.downloaded}/${imgStats.total} 张已保存` +
              (imgStats.failed ? `，失败 ${imgStats.failed}` : ""),
          );
        }
      }

      job.status = "done";
      job.remoteJobId = result.jobId;
      job.pageCount = result.pages.length;
      job.progress = {
        totalPages: result.pages.length,
        extractedPages: result.pages.length,
      };
      job.finishedAt = new Date().toISOString();
      job.error = undefined;
      job.retryCount = 0;
      job.notBefore = undefined;
      job.fromCache = false;
      job.skipCache = false;

      if (job.contentHash) {
        await this.resultCache
          .save({
            contentHash: job.contentHash,
            model: job.model,
            pageRanges: job.pageRanges,
            sourceName: job.sourceName,
            size: job.size,
            pageCount: result.pages.length,
            markdown,
            jsonText,
            sourceOutputDir: outDir,
            pages: result.pages,
          })
          .catch((err) => console.warn("[cache] 写入失败", err));
      }
    } catch (err) {
      const message =
        err instanceof PaddleOCRAPIError || err instanceof Error
          ? err.message
          : "解析失败";

      if (this.isRateLimitError(err) || this.isRateLimitMessage(message)) {
        this.requeueAfterRateLimit(job, message);
      } else {
        job.status = "failed";
        job.finishedAt = new Date().toISOString();
        job.error = message;
        console.error(`[job ${job.id}]`, err);
      }
    }
    this.emit();
    this.scheduleWake();
  }

  async readResult(id: string): Promise<JobResultPayload | null> {
    const jsonPath = path.join(this.outputDir, id, "result.json");
    if (!existsSync(jsonPath)) return null;
    const raw = await fs.readFile(jsonPath, "utf8");
    return JSON.parse(raw) as JobResultPayload;
  }
}

export function pagesToMarkdown(pages: { markdownText: string }[]) {
  return pages
    .map((page, index) => {
      const body = (page.markdownText || "").trim();
      if (pages.length === 1) return body;
      return `<!-- page ${index + 1} -->\n\n${body}`;
    })
    .filter(Boolean)
    .join("\n\n---\n\n");
}

export function safeBasename(name: string) {
  return path.basename(name).replace(/[^\w.\u4e00-\u9fff-]+/g, "_");
}

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}
