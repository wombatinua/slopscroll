import type { AppConfig } from "../config";
import { logger } from "../logger";
import { firstStringByPaths, getByPath } from "../utils/objectPath";
import type { AuthState, CivitaiRequestSpec, FetchResult } from "../types";

export interface FeedFetchOptions {
  cookies: string;
  cursor?: string | null;
  limit?: number;
  author?: string | null;
  authorMode?: boolean;
}

const IMAGE_HOSTS = new Set(["image.civitai.com", "image-b2.civitai.com"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VIDEO_EXT_PATTERN = /\.(?:mp4|webm)(?:$|[?#])/i;
const IMAGE_EXT_PATTERN = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:$|[?#])/i;

export class CivitaiClient {
  constructor(private readonly config: AppConfig, private spec: CivitaiRequestSpec | null) {}

  private getConfiguredBrowsingLevel(): number {
    let level = 0;
    if (this.config.settings.browsingLevelR) {
      level |= 4;
    }
    if (this.config.settings.browsingLevelX) {
      level |= 8;
    }
    if (this.config.settings.browsingLevelXXX) {
      level |= 16;
    }
    return level;
  }

  private getConfiguredFeedSort(): string {
    return this.config.settings.feedSort;
  }

  private getConfiguredFeedPeriod(): string {
    return this.config.settings.feedPeriod;
  }

  getAuthorTotalFilterKey(): string {
    return `${this.getConfiguredFeedPeriod()}|${this.getConfiguredBrowsingLevel()}`;
  }

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
      const htmlUrls = this.extractVideoUrlsFromHtml(html);
      const imageGetUrls = await this.fetchVideoSourceCandidatesFromImageApi(target, cookies);
      const urls = this.mergeCandidates(htmlUrls, imageGetUrls);
      logger.info("civitai.page_sources.extracted", {
        pageUrl: target,
        found: urls.length,
        fromHtml: htmlUrls.length,
        fromImageApi: imageGetUrls.length
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
    jsonObj.browsingLevel = this.getConfiguredBrowsingLevel();
    jsonObj.sort = this.getConfiguredFeedSort();
    jsonObj.period = this.getConfiguredFeedPeriod();

    if (options.authorMode && options.author) {
      jsonObj.username = options.author;
      jsonObj.types = ["video"];
      // Author video feed is unstable/empty with useIndex=true on Civitai.
      jsonObj.useIndex = false;
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
    baseQuery.browsingLevel = String(this.getConfiguredBrowsingLevel());
    baseQuery.sort = this.getConfiguredFeedSort();
    baseQuery.period = this.getConfiguredFeedPeriod();

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

  private async fetchVideoSourceCandidatesFromImageApi(pageUrl: string, cookies: string): Promise<string[]> {
    const imageId = this.extractImageIdFromPageUrl(pageUrl);
    if (imageId == null) {
      return [];
    }

    const input = JSON.stringify({ 0: { json: { id: imageId } } });
    const url = `https://civitai.com/api/trpc/image.get?batch=1&input=${encodeURIComponent(input)}`;
    const headers: Record<string, string> = {
      Accept: "*/*",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SlopScroll/1.0",
      Referer: pageUrl,
      Cookie: cookies
    };

    try {
      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(Math.max(1500, Math.min(this.config.civitai.requestTimeoutMs, 7000)))
      });

      if (!response.ok) {
        logger.warn("civitai.image_get.non_ok", {
          pageUrl,
          imageId,
          status: response.status
        });
        return [];
      }

      const body = (await response.json()) as unknown;
      const imageRecord = getByPath(body, "0.result.data.json");
      if (!imageRecord || typeof imageRecord !== "object") {
        return [];
      }

      const record = imageRecord as Record<string, unknown>;
      const out: string[] = [];
      const seen = new Set<string>();
      const push = (value: string): void => {
        const normalized = this.normalizeExtractedCandidate(value);
        if (!normalized || seen.has(normalized) || !this.isLikelyMediaCandidate(normalized)) {
          return;
        }
        seen.add(normalized);
        out.push(normalized);
      };

      const rawCandidate = firstStringByPaths(record, ["videoUrl", "mediaUrl", "meta.videoUrl", "meta.url", "url"]);
      if (rawCandidate) {
        push(rawCandidate);
      }

      const key = this.extractMediaAssetKey(rawCandidate ?? "");
      if (key) {
        push(`https://image-b2.civitai.com/file/civitai-media-cache/${key}/original`);
        push(`https://image.civitai.com/file/civitai-media-cache/${key}/original`);
      }

      return out.sort((a, b) => this.scoreMediaCandidate(b) - this.scoreMediaCandidate(a));
    } catch (error) {
      logger.warn("civitai.image_get.failed", {
        pageUrl,
        imageId,
        error: error instanceof Error ? error.message : String(error)
      });
      return [];
    }
  }

  private extractVideoUrlsFromHtml(html: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (value: string): void => {
      const normalized = this.normalizeExtractedCandidate(value);

      if (!normalized || seen.has(normalized) || !this.isLikelyMediaCandidate(normalized)) {
        return;
      }
      seen.add(normalized);
      out.push(normalized);
    };

    const patterns = [
      /(?:src|href)\s*=\s*["']([^"']+)["']/gi,
      /https:\/\/image(?:-b2)?\.civitai\.com\/[^"'<>\\\s)]+/gi,
      /https:\\\/\\\/image(?:-b2)?\\.civitai\\.com[^"'<>\\\s)]+/gi
    ];

    for (const pattern of patterns) {
      let match: RegExpExecArray | null = null;
      while ((match = pattern.exec(html)) !== null) {
        push(match[1] ?? match[0]);
      }
    }

    return out.sort((a, b) => this.scoreMediaCandidate(b) - this.scoreMediaCandidate(a));
  }

  private mergeCandidates(...groups: string[][]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const group of groups) {
      for (const candidate of group) {
        if (!candidate || seen.has(candidate)) {
          continue;
        }
        seen.add(candidate);
        out.push(candidate);
      }
    }
    return out;
  }

  private normalizeExtractedCandidate(value: string): string | null {
    let normalized = value.trim();
    if (!normalized) {
      return null;
    }

    normalized = normalized
      .replaceAll("\\u0026", "&")
      .replaceAll("&amp;", "&")
      .replaceAll("\\/", "/")
      .replace(/^['"]+/, "")
      .replace(/['"]+$/, "")
      .replace(/[),;]+$/, "");

    if (normalized.startsWith("//")) {
      normalized = `https:${normalized}`;
    }

    return normalized || null;
  }

  private isLikelyMediaCandidate(value: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return false;
    }

    if (!IMAGE_HOSTS.has(parsed.host)) {
      return false;
    }

    const normalized = value.toLowerCase();
    if (IMAGE_EXT_PATTERN.test(normalized)) {
      return false;
    }
    if (VIDEO_EXT_PATTERN.test(normalized)) {
      return true;
    }
    if (normalized.includes("transcode=")) {
      return true;
    }
    if (normalized.includes("/file/civitai-media-cache/")) {
      return true;
    }
    if (/\/original(?:=true)?(?:$|[/?#])/i.test(normalized)) {
      return true;
    }
    return false;
  }

  private scoreMediaCandidate(value: string): number {
    const normalized = value.toLowerCase();
    let score = 0;
    if (VIDEO_EXT_PATTERN.test(normalized)) {
      score += 80;
    }
    if (normalized.includes("transcode=")) {
      score += 40;
    }
    if (normalized.includes("/file/civitai-media-cache/")) {
      score += 20;
    }
    if (/\/original(?:=true)?(?:$|[/?#])/i.test(normalized)) {
      score += 10;
    }
    if (normalized.includes("quality=90")) {
      score += 5;
    }
    return score;
  }

  private extractImageIdFromPageUrl(pageUrl: string): number | null {
    const target = pageUrl.trim();
    if (!target) {
      return null;
    }

    const match = target.match(/\/images\/(\d+)/i);
    if (!match) {
      return null;
    }

    const parsed = Number.parseInt(match[1], 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }

    return parsed;
  }

  private extractMediaAssetKey(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    if (UUID_PATTERN.test(trimmed)) {
      return trimmed;
    }

    try {
      const parsed = new URL(trimmed);
      const segments = parsed.pathname.split("/").filter(Boolean);
      const last = segments.at(-1) ?? "";
      if (UUID_PATTERN.test(last)) {
        return last;
      }

      const cacheIdx = segments.findIndex((segment) => segment === "civitai-media-cache");
      if (cacheIdx >= 0 && segments[cacheIdx + 1] && UUID_PATTERN.test(segments[cacheIdx + 1])) {
        return segments[cacheIdx + 1];
      }
    } catch {
      // no-op
    }

    return null;
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
