import { AppDb } from "../db";
import { logger } from "../logger";
import { SessionStore } from "../sessionStore";
import type { FeedPage, VideoRecord } from "../types";
import { normalizeFeedResponse } from "./feedNormalizer";
import { CivitaiClient } from "../civitai/client";

export class FeedService {
  private readonly servedIdsByMode = new Map<string, Set<string>>();
  private readonly authorTotalsCache = new Map<string, { totalVideos: number; checkedAt: number }>();
  private readonly authorTotalsInFlight = new Map<string, Promise<{ totalVideos: number; complete: boolean; scannedPages: number }>>();
  private static readonly AUTHOR_TOTALS_TTL_MS = 5 * 60 * 1000;
  private static readonly AUTHOR_TOTALS_PAGE_SIZE = 50;
  private static readonly AUTHOR_TOTALS_MAX_PAGES = 200;

  constructor(
    private readonly db: AppDb,
    private readonly sessionStore: SessionStore,
    private readonly civitaiClient: CivitaiClient
  ) {}

  async getNextFeed(cursor: string | null, limit: number, authorFilter?: string | null): Promise<FeedPage> {
    const cookies = this.sessionStore.getCookies();
    if (!cookies) {
      throw new Error("No auth cookies configured. Use POST /api/auth/cookies first.");
    }

    const spec = this.civitaiClient.getRequestSpec();
    if (!spec) {
      throw new Error("Missing request spec");
    }
    const authorQuery = (authorFilter ?? "").trim() || null;
    const modeKey = this.getModeKey(authorQuery);
    const normalizedAuthorFilter = this.normalizeAuthor(authorQuery);

    let requestCursor = cursor;
    const maxCursorHops = 5;

    for (let hop = 0; hop < maxCursorHops; hop += 1) {
      const raw = normalizedAuthorFilter
        ? await this.civitaiClient.fetchAuthorFeedRaw({
            cookies,
            cursor: requestCursor,
            limit,
            author: authorQuery as string
          })
        : await this.civitaiClient.fetchFeedRaw({
            cookies,
            cursor: requestCursor,
            limit
          });

      if (!raw.ok) {
        if (raw.status === 401 || raw.status === 403) {
          this.db.incrementMetric("auth_failures");
        }
        throw new Error(raw.error ?? "Failed to fetch feed");
      }

      const normalized = normalizeFeedResponse(raw.body, spec);
      const filteredItems = normalizedAuthorFilter
        ? normalized.items.filter((item) => {
            const itemAuthor = this.normalizeAuthor(item.author);
            return !itemAuthor || itemAuthor === normalizedAuthorFilter;
          })
        : normalized.items;
      const deduped = this.dedupe(filteredItems, modeKey);

      for (const item of deduped) {
        this.db.upsertVideo(item);
      }

      logger.info("feed.page.fetched", {
        requestedLimit: limit,
        authorFilter: normalizedAuthorFilter,
        cursor: requestCursor,
        received: normalized.items.length,
        filtered: filteredItems.length,
        deduped: deduped.length,
        nextCursor: normalized.nextCursor,
        hop
      });

      const nextCursor = normalized.nextCursor;
      const cursorAdvanced = Boolean(nextCursor && nextCursor !== requestCursor);
      if (deduped.length > 0 || !cursorAdvanced) {
        return {
          items: deduped,
          nextCursor,
          page: this.parseCursorToPage(nextCursor)
        };
      }

      requestCursor = nextCursor;
    }

    return {
      items: [],
      nextCursor: requestCursor,
      page: this.parseCursorToPage(requestCursor)
    };
  }

  getVideo(videoId: string): VideoRecord | null {
    return this.db.getVideo(videoId);
  }

  async getAuthorVideoTotal(
    author: string,
    options?: { forceRefresh?: boolean }
  ): Promise<{ author: string; totalVideos: number; complete: boolean; scannedPages: number; cached: boolean }> {
    const normalizedAuthor = this.normalizeAuthor(author);
    if (!normalizedAuthor) {
      throw new Error("author is required");
    }

    const now = Date.now();
    const cached = this.authorTotalsCache.get(normalizedAuthor);
    if (!options?.forceRefresh && cached && now - cached.checkedAt < FeedService.AUTHOR_TOTALS_TTL_MS) {
      return {
        author: normalizedAuthor,
        totalVideos: cached.totalVideos,
        complete: true,
        scannedPages: 0,
        cached: true
      };
    }

    const existing = this.authorTotalsInFlight.get(normalizedAuthor);
    if (existing) {
      const result = await existing;
      return {
        author: normalizedAuthor,
        ...result,
        cached: false
      };
    }

    const task = this.computeAuthorVideoTotal(normalizedAuthor);
    this.authorTotalsInFlight.set(normalizedAuthor, task);

    try {
      const result = await task;
      if (result.complete) {
        this.authorTotalsCache.set(normalizedAuthor, {
          totalVideos: result.totalVideos,
          checkedAt: now
        });
      }

      return {
        author: normalizedAuthor,
        ...result,
        cached: false
      };
    } finally {
      this.authorTotalsInFlight.delete(normalizedAuthor);
    }
  }

  private async computeAuthorVideoTotal(author: string): Promise<{ totalVideos: number; complete: boolean; scannedPages: number }> {
    const cookies = this.sessionStore.getCookies();
    if (!cookies) {
      throw new Error("No auth cookies configured. Use POST /api/auth/cookies first.");
    }

    const spec = this.civitaiClient.getRequestSpec();
    if (!spec) {
      throw new Error("Missing request spec");
    }

    const seen = new Set<string>();
    let cursor: string | null = null;
    let scannedPages = 0;

    for (; scannedPages < FeedService.AUTHOR_TOTALS_MAX_PAGES; scannedPages += 1) {
      const raw = await this.civitaiClient.fetchAuthorFeedRaw({
        cookies,
        author,
        cursor,
        limit: FeedService.AUTHOR_TOTALS_PAGE_SIZE
      });

      if (!raw.ok) {
        if (raw.status === 401 || raw.status === 403) {
          this.db.incrementMetric("auth_failures");
        }
        throw new Error(raw.error ?? "Failed to fetch author total");
      }

      const normalized = normalizeFeedResponse(raw.body, spec);
      for (const item of normalized.items) {
        const itemAuthor = this.normalizeAuthor(item.author);
        if (itemAuthor && itemAuthor !== author) {
          continue;
        }
        seen.add(item.id);
      }

      if (!normalized.nextCursor || normalized.items.length === 0) {
        return {
          totalVideos: seen.size,
          complete: true,
          scannedPages: scannedPages + 1
        };
      }

      cursor = normalized.nextCursor;
    }

    return {
      totalVideos: seen.size,
      complete: false,
      scannedPages
    };
  }

  private dedupe(items: VideoRecord[], modeKey: string): VideoRecord[] {
    const deduped: VideoRecord[] = [];
    const local = new Set<string>();
    const servedIds = this.getServedSet(modeKey);

    for (const item of items) {
      if (local.has(item.id)) {
        continue;
      }
      local.add(item.id);

      if (servedIds.has(item.id)) {
        continue;
      }

      servedIds.add(item.id);
      deduped.push(item);
    }

    if (servedIds.size > 10000) {
      const keep = Array.from(servedIds).slice(-5000);
      servedIds.clear();
      for (const id of keep) {
        servedIds.add(id);
      }
    }

    return deduped;
  }

  private parseCursorToPage(cursor: string | null): number {
    if (!cursor) {
      return 1;
    }

    const maybe = Number.parseInt(cursor, 10);
    if (Number.isInteger(maybe) && maybe > 0) {
      return maybe;
    }

    return 1;
  }

  private getModeKey(authorFilter?: string | null): string {
    const author = this.normalizeAuthor(authorFilter);
    if (!author) {
      return "general";
    }
    return `author:${author}`;
  }

  private getServedSet(modeKey: string): Set<string> {
    let set = this.servedIdsByMode.get(modeKey);
    if (!set) {
      set = new Set<string>();
      this.servedIdsByMode.set(modeKey, set);
    }
    return set;
  }

  private normalizeAuthor(author?: string | null): string | null {
    const value = (author ?? "").trim().toLowerCase();
    return value || null;
  }
}
