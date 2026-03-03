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

  async downloadMedia(url: string, cookies: string): Promise<Response> {
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SlopScroll/1.0",
      Accept: "*/*",
      Referer: "https://civitai.com/videos",
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
}
