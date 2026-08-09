import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyImagesDir, ensureMarkdownImages } from "./images.js";

export interface CacheMeta {
  contentHash: string;
  model: string;
  pageRanges: string;
  sourceName: string;
  size: number;
  pageCount: number;
  cachedAt: string;
}

function modelKey(model: string) {
  return model.replace(/[^\w.-]+/g, "_");
}

function rangesKey(pageRanges?: string) {
  return (pageRanges || "all").replace(/[^\w.,-]+/g, "_");
}

export class ResultCache {
  constructor(private cacheDir: string) {}

  private entryDir(contentHash: string, model: string, pageRanges?: string) {
    return path.join(
      this.cacheDir,
      contentHash,
      `${modelKey(model)}__${rangesKey(pageRanges)}`,
    );
  }

  async ensureReady() {
    await fs.mkdir(this.cacheDir, { recursive: true });
  }

  async hashFile(filePath: string): Promise<string> {
    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve());
    });
    return hash.digest("hex");
  }

  async lookup(
    contentHash: string,
    model: string,
    pageRanges?: string,
  ): Promise<{ dir: string; meta: CacheMeta } | null> {
    const dir = this.entryDir(contentHash, model, pageRanges);
    const metaPath = path.join(dir, "meta.json");
    const mdPath = path.join(dir, "result.md");
    const jsonPath = path.join(dir, "result.json");
    if (!existsSync(metaPath) || !existsSync(mdPath) || !existsSync(jsonPath)) {
      return null;
    }
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, "utf8")) as CacheMeta;
      return { dir, meta };
    } catch {
      return null;
    }
  }

  async save(params: {
    contentHash: string;
    model: string;
    pageRanges?: string;
    sourceName: string;
    size: number;
    pageCount: number;
    markdown: string;
    jsonText: string;
    /** 已写好结果的输出目录，用于同步 imgs/ */
    sourceOutputDir?: string;
    pages?: Array<{ markdownImages?: Record<string, string> | null }>;
  }) {
    const dir = this.entryDir(
      params.contentHash,
      params.model,
      params.pageRanges,
    );
    await fs.mkdir(dir, { recursive: true });
    const meta: CacheMeta = {
      contentHash: params.contentHash,
      model: params.model,
      pageRanges: params.pageRanges || "all",
      sourceName: params.sourceName,
      size: params.size,
      pageCount: params.pageCount,
      cachedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
    await fs.writeFile(path.join(dir, "result.md"), params.markdown, "utf8");
    await fs.writeFile(path.join(dir, "result.json"), params.jsonText, "utf8");

    if (params.sourceOutputDir) {
      await copyImagesDir(params.sourceOutputDir, dir);
    }
    // 缓存里也确保图片齐全（可从 URL 补下）
    await ensureMarkdownImages(dir, params.pages).catch((err) =>
      console.warn("[cache] 图片同步失败", err),
    );
    return dir;
  }

  async materializeToOutput(cacheDir: string, outputDir: string) {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.copyFile(
      path.join(cacheDir, "result.md"),
      path.join(outputDir, "result.md"),
    );
    await fs.copyFile(
      path.join(cacheDir, "result.json"),
      path.join(outputDir, "result.json"),
    );
    await copyImagesDir(cacheDir, outputDir);
    // 旧缓存可能没有图片，导出前再补下
    await ensureMarkdownImages(outputDir).catch((err) =>
      console.warn("[cache] 物化时补图失败", err),
    );
  }
}
