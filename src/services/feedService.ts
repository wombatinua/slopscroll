import fs from "node:fs";
import type { AppConfig } from "../config";
import { AppDb } from "../db";
import { logger } from "../logger";
import { SessionStore } from "../sessionStore";
import type { FeedPage, OfflineFeedOrder, VideoRecord } from "../types";
import { normalizeFeedResponse } from "./feedNormalizer";
import { CivitaiClient } from "../civitai/client";

export class FeedService {
  private readonly servedIdsByMode = new Map<string, Set<string>>();
  private readonly offlineRandomOrderByMode = new Map<string, string[]>();
  private readonly authorTotalsCache = new Map<string, { totalVideos: number; checkedAt: number }>();
  private readonly authorTotalsInFlight = new Map<string, Promise<{ totalVideos: number; complete: boolean; scannedPages: number }>>();
  private static readonly AUTHOR_TOTALS_TTL_MS = 5 * 60 * 1000;
  private static readonly AUTHOR_TOTALS_PAGE_SIZE = 50;
  private static readonly AUTHOR_TOTALS_MAX_PAGES = 200;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDb,
    private readonly sessionStore: SessionStore,
    private readonly civitaiClient: CivitaiClient
  ) {}

  async getNextFeed(cursor: string | null, limit: number, authorFilter?: string | null): Promise<FeedPage> {
    if (this.config.settings.offlineModeEnabled) {
      return this.getNextOfflineFeed(cursor, limit, authorFilter);
    }

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
      this.attachLikedFlags(deduped);

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

  resetInMemoryState(): void {
    this.servedIdsByMode.clear();
    this.offlineRandomOrderByMode.clear();
    this.authorTotalsCache.clear();
    this.authorTotalsInFlight.clear();
  }

  async getAuthorVideoTotal(
    author: string,
    options?: { forceRefresh?: boolean; allowSlowFallback?: boolean }
  ): Promise<{ author: string; totalVideos: number; complete: boolean; scannedPages: number; cached: boolean }> {
    const normalizedAuthor = this.normalizeAuthor(author);
    if (!normalizedAuthor) {
      throw new Error("author is required");
    }

    if (this.config.settings.offlineModeEnabled) {
      const totalVideos = this.db
        .listOfflineReadyEntries(normalizedAuthor)
        .filter((entry) => this.hasReadyLocalFile(entry.localPath)).length;
      return {
        author: normalizedAuthor,
        totalVideos,
        complete: true,
        scannedPages: 0,
        cached: true
      };
    }

    const totalsKey = this.getAuthorTotalsKey(normalizedAuthor);

    const now = Date.now();
    const cached = this.authorTotalsCache.get(totalsKey);
    if (!options?.forceRefresh && cached && now - cached.checkedAt < FeedService.AUTHOR_TOTALS_TTL_MS) {
      return {
        author: normalizedAuthor,
        totalVideos: cached.totalVideos,
        complete: true,
        scannedPages: 0,
        cached: true
      };
    }

    const existing = this.authorTotalsInFlight.get(totalsKey);
    if (existing) {
      const result = await existing;
      return {
        author: normalizedAuthor,
        ...result,
        cached: false
      };
    }

    const task = this.computeAuthorVideoTotal(normalizedAuthor);
    this.authorTotalsInFlight.set(totalsKey, task);

    try {
      const result = await task;
      if (result.complete) {
        this.authorTotalsCache.set(totalsKey, {
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
      this.authorTotalsInFlight.delete(totalsKey);
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

  private async getNextOfflineFeed(cursor: string | null, limit: number, authorFilter?: string | null): Promise<FeedPage> {
    const safeLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
    const author = (authorFilter ?? "").trim() || null;
    const order = this.normalizeOfflineFeedOrder(this.config.settings.offlineFeedOrder);

    if (order === "Random") {
      return this.getNextOfflineRandomFeed(cursor, safeLimit, author);
    }
    return this.getNextOfflineSortedFeed(cursor, safeLimit, author, order);
  }

  private getNextOfflineSortedFeed(
    cursor: string | null,
    limit: number,
    authorFilter: string | null,
    order: "Newest" | "Oldest"
  ): FeedPage {
    const offset = this.parseOfflineCursorToOffset(cursor);
    const totalRows = this.db.countOfflineFeedRows(authorFilter);
    if (offset >= totalRows) {
      return {
        items: [],
        nextCursor: null,
        page: this.parseOfflinePage(offset, limit)
      };
    }

    const batchSize = Math.max(limit * 3, 24);
    const items: VideoRecord[] = [];
    let scanOffset = offset;

    while (items.length < limit && scanOffset < totalRows) {
      const rows = this.db.listOfflineFeedRows({
        offset: scanOffset,
        limit: batchSize,
        author: authorFilter,
        order
      });
      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        scanOffset += 1;
        if (!this.hasReadyLocalFile(row.localPath)) {
          continue;
        }
        items.push(row.video);
        if (items.length >= limit) {
          break;
        }
      }
    }

    const nextCursor = scanOffset < totalRows ? String(scanOffset) : null;
    return {
      items,
      nextCursor,
      page: this.parseOfflinePage(offset, limit)
    };
  }

  private getNextOfflineRandomFeed(cursor: string | null, limit: number, authorFilter: string | null): FeedPage {
    const modeKey = this.getModeKey(authorFilter);
    if (cursor == null || !this.offlineRandomOrderByMode.has(modeKey)) {
      const orderedIds = this.db
        .listOfflineReadyEntries(authorFilter)
        .filter((entry) => this.hasReadyLocalFile(entry.localPath))
        .map((entry) => entry.videoId);
      this.shuffleInPlace(orderedIds);
      this.offlineRandomOrderByMode.set(modeKey, orderedIds);
    }

    const order = this.offlineRandomOrderByMode.get(modeKey) ?? [];
    const offset = this.parseOfflineCursorToOffset(cursor);
    if (offset >= order.length) {
      return {
        items: [],
        nextCursor: null,
        page: this.parseOfflinePage(offset, limit)
      };
    }

    const slice = order.slice(offset, offset + limit);
    const items = this.db.getOfflineVideosByIds(slice);
    const nextOffset = offset + slice.length;
    const nextCursor = nextOffset < order.length ? String(nextOffset) : null;

    return {
      items,
      nextCursor,
      page: this.parseOfflinePage(offset, limit)
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

  private attachLikedFlags(items: VideoRecord[]): void {
    if (items.length === 0) {
      return;
    }

    const likedIds = this.db.getLikedVideoIds(items.map((item) => item.id));
    for (const item of items) {
      item.liked = likedIds.has(item.id);
    }
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

  private parseOfflineCursorToOffset(cursor: string | null): number {
    if (!cursor) {
      return 0;
    }
    const parsed = Number.parseInt(cursor, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return 0;
    }
    return parsed;
  }

  private parseOfflinePage(offset: number, limit: number): number {
    const safeLimit = Math.max(1, Math.trunc(limit));
    return Math.floor(Math.max(0, offset) / safeLimit) + 1;
  }

  private normalizeOfflineFeedOrder(order: OfflineFeedOrder): OfflineFeedOrder {
    if (order === "Oldest" || order === "Random") {
      return order;
    }
    return "Newest";
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

  private hasReadyLocalFile(localPath: string): boolean {
    if (!localPath) {
      return false;
    }
    try {
      const stat = fs.statSync(localPath);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
  }

  private shuffleInPlace(values: string[]): void {
    for (let idx = values.length - 1; idx > 0; idx -= 1) {
      const swapIdx = Math.floor(Math.random() * (idx + 1));
      const tmp = values[idx];
      values[idx] = values[swapIdx];
      values[swapIdx] = tmp;
    }
  }

  private getAuthorTotalsKey(author: string): string {
    return `${author}|${this.civitaiClient.getAuthorTotalFilterKey()}`;
  }
}
