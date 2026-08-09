import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

type PageLike = { markdownImages?: Record<string, string> | null };

function collectImageMap(pages: PageLike[] | undefined) {
  const map: Record<string, string> = {};
  for (const page of pages || []) {
    const images = page.markdownImages || {};
    for (const [rel, url] of Object.entries(images)) {
      if (rel && url) map[rel] = url;
    }
  }
  return map;
}

async function loadImageMapFromResultJson(outputDir: string) {
  const jsonPath = path.join(outputDir, "result.json");
  if (!existsSync(jsonPath)) return {} as Record<string, string>;
  try {
    const data = JSON.parse(await fs.readFile(jsonPath, "utf8")) as {
      pages?: PageLike[];
    };
    return collectImageMap(data.pages);
  } catch {
    return {};
  }
}

/** 把 markdownImages 下载到目录中，保持 imgs/xxx.jpg 相对路径 */
export async function ensureMarkdownImages(
  outputDir: string,
  pages?: PageLike[],
): Promise<{ total: number; downloaded: number; failed: number }> {
  const map = pages?.length
    ? collectImageMap(pages)
    : await loadImageMapFromResultJson(outputDir);

  let downloaded = 0;
  let failed = 0;
  const entries = Object.entries(map);
  if (!entries.length) return { total: 0, downloaded: 0, failed: 0 };

  for (const [relPath, url] of entries) {
    if (!/^https?:\/\//i.test(url)) continue;
    // 只允许相对图片路径，防止路径穿越
    const normalized = path.normalize(relPath).replace(/^(\.\.[/\\])+/, "");
    if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
      failed += 1;
      continue;
    }
    const target = path.join(outputDir, normalized);
    try {
      if (existsSync(target)) {
        const st = await fs.stat(target);
        if (st.isFile() && st.size > 0) continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      const res = await fetch(url, {
        headers: { "User-Agent": "paddleocr-local/1.0" },
      });
      if (!res.ok) {
        failed += 1;
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) {
        failed += 1;
        continue;
      }
      await fs.writeFile(target, buf);
      downloaded += 1;
    } catch (err) {
      failed += 1;
      console.warn(`[images] 下载失败 ${normalized}`, err);
    }
  }

  return { total: entries.length, downloaded, failed };
}

export async function copyImagesDir(srcDir: string, destDir: string) {
  const srcImgs = path.join(srcDir, "imgs");
  if (!existsSync(srcImgs)) return;
  await fs.cp(srcImgs, path.join(destDir, "imgs"), { recursive: true });
}

export async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    if (!existsSync(dir)) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(rootDir);
  return out;
}
