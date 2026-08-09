const appEl = document.getElementById("app");
const jobListEl = document.getElementById("jobList");
const statsLine = document.getElementById("statsLine");
const sourceTitle = document.getElementById("sourceTitle");
const sourceMeta = document.getElementById("sourceMeta");
const previewPane = document.getElementById("previewPane");
const resultPane = document.getElementById("resultPane");
const modelSelect = document.getElementById("model");
const uploadModel = document.getElementById("uploadModel");
const pageRanges = document.getElementById("pageRanges");
const uploadDialog = document.getElementById("uploadDialog");
const exportDialog = document.getElementById("exportDialog");
const settingsDialog = document.getElementById("settingsDialog");
const filesInput = document.getElementById("files");
const fileSummary = document.getElementById("fileSummary");
const dropzone = document.getElementById("dropzone");
const toastEl = document.getElementById("toast");
const concurrencyInput = document.getElementById("concurrencyInput");
const accessTokenInput = document.getElementById("accessTokenInput");
const clearTokenInput = document.getElementById("clearTokenInput");
const tokenStatus = document.getElementById("tokenStatus");
const tokenListEl = document.getElementById("tokenList");
const tokenHelpLink = document.getElementById("tokenHelpLink");
let settingsTokens = [];
const btnDlMd = document.getElementById("btnDlMd");
const btnDlJson = document.getElementById("btnDlJson");
const queueProgressText = document.getElementById("queueProgressText");
const queueProgressBar = document.getElementById("queueProgressBar");
const taskProgressText = document.getElementById("taskProgressText");
const taskProgressBar = document.getElementById("taskProgressBar");
const taskProgressName = document.getElementById("taskProgressName");
const exportHint = document.getElementById("exportHint");
const exportIncludeImagesEl = document.getElementById("exportIncludeImages");
const exportImagesRow = document.getElementById("exportImagesRow");

const EXPORT_IMAGES_KEY = "paddleocr.exportIncludeImages";

function getExportIncludeImages() {
  const saved = localStorage.getItem(EXPORT_IMAGES_KEY);
  if (saved === null) return true;
  return saved !== "0" && saved !== "false";
}

function setExportIncludeImages(value) {
  localStorage.setItem(EXPORT_IMAGES_KEY, value ? "1" : "0");
}

function syncExportImagesUi() {
  const format =
    exportDialog.querySelector('input[name="exportFormat"]:checked')?.value ||
    "md";
  const isMd = format === "md";
  exportImagesRow.classList.toggle("disabled", !isMd);
  exportIncludeImagesEl.disabled = !isMd;
  if (!exportDialog.open) {
    exportIncludeImagesEl.checked = getExportIncludeImages();
  }
}

function mdDownloadUrl(baseUrl) {
  if (!baseUrl) return "#";
  const url = new URL(baseUrl, window.location.origin);
  url.searchParams.set("images", getExportIncludeImages() ? "1" : "0");
  return url.pathname + url.search;
}

let jobs = [];
let latestStats = null;
let selectedId = null;
let viewMode = "md";
let detailCache = new Map();
let toastTimer = null;

const LAYOUT_KEY = "paddleocr.layout.v1";

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 2400);
}

function statusLabel(jobOrStatus) {
  if (typeof jobOrStatus === "string") {
    return {
      queued: "排队中",
      running: "解析中",
      done: "完成",
      failed: "失败",
    }[jobOrStatus] || jobOrStatus;
  }
  const job = jobOrStatus;
  if (job.status === "queued" && job.retryCount > 0) return "重试中";
  if (job.status === "done" && job.fromCache) return "缓存";
  return {
    queued: "排队中",
    running: "解析中",
    done: "完成",
    failed: "失败",
  }[job.status] || job.status;
}

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function loadLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.sidebar) appEl.style.setProperty("--sidebar-w", `${data.sidebar}px`);
    if (data.center) appEl.style.setProperty("--center-w", `${data.center}px`);
    if (data.right) appEl.style.setProperty("--right-w", `${data.right}px`);
  } catch {
    // ignore
  }
}

function saveLayout() {
  const sidebar = document.getElementById("sidebar").getBoundingClientRect().width;
  const center = document.getElementById("center").getBoundingClientRect().width;
  const right = document.getElementById("right").getBoundingClientRect().width;
  localStorage.setItem(
    LAYOUT_KEY,
    JSON.stringify({
      sidebar: Math.round(sidebar),
      center: Math.round(center),
      right: Math.round(right),
    }),
  );
}

function setupSplitters() {
  const splits = [
    { el: document.getElementById("splitLeft"), key: "left" },
    { el: document.getElementById("splitRight"), key: "right" },
  ];

  for (const { el, key } of splits) {
    el.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      el.classList.add("active");
      appEl.classList.add("resizing");
      el.setPointerCapture(event.pointerId);

      const startX = event.clientX;
      const sidebarW = document.getElementById("sidebar").getBoundingClientRect().width;
      const centerW = document.getElementById("center").getBoundingClientRect().width;
      const rightW = document.getElementById("right").getBoundingClientRect().width;
      const total = appEl.getBoundingClientRect().width - 12;

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        if (key === "left") {
          const nextSidebar = Math.min(Math.max(220, sidebarW + dx), total - 420);
          const remain = total - nextSidebar;
          const ratio = centerW / (centerW + rightW || 1);
          const nextCenter = Math.max(180, remain * ratio);
          const nextRight = Math.max(220, remain - nextCenter);
          appEl.style.setProperty("--sidebar-w", `${Math.round(nextSidebar)}px`);
          appEl.style.setProperty("--center-w", `${Math.round(nextCenter)}px`);
          appEl.style.setProperty("--right-w", `${Math.round(nextRight)}px`);
        } else {
          const nextRight = Math.min(Math.max(220, rightW - dx), total - 420);
          const remain = total - nextRight;
          const nextSidebar = Math.min(Math.max(220, sidebarW), remain - 180);
          const nextCenter = Math.max(180, remain - nextSidebar);
          appEl.style.setProperty("--sidebar-w", `${Math.round(nextSidebar)}px`);
          appEl.style.setProperty("--center-w", `${Math.round(nextCenter)}px`);
          appEl.style.setProperty("--right-w", `${Math.round(nextRight)}px`);
        }
      };

      const onUp = () => {
        el.classList.remove("active");
        appEl.classList.remove("resizing");
        el.releasePointerCapture(event.pointerId);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        saveLayout();
      };

      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
    });
  }
}

function renderProgress(stats) {
  if (!stats || !stats.total) {
    queueProgressText.textContent = "0/0 · 0%";
    queueProgressBar.style.width = "0%";
    taskProgressText.textContent = "空闲 · 0%";
    taskProgressBar.style.width = "0%";
    taskProgressBar.parentElement.classList.remove("indeterminate");
    taskProgressName.textContent = "暂无进行中的任务";
    return;
  }

  const queuePct = stats.queuePercent ?? 0;
  queueProgressText.textContent = `${stats.processed}/${stats.total} · ${queuePct}%`;
  queueProgressBar.style.width = `${queuePct}%`;

  if (stats.running > 0) {
    const pagesKnown = stats.currentTotalPages > 0;
    const taskPct = pagesKnown ? stats.currentPercent : 0;
    taskProgressText.textContent = pagesKnown
      ? `${stats.currentExtractedPages}/${stats.currentTotalPages} 页 · ${taskPct}%`
      : `解析中 · ${stats.running} 路并发`;
    taskProgressBar.style.width = pagesKnown ? `${taskPct}%` : "36%";
    taskProgressBar.parentElement.classList.toggle("indeterminate", !pagesKnown);
    taskProgressName.textContent = stats.currentJobName || "进行中…";
  } else if (stats.queued > 0) {
    taskProgressText.textContent = "等待调度 · 0%";
    taskProgressBar.style.width = "0%";
    taskProgressBar.parentElement.classList.remove("indeterminate");
    taskProgressName.textContent = "队列中还有待解析文件";
  } else {
    taskProgressText.textContent = `空闲 · 100%`;
    taskProgressBar.style.width = "100%";
    taskProgressBar.parentElement.classList.remove("indeterminate");
    taskProgressName.textContent = stats.failed
      ? `全部处理完（成功 ${stats.done} · 失败 ${stats.failed}）`
      : "全部处理完";
  }
}

function renderStats(stats) {
  latestStats = stats;
  if (!stats) {
    statsLine.textContent = "等待连接…";
    renderProgress(null);
    return;
  }
  statsLine.textContent = `共 ${stats.total} · 跑 ${stats.running}/${stats.concurrency} · 排队 ${stats.queued} · 完成 ${stats.done} · 失败 ${stats.failed}`;
  // 设置弹窗打开或正在编辑时，不要用 SSE 把并发输入框打回旧值
  if (!settingsDialog.open && document.activeElement !== concurrencyInput) {
    concurrencyInput.value = String(stats.concurrency);
  }
  renderProgress(stats);
  exportHint.textContent = `仅打包当前已完成的 ${stats.done} 个结果，不影响排队/解析中的任务。`;
}

function renderJobs() {
  if (!jobs.length) {
    jobListEl.innerHTML = `<div class="empty-hint" style="padding:24px 8px"><p class="muted">还没有任务<br/>点击「新解析」批量上传</p></div>`;
    return;
  }

  jobListEl.innerHTML = jobs
    .map((job) => {
      const active = job.id === selectedId ? "active" : "";
      const pageHint =
        job.status === "running" && job.progress?.totalPages
          ? ` · ${job.progress.extractedPages}/${job.progress.totalPages}页`
          : job.pageCount
            ? ` · ${job.pageCount}页`
            : "";
      const retryHint =
        job.status === "queued" && job.retryCount > 0
          ? ` · 限流重试 ${job.retryCount}`
          : "";
      const waitHint =
        job.status === "queued" && job.notBefore && job.notBefore > Date.now()
          ? ` · ${Math.max(1, Math.ceil((job.notBefore - Date.now()) / 1000))}s后`
          : "";
      const badgeClass =
        job.status === "queued" && job.retryCount > 0
          ? "running"
          : job.status === "done" && job.fromCache
            ? "done"
            : job.status;
      const cacheHint = job.fromCache ? " · 本地缓存" : "";
      return `
        <button type="button" class="job-item ${active}" data-id="${job.id}">
          <span class="badge ${badgeClass}">${statusLabel(job)}</span>
          <span class="job-main">
            <div class="job-name" title="${escapeHtml(job.sourceName)}">${escapeHtml(job.sourceName)}</div>
            <div class="job-sub">${formatTime(job.createdAt)} · ${job.sizeLabel}${pageHint}${retryHint}${waitHint}${cacheHint}</div>
          </span>
        </button>
      `;
    })
    .join("");
}

function selectedJob() {
  return jobs.find((j) => j.id === selectedId) || null;
}

function renderPreview(job) {
  if (!job) {
    sourceTitle.textContent = "尚未选择文件";
    sourceMeta.textContent = "";
    previewPane.classList.add("empty");
    previewPane.innerHTML = `<div class="empty-hint"><p>从左侧选择任务，或点击「新解析」批量上传</p><p class="muted">支持 100+ 文件 · 可拖动中间分隔条加宽左侧列表</p></div>`;
    return;
  }

  sourceTitle.textContent = job.sourceName;
  sourceMeta.textContent = `${job.sizeLabel}${job.pageCount ? ` · ${job.pageCount} 页` : ""} · ${job.model}`;
  previewPane.classList.remove("empty");

  if (job.isPdf) {
    previewPane.innerHTML = `<iframe class="preview-frame" title="pdf-preview" src="${job.previewUrl}"></iframe>`;
  } else if (job.isImage) {
    previewPane.innerHTML = `<img class="preview-image" alt="${escapeHtml(job.sourceName)}" src="${job.previewUrl}" />`;
  } else {
    previewPane.classList.add("empty");
    previewPane.innerHTML = `<div class="empty-hint"><p>该文件类型暂不支持预览</p></div>`;
  }
}

async function loadDetail(job, force = false) {
  if (!job) return null;
  if (!force && detailCache.has(job.id) && job.status === "done") {
    return detailCache.get(job.id);
  }
  if (job.status !== "done") return null;
  const res = await fetch(`/api/jobs/${job.id}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "加载结果失败");
  detailCache.set(job.id, data);
  return data;
}

async function renderResult() {
  const job = selectedJob();
  btnDlMd.removeAttribute("href");
  btnDlJson.removeAttribute("href");
  btnDlMd.classList.add("hidden");
  btnDlJson.classList.add("hidden");

  if (!job) {
    resultPane.classList.add("empty");
    resultPane.innerHTML = `<div class="empty-hint"><p>解析完成后在此显示 Markdown / JSON</p></div>`;
    return;
  }

  if (job.status === "queued") {
    const retryText =
      job.retryCount > 0
        ? `<br/>因限流自动重试中（第 ${job.retryCount} 次），无需手动操作`
        : "";
    const waitText =
      job.notBefore && job.notBefore > Date.now()
        ? `<br/>约 ${Math.max(1, Math.ceil((job.notBefore - Date.now()) / 1000))} 秒后再次调度`
        : "";
    resultPane.classList.remove("empty");
    resultPane.innerHTML = `<div class="result-status">已在队列中等待，前面还有任务时会自动开始…${retryText}${waitText}</div>`;
    return;
  }

  if (job.status === "running") {
    const extracted = job.progress?.extractedPages || 0;
    const total = job.progress?.totalPages || 0;
    const elapsedSec = job.startedAt
      ? Math.max(0, Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000))
      : 0;
    const speed =
      elapsedSec > 0 && extracted > 0
        ? `${((extracted / elapsedSec) * 60).toFixed(1)} 页/分钟`
        : null;
    const progress =
      total > 0
        ? `已解析 ${extracted}/${total} 页 · 已用时 ${elapsedSec}s${speed ? ` · ${speed}` : ""}`
        : "正在提交并等待官方 API…";
    resultPane.classList.remove("empty");
    resultPane.innerHTML = `<div class="result-status">${progress}<br/>未卡住：PaddleOCR-VL 对多页大 PDF 本来就慢，多路并发还会互相抢配额。左侧页数在涨就说明还在跑。</div>`;
    return;
  }

  if (job.status === "failed") {
    resultPane.classList.remove("empty");
    resultPane.innerHTML = `<div class="result-status error">${escapeHtml(job.error || "解析失败")}</div>`;
    return;
  }

  try {
    const detail = await loadDetail(job);
    if (!detail) return;
    resultPane.classList.remove("empty");
    if (job.downloads) {
      btnDlMd.href = mdDownloadUrl(job.downloads.markdown);
      btnDlJson.href = job.downloads.json;
      btnDlMd.classList.remove("hidden");
      btnDlJson.classList.remove("hidden");
    }

    if (viewMode === "json") {
      resultPane.innerHTML = `<pre class="result-content">${escapeHtml(JSON.stringify(detail.json, null, 2))}</pre>`;
    } else {
      resultPane.innerHTML = `<pre class="result-content result-md">${escapeHtml(detail.markdown || "(空结果)")}</pre>`;
    }
  } catch (err) {
    resultPane.classList.remove("empty");
    resultPane.innerHTML = `<div class="result-status error">${escapeHtml(err.message || String(err))}</div>`;
  }
}

async function selectJob(id) {
  selectedId = id;
  const job = selectedJob();
  if (job) modelSelect.value = job.model;
  renderJobs();
  renderPreview(job);
  await renderResult();
}

function applySnapshot(payload) {
  const prev = selectedJob();
  jobs = payload.jobs || [];
  renderStats(payload.stats);
  renderJobs();

  if (selectedId && !jobs.some((j) => j.id === selectedId)) {
    selectedId = jobs[0]?.id || null;
  }
  if (!selectedId && jobs[0]) selectedId = jobs[0].id;

  const current = selectedJob();
  if (!current) {
    renderPreview(null);
    renderResult();
    return;
  }

  const selectedChanged = !prev || prev.id !== current.id;
  const statusChanged = !prev || prev.status !== current.status || selectedChanged;
  const prevProgress = JSON.stringify(prev?.progress || null);
  const currProgress = JSON.stringify(current.progress || null);
  const progressChanged = prevProgress !== currProgress;
  const startedChanged = prev?.startedAt !== current.startedAt;

  if (selectedChanged) {
    renderPreview(current);
  }
  // 解析中时每次推送都刷新右侧进度，避免停在 0/N 的错觉
  if (
    statusChanged ||
    progressChanged ||
    startedChanged ||
    current.status === "running"
  ) {
    if (current.status === "done" && prev?.status !== "done") {
      detailCache.delete(current.id);
    }
    renderResult();
  }
}

function connectEvents() {
  const es = new EventSource("/api/events");
  es.onmessage = (event) => {
    try {
      applySnapshot(JSON.parse(event.data));
    } catch (err) {
      console.error(err);
    }
  };
  es.onerror = () => {
    statsLine.textContent = "实时连接中断，正在重试…";
  };
}

function renderTokenList(tokens = []) {
  settingsTokens = tokens;
  if (!tokens.length) {
    tokenListEl.innerHTML = "";
    return;
  }
  tokenListEl.innerHTML = tokens
    .map((token) => {
      const cooling =
        token.coolingMs > 0
          ? ` · 冷却 ${Math.ceil(token.coolingMs / 1000)}s`
          : "";
      return `
        <div class="token-chip" data-index="${token.index}">
          <span>#${token.index + 1} ${escapeHtml(token.masked || "****")}<span class="meta">${cooling}</span></span>
          <button type="button" data-remove-token="${token.index}">移除</button>
        </div>
      `;
    })
    .join("");
}

async function refreshHealth() {
  try {
    const res = await fetch("/api/settings");
    const data = await res.json();
    concurrencyInput.value = String(data.concurrency || 2);
    accessTokenInput.value = "";
    clearTokenInput.checked = false;
    if (data.tokenHelpUrl) tokenHelpLink.href = data.tokenHelpUrl;
    renderTokenList(data.tokens || []);
    if (data.tokenConfigured) {
      tokenStatus.textContent = `Token 池 ${data.tokenCount} 个 · 可用 ${data.availableCount ?? data.tokenCount}`;
      tokenStatus.className = "token-status ok";
      accessTokenInput.placeholder = "继续添加更多 Token（每行一个），可提高限流上限";
    } else {
      tokenStatus.textContent = "尚未配置 Access Token，解析前请先添加";
      tokenStatus.className = "token-status warn";
      accessTokenInput.placeholder = "粘贴一个或多个 Token，每行一个";
    }
  } catch {
    tokenStatus.textContent = "无法连接本地服务";
    tokenStatus.className = "token-status warn";
  }
}

const SUPPORTED_RE = /\.(pdf|png|jpe?g|bmp|tif{1,2}|webp)$/i;

function isSupportedFile(file) {
  return (
    file.type === "application/pdf" ||
    file.type.startsWith("image/") ||
    SUPPORTED_RE.test(file.name)
  );
}

function splitFiles(list) {
  const accepted = [];
  const skipped = [];
  for (const file of list) {
    if (isSupportedFile(file)) accepted.push(file);
    else skipped.push(file);
  }
  return { accepted, skipped };
}

function updateFileSummary() {
  const list = [...(filesInput.files || [])];
  if (!list.length) {
    fileSummary.textContent = "尚未选择文件";
    return;
  }
  const { accepted, skipped } = splitFiles(list);
  const total = accepted.reduce((sum, f) => sum + f.size, 0);
  const sizeLabel = `${(total / (1024 * 1024)).toFixed(2)} MB`;
  if (skipped.length) {
    fileSummary.textContent = `可解析 ${accepted.length} 个（${sizeLabel}）· 将跳过 ${skipped.length} 个不支持格式`;
  } else {
    fileSummary.textContent = `已选 ${accepted.length} 个文件 · ${sizeLabel}`;
  }
}

async function readErrorPayload(res) {
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  try {
    const text = await res.text();
    return { error: text || `请求失败（${res.status}）` };
  } catch {
    return { error: `请求失败（${res.status}）` };
  }
}

async function enqueueFiles() {
  const list = [...(filesInput.files || [])];
  if (!list.length) {
    toast("请先选择文件");
    return;
  }

  const { accepted, skipped: localSkipped } = splitFiles(list);
  if (!accepted.length) {
    toast(`没有可解析文件（已忽略 ${localSkipped.length} 个不支持格式）`);
    return;
  }
  if (accepted.length > 200) {
    toast("可解析文件超过 200 个，请分批上传");
    return;
  }

  const body = new FormData();
  for (const file of accepted) body.append("files", file);
  body.append("model", uploadModel.value);
  const ranges = pageRanges.value.trim();
  if (ranges) body.append("pageRanges", ranges);

  const btn = document.getElementById("btnEnqueue");
  btn.disabled = true;
  try {
    const res = await fetch("/api/jobs", { method: "POST", body });
    const data = await readErrorPayload(res);
    if (!res.ok) {
      const skippedHint = data?.skipped?.length
        ? `（另跳过 ${data.skipped.length} 个）`
        : "";
      throw new Error(`${data?.error || "入队失败"}${skippedHint}`);
    }
    modelSelect.value = uploadModel.value;
    uploadDialog.close();
    filesInput.value = "";
    updateFileSummary();
    if (data.created?.[0]) await selectJob(data.created[0].id);

    const skippedCount = (data.skippedCount || 0) + localSkipped.length;
    const cacheHits = data.cacheHits || 0;
    const parts = [`入队 ${data.acceptedCount ?? data.created.length}`];
    if (cacheHits > 0) parts.push(`缓存命中 ${cacheHits}`);
    if (skippedCount > 0) parts.push(`跳过 ${skippedCount}`);
    toast(parts.join(" · "));
  } catch (err) {
    toast(err.message || String(err));
  } finally {
    btn.disabled = false;
  }
}

async function exportDoneBatch() {
  const format =
    exportDialog.querySelector('input[name="exportFormat"]:checked')?.value ||
    "md";
  const includeImages = format === "md" && exportIncludeImagesEl.checked;
  if (format === "md") setExportIncludeImages(includeImages);

  const doneIds = jobs.filter((j) => j.status === "done").map((j) => j.id);
  if (!doneIds.length) {
    toast("还没有已完成的结果可导出");
    return;
  }

  const btn = document.getElementById("btnDoExport");
  btn.disabled = true;
  try {
    const res = await fetch("/api/download-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format, ids: doneIds, includeImages }),
    });
    const contentType = res.headers.get("content-type") || "";
    if (!res.ok) {
      const data = contentType.includes("json")
        ? await res.json()
        : { error: await res.text() };
      throw new Error(data.error || "导出失败");
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `paddleocr-${format}-done-${doneIds.length}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    exportDialog.close();
    const imgNote =
      format === "md" ? (includeImages ? "含图片" : "不含图片") : null;
    toast(
      `已导出 ${doneIds.length} 个已完成结果（${format.toUpperCase()}${
        imgNote ? " · " + imgNote : ""
      }）`,
    );
    // 同步单文件 MD 链接上的 images 参数
    const job = selectedJob();
    if (job?.downloads?.markdown) {
      btnDlMd.href = mdDownloadUrl(job.downloads.markdown);
    }
  } catch (err) {
    toast(err.message || String(err));
  } finally {
    btn.disabled = false;
  }
}

jobListEl.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-id]");
  if (!btn) return;
  selectJob(btn.dataset.id);
});

document.getElementById("btnNew").addEventListener("click", () => {
  uploadModel.value = modelSelect.value;
  uploadDialog.showModal();
});

document.getElementById("btnSettings").addEventListener("click", async () => {
  await refreshHealth();
  settingsDialog.showModal();
});

document.getElementById("btnEnqueue").addEventListener("click", enqueueFiles);

tokenListEl.addEventListener("click", async (event) => {
  const btn = event.target.closest("[data-remove-token]");
  if (!btn) return;
  const index = Number(btn.getAttribute("data-remove-token"));
  const res = await fetch("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ removeTokenIndex: index }),
  });
  const data = await res.json();
  if (!res.ok) {
    toast(data.error || "移除失败");
    return;
  }
  toast(`已移除 Token，剩余 ${data.tokenCount} 个`);
  await refreshHealth();
});

document.getElementById("btnSaveSettings").addEventListener("click", async () => {
  // 先固定读出输入，避免保存过程中被其它逻辑改掉
  const concurrency = Number(concurrencyInput.value);
  const clearTokens = clearTokenInput.checked;
  const tokenText = accessTokenInput.value.trim();
  if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 8) {
    toast("并发数需为 1–8");
    return;
  }

  const payload = { concurrency, clearTokens };
  if (tokenText) payload.addTokens = tokenText;

  const btn = document.getElementById("btnSaveSettings");
  btn.disabled = true;
  try {
    const res = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      toast(data.error || "保存失败");
      return;
    }

    concurrencyInput.value = String(data.concurrency);
    const parts = [`并发 ${data.concurrency}`];
    if (payload.clearTokens) parts.push("Token 已清空");
    else if (data.tokenUpdated) parts.push(`Token 池 ${data.tokenCount} 个`);
    else if (data.tokenConfigured) parts.push(`Token 池 ${data.tokenCount} 个`);
    else parts.push("尚未配置 Token");

    toast(`设置已保存：${parts.join(" · ")}`);
    settingsDialog.close();
    await refreshHealth();
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btnClear").addEventListener("click", async () => {
  const res = await fetch("/api/jobs/clear-finished", { method: "POST" });
  const data = await res.json();
  if (!res.ok) {
    toast(data.error || "清理失败");
    return;
  }
  detailCache.clear();
  toast(`已清理 ${data.removed} 个任务`);
});

document.getElementById("btnExportAll").addEventListener("click", () => {
  const doneCount = jobs.filter((j) => j.status === "done").length;
  exportHint.textContent = `仅打包当前已完成的 ${doneCount} 个结果，不影响排队/解析中的任务。`;
  exportIncludeImagesEl.checked = getExportIncludeImages();
  syncExportImagesUi();
  exportDialog.showModal();
});

exportDialog.querySelectorAll('input[name="exportFormat"]').forEach((el) => {
  el.addEventListener("change", syncExportImagesUi);
});
exportIncludeImagesEl.addEventListener("change", () => {
  if (!exportIncludeImagesEl.disabled) {
    setExportIncludeImages(exportIncludeImagesEl.checked);
    const job = selectedJob();
    if (job?.downloads?.markdown) {
      btnDlMd.href = mdDownloadUrl(job.downloads.markdown);
    }
  }
});

document.getElementById("btnDoExport").addEventListener("click", exportDoneBatch);

document.getElementById("btnCopy").addEventListener("click", async () => {
  const job = selectedJob();
  if (!job || job.status !== "done") {
    toast("当前没有可复制的结果");
    return;
  }
  const detail = await loadDetail(job);
  const text =
    viewMode === "json"
      ? JSON.stringify(detail.json, null, 2)
      : detail.markdown || "";
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制到剪贴板");
  } catch {
    toast("复制失败");
  }
});

document.getElementById("btnRetry").addEventListener("click", async () => {
  const job = selectedJob();
  if (!job) return;
  const res = await fetch(`/api/jobs/${job.id}/retry`, { method: "POST" });
  const data = await res.json();
  if (!res.ok) {
    toast(data.error || "重试失败");
    return;
  }
  detailCache.delete(job.id);
  toast("已重新入队");
});

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    viewMode = btn.dataset.view;
    document.querySelectorAll(".tab-btn").forEach((el) => {
      el.classList.toggle("active", el === btn);
    });
    renderResult();
  });
});

filesInput.addEventListener("change", updateFileSummary);

["dragenter", "dragover"].forEach((name) => {
  dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    dropzone.classList.add("dragover");
  });
});
["dragleave", "drop"].forEach((name) => {
  dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragover");
  });
});
dropzone.addEventListener("drop", (event) => {
  const list = event.dataTransfer?.files;
  if (!list?.length) return;
  const transfer = new DataTransfer();
  for (const file of list) transfer.items.add(file);
  filesInput.files = transfer.files;
  updateFileSummary();
});

["dragenter", "dragover"].forEach((name) => {
  window.addEventListener(name, (event) => {
    if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
  });
});
window.addEventListener("drop", (event) => {
  if (!event.dataTransfer?.files?.length) return;
  if (uploadDialog.open) return;
  event.preventDefault();
  const transfer = new DataTransfer();
  for (const file of event.dataTransfer.files) transfer.items.add(file);
  filesInput.files = transfer.files;
  updateFileSummary();
  uploadDialog.showModal();
});

loadLayout();
setupSplitters();
connectEvents();
refreshHealth();
fetch("/api/jobs")
  .then((res) => res.json())
  .then(applySnapshot)
  .catch(() => {
    statsLine.textContent = "无法加载任务列表";
  });
