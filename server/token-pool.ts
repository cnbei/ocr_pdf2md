import { PaddleOCRClient } from "@paddleocr/api-sdk";

export function normalizeTokens(input: unknown): string[] {
  const list: string[] = [];
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") list.push(item);
    }
  } else if (typeof input === "string") {
    list.push(
      ...input
        .split(/[\n,;]+/)
        .map((x) => x.trim())
        .filter(Boolean),
    );
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of list) {
    const token = raw.trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
  }
  return unique;
}

export function maskToken(token: string) {
  const value = token.trim();
  if (!value) return null;
  if (value.length <= 8) return `${value.slice(0, 2)}****`;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export class TokenPool {
  private tokens: string[] = [];
  private coolUntil = new Map<string, number>();
  private clients = new Map<string, PaddleOCRClient>();
  private rr = 0;

  setTokens(tokens: string[]) {
    this.tokens = normalizeTokens(tokens);
    const keep = new Set(this.tokens);
    for (const key of this.clients.keys()) {
      if (!keep.has(key)) this.clients.delete(key);
    }
    for (const key of this.coolUntil.keys()) {
      if (!keep.has(key)) this.coolUntil.delete(key);
    }
    if (this.rr >= this.tokens.length) this.rr = 0;
  }

  list() {
    return [...this.tokens];
  }

  count() {
    return this.tokens.length;
  }

  hasTokens() {
    return this.tokens.length > 0;
  }

  availableCount(now = Date.now()) {
    return this.tokens.filter((t) => (this.coolUntil.get(t) || 0) <= now).length;
  }

  /** 选择一个当前最可用的 Token；若都在冷却，返回冷却最快结束的那个 */
  pick(): { token: string; waitMs: number } {
    if (!this.tokens.length) {
      throw Object.assign(new Error("未配置 Access Token"), {
        status: 503,
        code: "MISSING_TOKEN",
      });
    }

    const now = Date.now();
    for (let i = 0; i < this.tokens.length; i++) {
      const idx = (this.rr + i) % this.tokens.length;
      const token = this.tokens[idx];
      const until = this.coolUntil.get(token) || 0;
      if (until <= now) {
        this.rr = (idx + 1) % this.tokens.length;
        return { token, waitMs: 0 };
      }
    }

    let best = this.tokens[0];
    let bestUntil = this.coolUntil.get(best) || now;
    for (const token of this.tokens) {
      const until = this.coolUntil.get(token) || now;
      if (until < bestUntil) {
        best = token;
        bestUntil = until;
      }
    }
    return { token: best, waitMs: Math.max(0, bestUntil - now) };
  }

  markRateLimited(token: string, ms: number) {
    const until = Date.now() + Math.max(1000, ms);
    const prev = this.coolUntil.get(token) || 0;
    this.coolUntil.set(token, Math.max(prev, until));
  }

  getClient(token: string) {
    let client = this.clients.get(token);
    if (!client) {
      client = new PaddleOCRClient({
        token,
        requestTimeout: 300_000,
        pollTimeout: 900_000,
      });
      this.clients.set(token, client);
    }
    return client;
  }

  resetClients() {
    this.clients.clear();
  }

  publicView() {
    const now = Date.now();
    return {
      tokenCount: this.tokens.length,
      tokenConfigured: this.tokens.length > 0,
      tokens: this.tokens.map((token, index) => ({
        index,
        masked: maskToken(token),
        coolingMs: Math.max(0, (this.coolUntil.get(token) || 0) - now),
      })),
      availableCount: this.availableCount(now),
    };
  }
}
