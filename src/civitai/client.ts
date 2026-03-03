import type { AppConfig } from "../config";
import { logger } from "../logger";
import type { AuthState, CivitaiRequestSpec, FetchResult } from "../types";

export interface FeedFetchOptions {
  cookies: string;
  cursor?: string | null;
  limit?: number;
  author?: string | null;
  authorMode?: boolean;
}

export class CivitaiClient {
  constructor(private readonly config: AppConfig, private spec: CivitaiRequestSpec | null) {}

  setRequestSpec(spec: CivitaiRequestSpec | null): void {
    this.spec = spec;
  }

  getRequestSpec(): CivitaiRequestSpec | null {
    return this.spec;
  }

  async validateAuth(cookies: string): Promise<AuthState> {
    const checkedAt = new Date().toISOString();

    if (!cookies.trim()) {
      return {
        isValid: false,
        checkedAt,
        failureReason: "No cookies provided"
      };
    }

    const spec = this.spec;
    if (!spec) {
      return {
        isValid: false,
        checkedAt,
        failureReason: "Missing Civitai request spec. Generate data/civitai-request-spec.json from HAR."
      };
    }

    const result = await this.fetchFeedRaw({ cookies });
    if (result.ok) {
      return { isValid: true, checkedAt };
    }

    return {
      isValid: false,
      checkedAt,
      failureReason: result.error ?? `Auth check failed (${result.status})`
    };
  }

  async fetchFeedRaw(options: FeedFetchOptions): Promise<FetchResult> {
    const spec = this.spec;
    if (!spec) {
      return {
        ok: false,
        status: 500,
        error: "Missing request spec"
      };
    }

    const request = this.buildRequest(spec, options);
    return this.executeFeedRequest(request);
  }

  async fetchAuthorFeedRaw(options: FeedFetchOptions & { author: string }): Promise<FetchResult> {
    const spec = this.spec;
    if (!spec) {
      return {
        ok: false,
        status: 500,
        error: "Missing request spec"
      };
    }

    const request = this.buildRequest(spec, {
      ...options,
      authorMode: true
    });
    return this.executeFeedRequest(request);
  }

  async fetchAuthorOverview(author: string, cookies?: string): Promise<{ ok: true; videoCount: number } | { ok: false; status: number; error: string }> {
    const username = author.trim();
    if (!username) {
      return { ok: false, status: 400, error: "author is required" };
    }

    const input = JSON.stringify({ json: { username } });
    const url = `https://civitai.com/api/trpc/userProfile.overview?input=${encodeURIComponent(input)}`;
    const baseHeaders: Record<string, string> = {
      Accept: "*/*",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SlopScroll/1.0",
      Referer: `https://civitai.com/user/${encodeURIComponent(username)}/videos`
    };

    const timeoutMs = Math.max(1200, Math.min(this.config.civitai.requestTimeoutMs, 4000));
    const maxRetries = 1;
    const attempts: Array<Record<string, string>> = [baseHeaders];
    if (cookies && cookies.trim()) {
      attempts.push({
        ...baseHeaders,
        Cookie: cookies
      });
    }

    let lastError: { status: number; error: string } = { status: 0, error: "Unknown author overview failure" };
    for (const headers of attempts) {
      const result = await this.requestAuthorOverview(url, headers, timeoutMs, maxRetries, username);
      if (result.ok) {
        return result;
      }
      lastError = { status: result.status, error: result.error };
    }

    return { ok: false, status: lastError.status, error: lastError.error };
  }

  private async executeFeedRequest(request: { url: string; init: RequestInit }): Promise<FetchResult> {
    const retries = Math.max(0, this.config.civitai.maxDownloadRetries - 1);

    let attempt = 0;
    while (attempt <= retries) {
      attempt += 1;
      try {
        const response = await fetch(request.url, request.init);
        const status = response.status;

        if (status === 401 || status === 403) {
          return {
            ok: false,
            status,
            error: "Unauthorized or expired cookies"
          };
        }

        if (status >= 500 && attempt <= retries) {
          await this.sleep(250 * attempt);
          continue;
        }

        const text = await response.text();
        let body: unknown = null;

        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = { raw: text };
        }

        if (!response.ok) {
          return {
            ok: false,
            status,
            body,
            error: `Feed request failed with ${status}`
          };
        }

        return {
          ok: true,
          status,
          body
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("civitai.feed.request_error", { attempt, message });
        if (attempt <= retries) {
          await this.sleep(250 * attempt);
          continue;
        }

        return {
          ok: false,
          status: 0,
          error: message
        };
      }
    }

    return {
      ok: false,
      status: 0,
      error: "Unknown fetch failure"
    };
  }

  async downloadMedia(url: string, cookies: string, referer?: string): Promise<Response> {
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SlopScroll/1.0",
      Accept: "*/*",
      Referer: referer && referer.trim() ? referer : "https://civitai.com/videos",
      Origin: "https://civitai.com",
      Cookie: cookies
    };

    const init: RequestInit = {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(this.config.civitai.downloadTimeoutMs)
    };

    return fetch(url, init);
  }

  async fetchVideoSourceCandidatesFromPage(pageUrl: string, cookies: string): Promise<string[]> {
    const target = pageUrl.trim();
    if (!target) {
      return [];
    }

    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SlopScroll/1.0",
      Accept: "text/html,application/xhtml+xml",
      Referer: "https://civitai.com/videos",
      Cookie: cookies
    };

    try {
      const response = await fetch(target, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(Math.max(1500, Math.min(this.config.civitai.requestTimeoutMs, 7000)))
      });

      if (!response.ok) {
        logger.warn("civitai.page_sources.non_ok", {
          pageUrl: target,
          status: response.status
        });
        return [];
      }

      const html = await response.text();
      const urls = this.extractVideoUrlsFromHtml(html);
      logger.info("civitai.page_sources.extracted", {
        pageUrl: target,
        found: urls.length
      });
      return urls;
    } catch (error) {
      logger.warn("civitai.page_sources.failed", {
        pageUrl: target,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  private buildRequest(spec: CivitaiRequestSpec, options: FeedFetchOptions): { url: string; init: RequestInit } {
    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SlopScroll/1.0",
      ...(spec.headers ?? {})
    };

    headers.Cookie = options.cookies;
    if (options.authorMode && options.author) {
      headers.Referer = `https://civitai.com/user/${encodeURIComponent(options.author)}/videos`;
    }

    const baseQuery: Record<string, string> = { ...(spec.query ?? {}) };
    const trpcHandled = this.applyTrpcInputOverrides(baseQuery, options);

    if (!trpcHandled) {
      this.applyGenericQueryOverrides(baseQuery, options);

      if (options.limit !== undefined && spec.limitParam) {
        baseQuery[spec.limitParam] = String(options.limit);
      }
      if (options.cursor && spec.cursorParam) {
        baseQuery[spec.cursorParam] = String(options.cursor);
      }
    }

    const timeoutSignal = AbortSignal.timeout(this.config.civitai.requestTimeoutMs);

    if (spec.method === "POST") {
      return {
        url: spec.endpoint,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...headers
          },
          body: JSON.stringify(baseQuery),
          signal: timeoutSignal
        }
      };
    }

    const url = new URL(spec.endpoint);
    for (const [key, value] of Object.entries(baseQuery)) {
      url.searchParams.set(key, this.normalizeQueryValue(key, value));
    }

    return {
      url: url.toString(),
      init: {
        method: "GET",
        headers,
        signal: timeoutSignal
      }
    };
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async requestAuthorOverview(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
    retries: number,
    username: string
  ): Promise<{ ok: true; videoCount: number } | { ok: false; status: number; error: string }> {
    let attempt = 0;
    while (attempt <= retries) {
      attempt += 1;
      try {
        const response = await fetch(url, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(timeoutMs)
        });

        if (response.status === 401 || response.status === 403) {
          return { ok: false, status: response.status, error: "Unauthorized or expired cookies" };
        }

        if (response.status >= 500 && attempt <= retries) {
          await this.sleep(180 * attempt);
          continue;
        }

        const text = await response.text();
        let body: unknown = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = null;
        }

        if (!response.ok) {
          return { ok: false, status: response.status, error: `Author overview failed with ${response.status}` };
        }

        const videoCount = this.extractAuthorVideoCount(body);
        if (videoCount == null) {
          return { ok: false, status: response.status, error: "Author overview missing videoCount" };
        }

        return { ok: true, videoCount };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("civitai.author_overview.request_error", { attempt, username, message });
        if (attempt <= retries) {
          await this.sleep(180 * attempt);
          continue;
        }
        return { ok: false, status: 0, error: message };
      }
    }

    return { ok: false, status: 0, error: "Unknown author overview failure" };
  }

  private applyTrpcInputOverrides(baseQuery: Record<string, string>, options: FeedFetchOptions): boolean {
    if (!Object.prototype.hasOwnProperty.call(baseQuery, "input")) {
      return false;
    }

    const rawInput = baseQuery.input;
    if (!rawInput) {
      return false;
    }

    const parsed = this.parseTrpcInput(rawInput);
    if (!parsed) {
      return false;
    }

    const payload = parsed.payload as Record<string, unknown>;
    const json = payload.json;
    if (!json || typeof json !== "object") {
      return false;
    }

    const jsonObj = json as Record<string, unknown>;

    if (options.authorMode && options.author) {
      jsonObj.username = options.author;
      jsonObj.types = ["video"];
      jsonObj.period = "AllTime";
      delete jsonObj.excludedTagIds;
      delete jsonObj.followed;
    }

    if (options.cursor) {
      jsonObj.cursor = options.cursor;

      const meta = payload.meta;
      if (meta && typeof meta === "object") {
        const metaObj = meta as Record<string, unknown>;
        const values = metaObj.values;
        if (values && typeof values === "object") {
          const valuesObj = values as Record<string, unknown>;
          delete valuesObj.cursor;
        }
        if (Object.keys(metaObj).length === 0) {
          delete payload.meta;
        }
      }
    } else if (options.authorMode) {
      jsonObj.cursor = null;
    }

    if (options.limit !== undefined && options.limit > 0) {
      if (typeof jsonObj.limit === "number") {
        jsonObj.limit = options.limit;
      } else if (typeof jsonObj.perPage === "number") {
        jsonObj.perPage = options.limit;
      } else if (typeof jsonObj.pageSize === "number") {
        jsonObj.pageSize = options.limit;
      } else if (typeof jsonObj.count === "number") {
        jsonObj.count = options.limit;
      } else {
        jsonObj.limit = options.limit;
      }
    }

    const serialized = JSON.stringify(payload);
    baseQuery.input = parsed.wasEncoded ? encodeURIComponent(serialized) : serialized;
    return true;
  }

  private applyGenericQueryOverrides(baseQuery: Record<string, string>, options: FeedFetchOptions): void {
    if (!options.authorMode || !options.author) {
      return;
    }

    baseQuery.username = options.author;
    baseQuery.period = "AllTime";
    baseQuery.type = "video";
    baseQuery.types = "video";
  }

  private parseTrpcInput(raw: string): { payload: unknown; wasEncoded: boolean } | null {
    try {
      const decoded = decodeURIComponent(raw);
      const parsed = JSON.parse(decoded) as unknown;
      if (parsed && typeof parsed === "object") {
        return { payload: parsed, wasEncoded: true };
      }
    } catch {
      // continue
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") {
        return { payload: parsed, wasEncoded: false };
      }
    } catch {
      // noop
    }

    return null;
  }

  private normalizeQueryValue(key: string, value: string): string {
    if (key !== "input") {
      return value;
    }

    try {
      const decoded = decodeURIComponent(value);
      if (decoded && decoded !== value) {
        return decoded;
      }
    } catch {
      // keep original
    }

    return value;
  }

  private extractVideoUrlsFromHtml(html: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (value: string): void => {
      const normalized = value
        .replaceAll("\\u0026", "&")
        .replaceAll("&amp;", "&")
        .trim();

      if (!normalized || seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      out.push(normalized);
    };

    const patterns = [
      /https:\/\/image(?:-b2)?\.civitai\.com\/[^"'<>\\\s]+\.(?:webm|mp4)/gi,
      /https:\/\/image(?:-b2)?\.civitai\.com\/[^"'<>\\\s]+\/original/gi
    ];

    for (const pattern of patterns) {
      let match: RegExpExecArray | null = null;
      while ((match = pattern.exec(html)) !== null) {
        push(match[0]);
      }
    }

    return out;
  }

  private extractAuthorVideoCount(body: unknown): number | null {
    return this.findNumberByKey(body, "videoCount", 8);
  }

  private findNumberByKey(value: unknown, key: string, depth: number): number | null {
    if (depth < 0 || !value) {
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const result = this.findNumberByKey(item, key, depth - 1);
        if (result != null) {
          return result;
        }
      }
      return null;
    }

    if (typeof value !== "object") {
      return null;
    }

    const obj = value as Record<string, unknown>;
    const direct = obj[key];
    if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) {
      return Math.floor(direct);
    }

    for (const nested of Object.values(obj)) {
      const result = this.findNumberByKey(nested, key, depth - 1);
      if (result != null) {
        return result;
      }
    }

    return null;
  }
}
