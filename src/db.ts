import { DatabaseSync } from "node:sqlite";
import { ensureParentDir } from "./utils/fs";
import type { CacheEntry, FeedMode, FeedPeriod, FeedSort, OfflineFeedOrder, Settings, VideoRecord } from "./types";

export interface CacheStats {
  totalVideos: number;
  readyVideos: number;
  failedVideos: number;
  downloadingVideos: number;
  totalBytes: number;
  cacheHits: number;
  cacheMisses: number;
  hitRate: number;
  downloadFailures: number;
}

const METRIC_KEYS = ["cache_hits", "cache_misses", "download_failures", "auth_failures"] as const;
type MetricKey = (typeof METRIC_KEYS)[number];
const FEED_SORT_VALUES: FeedSort[] = ["Most Reactions", "Most Comments", "Most Collected", "Newest", "Oldest"];
const FEED_PERIOD_VALUES: FeedPeriod[] = ["Day", "Week", "Month", "Year", "AllTime"];
const FEED_MODE_VALUES: FeedMode[] = ["online", "offline_video", "offline_image"];
const OFFLINE_FEED_ORDER_VALUES: OfflineFeedOrder[] = ["Newest", "Oldest", "Random"];

function normalizeFeedSort(value: string | undefined, fallback: FeedSort): FeedSort {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  const match = FEED_SORT_VALUES.find((candidate) => candidate.toLowerCase() === normalized);
  return match ?? fallback;
}

function normalizeFeedPeriod(value: string | undefined, fallback: FeedPeriod): FeedPeriod {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  const match = FEED_PERIOD_VALUES.find((candidate) => candidate.toLowerCase() === normalized);
  return match ?? fallback;
}

function normalizeOfflineFeedOrder(value: string | undefined, fallback: OfflineFeedOrder): OfflineFeedOrder {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  const match = OFFLINE_FEED_ORDER_VALUES.find((candidate) => candidate.toLowerCase() === normalized);
  return match ?? fallback;
}

function normalizeFeedMode(value: string | undefined, fallback: FeedMode): FeedMode {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  const match = FEED_MODE_VALUES.find((candidate) => candidate.toLowerCase() === normalized);
  return match ?? fallback;
}

export class AppDb {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    ensureParentDir(dbPath);
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS videos (
        id TEXT PRIMARY KEY,
        media_url TEXT NOT NULL,
        page_url TEXT NOT NULL,
        author TEXT,
        liked INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS cache_entries (
        video_id TEXT PRIMARY KEY,
        local_path TEXT NOT NULL,
        status TEXT NOT NULL,
        file_size INTEGER NOT NULL DEFAULT 0,
        failure_reason TEXT,
        FOREIGN KEY(video_id) REFERENCES videos(id)
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metrics (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS liked_users (
        username TEXT PRIMARY KEY
      );
    `);

    this.ensureVideosSchema();
    this.ensureCacheEntriesSchema();
    this.ensureSettingsSchema();
    this.ensureMetricsSchema();
    this.ensureLikedUsersSchema();

    const seedMetric = this.db.prepare(`
      INSERT INTO metrics (key, value)
      VALUES (?, 0)
      ON CONFLICT(key) DO NOTHING
    `);

    for (const key of METRIC_KEYS) {
      seedMetric.run(key);
    }
  }

  private ensureCacheEntriesSchema(): void {
    const rows = this.db
      .prepare(`PRAGMA table_info(cache_entries)`)
      .all() as Array<{ name: string }>;

    const expected = ["video_id", "local_path", "status", "file_size", "failure_reason"];
    const names = rows.map((row) => row.name);
    const hasExactShape = names.length === expected.length && expected.every((name) => names.includes(name));
    if (hasExactShape) {
      return;
    }

    const hasFailureReason = names.includes("failure_reason");
    const hasFileSize = names.includes("file_size");
    this.db.exec("BEGIN;");
    try {
      this.db.exec(`DROP TABLE IF EXISTS cache_entries_new`);
      this.db.exec(`
        CREATE TABLE cache_entries_new (
          video_id TEXT PRIMARY KEY,
          local_path TEXT NOT NULL,
          status TEXT NOT NULL,
          file_size INTEGER NOT NULL DEFAULT 0,
          failure_reason TEXT,
          FOREIGN KEY(video_id) REFERENCES videos(id)
        );
      `);

      const failureReasonSelect = hasFailureReason ? "failure_reason" : "NULL AS failure_reason";
      const fileSizeSelect = hasFileSize ? "COALESCE(file_size, 0)" : "0";
      this.db.exec(`
        INSERT INTO cache_entries_new (video_id, local_path, status, file_size, failure_reason)
        SELECT video_id, local_path, status, ${fileSizeSelect}, ${failureReasonSelect}
        FROM cache_entries
      `);

      this.db.exec(`DROP TABLE cache_entries`);
      this.db.exec(`ALTER TABLE cache_entries_new RENAME TO cache_entries`);
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  private ensureVideosSchema(): void {
    const rows = this.db
      .prepare(`PRAGMA table_info(videos)`)
      .all() as Array<{ name: string }>;

    const expected = ["id", "media_url", "page_url", "author", "liked"];
    const names = rows.map((row) => row.name);
    const hasExactShape = names.length === expected.length && expected.every((name) => names.includes(name));
    if (hasExactShape) {
      return;
    }

    if (!names.includes("id")) {
      throw new Error("videos table is missing required id column");
    }

    const mediaExpr = names.includes("media_url")
      ? "media_url"
      : names.includes("source_url")
        ? "source_url"
        : "''";
    const pageExpr = names.includes("page_url")
      ? "page_url"
      : names.includes("source_url")
        ? "source_url"
        : "''";
    const authorExpr = names.includes("author") ? "author" : "NULL AS author";
    const likedExpr = names.includes("liked") ? "CASE WHEN liked = 1 THEN 1 ELSE 0 END" : "0 AS liked";

    this.db.exec("BEGIN;");
    try {
      this.db.exec(`DROP TABLE IF EXISTS videos_new`);
      this.db.exec(`
        CREATE TABLE videos_new (
          id TEXT PRIMARY KEY,
          media_url TEXT NOT NULL,
          page_url TEXT NOT NULL,
          author TEXT,
          liked INTEGER NOT NULL DEFAULT 0
        );
      `);

      this.db.exec(`
        INSERT INTO videos_new (id, media_url, page_url, author, liked)
        SELECT id, ${mediaExpr}, ${pageExpr}, ${authorExpr}, ${likedExpr}
        FROM videos
      `);

      this.db.exec(`DROP TABLE videos`);
      this.db.exec(`ALTER TABLE videos_new RENAME TO videos`);
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  private ensureLikedUsersSchema(): void {
    const rows = this.db
      .prepare(`PRAGMA table_info(liked_users)`)
      .all() as Array<{ name: string }>;
    if (rows.length === 0) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS liked_users (
          username TEXT PRIMARY KEY
        )
      `);
      return;
    }

    const expected = ["username"];
    const names = rows.map((row) => row.name);
    const hasExactShape = names.length === expected.length && expected.every((name) => names.includes(name));
    if (hasExactShape) {
      return;
    }

    if (!names.includes("username")) {
      throw new Error("liked_users table is missing required username column");
    }

    this.db.exec("BEGIN;");
    try {
      this.db.exec(`DROP TABLE IF EXISTS liked_users_new`);
      this.db.exec(`
        CREATE TABLE liked_users_new (
          username TEXT PRIMARY KEY
        );
      `);
      this.db.exec(`
        INSERT INTO liked_users_new (username)
        SELECT username
        FROM liked_users
        WHERE username IS NOT NULL AND TRIM(username) <> ''
      `);
      this.db.exec(`DROP TABLE liked_users`);
      this.db.exec(`ALTER TABLE liked_users_new RENAME TO liked_users`);
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  private ensureSettingsSchema(): void {
    const rows = this.db
      .prepare(`PRAGMA table_info(settings)`)
      .all() as Array<{ name: string }>;

    const expected = ["key", "value"];
    const names = rows.map((row) => row.name);
    const hasExactShape = names.length === expected.length && expected.every((name) => names.includes(name));
    if (hasExactShape) {
      return;
    }

    if (!names.includes("key")) {
      throw new Error("settings table is missing required key column");
    }

    const valueExpr = names.includes("value") ? "value" : "'' AS value";
    this.db.exec("BEGIN;");
    try {
      this.db.exec(`DROP TABLE IF EXISTS settings_new`);
      this.db.exec(`
        CREATE TABLE settings_new (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);

      this.db.exec(`
        INSERT INTO settings_new (key, value)
        SELECT key, ${valueExpr}
        FROM settings
      `);

      this.db.exec(`DROP TABLE settings`);
      this.db.exec(`ALTER TABLE settings_new RENAME TO settings`);
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  private ensureMetricsSchema(): void {
    const rows = this.db
      .prepare(`PRAGMA table_info(metrics)`)
      .all() as Array<{ name: string }>;

    const expected = ["key", "value"];
    const names = rows.map((row) => row.name);
    const hasExactShape = names.length === expected.length && expected.every((name) => names.includes(name));
    if (hasExactShape) {
      return;
    }

    if (!names.includes("key")) {
      throw new Error("metrics table is missing required key column");
    }

    const valueExpr = names.includes("value") ? "COALESCE(value, 0)" : "0 AS value";
    this.db.exec("BEGIN;");
    try {
      this.db.exec(`DROP TABLE IF EXISTS metrics_new`);
      this.db.exec(`
        CREATE TABLE metrics_new (
          key TEXT PRIMARY KEY,
          value INTEGER NOT NULL DEFAULT 0
        );
      `);

      this.db.exec(`
        INSERT INTO metrics_new (key, value)
        SELECT key, ${valueExpr}
        FROM metrics
      `);

      this.db.exec(`DROP TABLE metrics`);
      this.db.exec(`ALTER TABLE metrics_new RENAME TO metrics`);
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  private normalizeAuthor(author?: string | null): string | null {
    const value = (author ?? "").trim().toLowerCase();
    return value || null;
  }

  close(): void {
    this.db.close();
  }

  upsertVideo(video: VideoRecord): void {
    this.db
      .prepare(`
        INSERT INTO videos (id, media_url, page_url, author)
        VALUES (@id, @mediaUrl, @pageUrl, @author)
        ON CONFLICT(id) DO UPDATE SET
          media_url = excluded.media_url,
          page_url = excluded.page_url,
          author = excluded.author
        WHERE videos.media_url IS NOT excluded.media_url
          OR videos.page_url IS NOT excluded.page_url
          OR videos.author IS NOT excluded.author
      `)
      .run({
        id: video.id,
        mediaUrl: video.mediaUrl,
        pageUrl: video.pageUrl,
        author: video.author ?? null
      });
  }

  getVideo(videoId: string): VideoRecord | null {
    const row = this.db
      .prepare(`
        SELECT id, media_url, page_url, author, liked
        FROM videos
        WHERE id = ?
      `)
      .get(videoId) as
      | {
          id: string;
          media_url: string;
          page_url: string;
          author: string | null;
          liked: number;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      mediaUrl: row.media_url,
      pageUrl: row.page_url,
      author: row.author ?? undefined,
      liked: row.liked === 1
    };
  }

  listOfflineFeedRows(options: {
    offset: number;
    limit: number;
    author?: string | null;
    order: "Newest" | "Oldest";
  }): Array<{ video: VideoRecord; localPath: string; cacheRowId: number }> {
    const offset = Math.max(0, Math.trunc(options.offset));
    const limit = Math.max(1, Math.trunc(options.limit));
    const normalizedAuthor = this.normalizeAuthor(options.author);
    const orderBy = options.order === "Oldest" ? "cache_entries.rowid ASC" : "cache_entries.rowid DESC";
    const authorClause = normalizedAuthor ? "AND LOWER(TRIM(COALESCE(videos.author, ''))) = ?" : "";
    const params: Array<string | number> = [];
    if (normalizedAuthor) {
      params.push(normalizedAuthor);
    }
    params.push(limit, offset);

    const rows = this.db
      .prepare(
        `
        SELECT
          videos.id AS id,
          videos.media_url AS media_url,
          videos.page_url AS page_url,
          videos.author AS author,
          videos.liked AS liked,
          cache_entries.local_path AS local_path,
          cache_entries.rowid AS cache_rowid
        FROM cache_entries
        INNER JOIN videos ON videos.id = cache_entries.video_id
        WHERE cache_entries.status = 'ready'
          ${authorClause}
        ORDER BY ${orderBy}
        LIMIT ?
        OFFSET ?
      `
      )
      .all(...params) as Array<{
      id: string;
      media_url: string;
      page_url: string;
      author: string | null;
      liked: number;
      local_path: string;
      cache_rowid: number;
    }>;

    return rows.map((row) => ({
      video: {
        id: row.id,
        mediaUrl: row.media_url,
        pageUrl: row.page_url,
        author: row.author ?? undefined,
        liked: row.liked === 1
      },
      localPath: row.local_path,
      cacheRowId: row.cache_rowid
    }));
  }

  listOfflineReadyEntries(author?: string | null): Array<{ videoId: string; localPath: string }> {
    const normalizedAuthor = this.normalizeAuthor(author);
    const authorClause = normalizedAuthor ? "AND LOWER(TRIM(COALESCE(videos.author, ''))) = ?" : "";
    const params: Array<string> = [];
    if (normalizedAuthor) {
      params.push(normalizedAuthor);
    }

    const rows = this.db
      .prepare(
        `
        SELECT
          cache_entries.video_id AS video_id,
          cache_entries.local_path AS local_path
        FROM cache_entries
        INNER JOIN videos ON videos.id = cache_entries.video_id
        WHERE cache_entries.status = 'ready'
          ${authorClause}
        ORDER BY cache_entries.rowid DESC
      `
      )
      .all(...params) as Array<{ video_id: string; local_path: string }>;

    return rows.map((row) => ({
      videoId: row.video_id,
      localPath: row.local_path
    }));
  }

  getOfflineVideosByIds(videoIds: string[]): VideoRecord[] {
    const ids = videoIds.map((value) => value.trim()).filter((value) => value.length > 0);
    if (ids.length === 0) {
      return [];
    }

    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `
        SELECT id, media_url, page_url, author, liked
        FROM videos
        WHERE id IN (${placeholders})
      `
      )
      .all(...ids) as Array<{
      id: string;
      media_url: string;
      page_url: string;
      author: string | null;
      liked: number;
    }>;

    const byId = new Map<string, VideoRecord>();
    for (const row of rows) {
      byId.set(row.id, {
        id: row.id,
        mediaUrl: row.media_url,
        pageUrl: row.page_url,
        author: row.author ?? undefined,
        liked: row.liked === 1
      });
    }

    const ordered: VideoRecord[] = [];
    for (const id of ids) {
      const video = byId.get(id);
      if (video) {
        ordered.push(video);
      }
    }
    return ordered;
  }

  countOfflineFeedRows(author?: string | null): number {
    const normalizedAuthor = this.normalizeAuthor(author);
    const authorClause = normalizedAuthor ? "AND LOWER(TRIM(COALESCE(videos.author, ''))) = ?" : "";
    const row = this.db
      .prepare(
        `
        SELECT COUNT(*) AS total
        FROM cache_entries
        INNER JOIN videos ON videos.id = cache_entries.video_id
        WHERE cache_entries.status = 'ready'
          ${authorClause}
      `
      )
      .get(...(normalizedAuthor ? [normalizedAuthor] : [])) as { total: number } | undefined;
    return row?.total ?? 0;
  }

  countOfflineAuthorVideos(author: string): number {
    return this.countOfflineFeedRows(author);
  }

  getLikedVideoIds(videoIds: string[]): Set<string> {
    const ids = videoIds.filter((value) => value.trim().length > 0);
    if (ids.length === 0) {
      return new Set<string>();
    }

    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id FROM videos WHERE liked = 1 AND id IN (${placeholders})`
      )
      .all(...ids) as Array<{ id: string }>;

    return new Set(rows.map((row) => row.id));
  }

  setVideoLiked(videoId: string, liked: boolean): boolean {
    const result = this.db
      .prepare(
        `UPDATE videos
         SET liked = ?
         WHERE id = ?
           AND liked <> ?`
      )
      .run(liked ? 1 : 0, videoId, liked ? 1 : 0);
    return result.changes > 0;
  }

  listLikedUsers(): string[] {
    const rows = this.db
      .prepare(`SELECT username FROM liked_users ORDER BY username ASC`)
      .all() as Array<{ username: string }>;
    return rows.map((row) => row.username);
  }

  isUserLiked(username: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS ok FROM liked_users WHERE username = ?`)
      .get(username) as { ok: number } | undefined;
    return Boolean(row?.ok);
  }

  setUserLiked(usernameRaw: string, liked: boolean): void {
    const username = usernameRaw.trim().toLowerCase();
    if (!username) {
      return;
    }

    if (liked) {
      this.db
        .prepare(
          `INSERT INTO liked_users (username)
           VALUES (?)
           ON CONFLICT(username) DO NOTHING`
        )
        .run(username);
      return;
    }

    this.db.prepare(`DELETE FROM liked_users WHERE username = ?`).run(username);
  }

  upsertCacheEntry(entry: {
    videoId: string;
    localPath: string;
    status: "ready" | "downloading" | "failed";
    fileSize?: number;
    failureReason?: string;
  }): void {
    this.db
      .prepare(`
        INSERT INTO cache_entries (video_id, local_path, status, file_size, failure_reason)
        VALUES (@videoId, @localPath, @status, @fileSize, @failureReason)
        ON CONFLICT(video_id) DO UPDATE SET
          local_path = excluded.local_path,
          status = excluded.status,
          file_size = excluded.file_size,
          failure_reason = excluded.failure_reason
        WHERE cache_entries.local_path IS NOT excluded.local_path
          OR cache_entries.status IS NOT excluded.status
          OR cache_entries.file_size IS NOT excluded.file_size
          OR cache_entries.failure_reason IS NOT excluded.failure_reason
      `)
      .run({
        videoId: entry.videoId,
        localPath: entry.localPath,
        status: entry.status,
        fileSize: entry.fileSize ?? 0,
        failureReason: entry.failureReason ?? null
      });
  }

  getCacheEntry(videoId: string): CacheEntry | null {
    const row = this.db
      .prepare(`
        SELECT video_id, local_path, status, file_size, failure_reason
        FROM cache_entries
        WHERE video_id = ?
      `)
      .get(videoId) as
      | {
          video_id: string;
          local_path: string;
          status: "ready" | "downloading" | "failed";
          file_size: number;
          failure_reason: string | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      videoId: row.video_id,
      localPath: row.local_path,
      status: row.status,
      fileSize: row.file_size,
      failureReason: row.failure_reason ?? undefined
    };
  }

  incrementMetric(key: MetricKey, by = 1): void {
    this.db
      .prepare(`
        UPDATE metrics
        SET value = value + ?
        WHERE key = ?
      `)
      .run(by, key);
  }

  getMetric(key: MetricKey): number {
    const row = this.db
      .prepare(`SELECT value FROM metrics WHERE key = ?`)
      .get(key) as { value: number } | undefined;
    return row?.value ?? 0;
  }

  getSettings(defaults: Settings): Settings {
    const rows = this.db
      .prepare(
        `SELECT key, value FROM settings WHERE key IN ('prefetchDepth', 'lowDiskWarnGb', 'audioEnabled', 'audioAutoSwitchEnabled', 'audioSwitchOnVideoChangeEnabled', 'audioMinSwitchSec', 'audioMaxSwitchSec', 'audioCrossfadeSec', 'audioPlaybackRate', 'panicShortcutEnabled', 'browsingLevelR', 'browsingLevelX', 'browsingLevelXXX', 'feedSort', 'feedPeriod', 'feedMode', 'offlineModeEnabled', 'offlineFeedOrder')`
      )
      .all() as Array<{ key: string; value: string }>;

    const output: Settings = { ...defaults };
    let hasPersistedFeedMode = false;
    for (const row of rows) {
      if (row.key === "prefetchDepth") {
        const parsed = Number.parseInt(row.value, 10);
        if (Number.isFinite(parsed)) {
          output.prefetchDepth = parsed;
        }
      }
      if (row.key === "lowDiskWarnGb") {
        const parsed = Number.parseFloat(row.value);
        if (Number.isFinite(parsed)) {
          output.lowDiskWarnGb = parsed;
        }
      }
      if (row.key === "audioEnabled") {
        output.audioEnabled = row.value.toLowerCase() === "true";
      }
      if (row.key === "audioAutoSwitchEnabled") {
        output.audioAutoSwitchEnabled = row.value.toLowerCase() === "true";
      }
      if (row.key === "audioSwitchOnVideoChangeEnabled") {
        output.audioSwitchOnVideoChangeEnabled = row.value.toLowerCase() === "true";
      }
      if (row.key === "audioMinSwitchSec") {
        const parsed = Number.parseInt(row.value, 10);
        if (Number.isFinite(parsed)) {
          output.audioMinSwitchSec = parsed;
        }
      }
      if (row.key === "audioMaxSwitchSec") {
        const parsed = Number.parseInt(row.value, 10);
        if (Number.isFinite(parsed)) {
          output.audioMaxSwitchSec = parsed;
        }
      }
      if (row.key === "audioCrossfadeSec") {
        const parsed = Number.parseFloat(row.value);
        if (Number.isFinite(parsed)) {
          output.audioCrossfadeSec = parsed;
        }
      }
      if (row.key === "audioPlaybackRate") {
        const parsed = Number.parseFloat(row.value);
        if (Number.isFinite(parsed)) {
          output.audioPlaybackRate = Math.max(0.5, Math.min(2, parsed));
        }
      }
      if (row.key === "panicShortcutEnabled") {
        output.panicShortcutEnabled = row.value.toLowerCase() === "true";
      }
      if (row.key === "browsingLevelR") {
        output.browsingLevelR = row.value.toLowerCase() === "true";
      }
      if (row.key === "browsingLevelX") {
        output.browsingLevelX = row.value.toLowerCase() === "true";
      }
      if (row.key === "browsingLevelXXX") {
        output.browsingLevelXXX = row.value.toLowerCase() === "true";
      }
      if (row.key === "feedSort") {
        output.feedSort = normalizeFeedSort(row.value, defaults.feedSort);
      }
      if (row.key === "feedPeriod") {
        output.feedPeriod = normalizeFeedPeriod(row.value, defaults.feedPeriod);
      }
      if (row.key === "feedMode") {
        output.feedMode = normalizeFeedMode(row.value, defaults.feedMode);
        hasPersistedFeedMode = true;
      }
      if (row.key === "offlineModeEnabled") {
        if (!hasPersistedFeedMode && row.value.toLowerCase() === "true") {
          output.feedMode = "offline_video";
        }
      }
      if (row.key === "offlineFeedOrder") {
        output.offlineFeedOrder = normalizeOfflineFeedOrder(row.value, defaults.offlineFeedOrder);
      }
    }
    return output;
  }

  setSettings(settings: Settings): void {
    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value
    `);
    const currentRows = this.db.prepare(`SELECT key, value FROM settings`).all() as Array<{ key: string; value: string }>;
    const current = new Map(currentRows.map((row) => [row.key, row.value]));
    const nextValues = new Map<string, string>([
      ["prefetchDepth", String(settings.prefetchDepth)],
      ["lowDiskWarnGb", String(settings.lowDiskWarnGb)],
      ["audioEnabled", String(settings.audioEnabled)],
      ["audioAutoSwitchEnabled", String(settings.audioAutoSwitchEnabled)],
      ["audioSwitchOnVideoChangeEnabled", String(settings.audioSwitchOnVideoChangeEnabled)],
      ["audioMinSwitchSec", String(settings.audioMinSwitchSec)],
      ["audioMaxSwitchSec", String(settings.audioMaxSwitchSec)],
      ["audioCrossfadeSec", String(settings.audioCrossfadeSec)],
      ["audioPlaybackRate", String(settings.audioPlaybackRate)],
      ["panicShortcutEnabled", String(settings.panicShortcutEnabled)],
      ["browsingLevelR", String(settings.browsingLevelR)],
      ["browsingLevelX", String(settings.browsingLevelX)],
      ["browsingLevelXXX", String(settings.browsingLevelXXX)],
      ["feedSort", settings.feedSort],
      ["feedPeriod", settings.feedPeriod],
      ["feedMode", settings.feedMode],
      ["offlineFeedOrder", settings.offlineFeedOrder]
    ]);

    this.db.exec("BEGIN;");
    try {
      for (const [key, value] of nextValues.entries()) {
        if (current.get(key) === value) {
          continue;
        }
        stmt.run(key, value);
      }
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  getCacheStats(): CacheStats {
    const summary = this.db
      .prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status = 'downloading' THEN 1 ELSE 0 END) AS downloading,
          SUM(CASE WHEN status = 'ready' THEN file_size ELSE 0 END) AS bytes
        FROM cache_entries
      `)
      .get() as {
      total: number;
      ready: number;
      failed: number;
      downloading: number;
      bytes: number;
    };

    const hits = this.getMetric("cache_hits");
    const misses = this.getMetric("cache_misses");
    const totalRequests = hits + misses;

    return {
      totalVideos: summary.total ?? 0,
      readyVideos: summary.ready ?? 0,
      failedVideos: summary.failed ?? 0,
      downloadingVideos: summary.downloading ?? 0,
      totalBytes: summary.bytes ?? 0,
      cacheHits: hits,
      cacheMisses: misses,
      hitRate: totalRequests > 0 ? hits / totalRequests : 0,
      downloadFailures: this.getMetric("download_failures")
    };
  }

  resetCacheIndex(): void {
    this.db.exec("BEGIN;");
    try {
      this.db.prepare(`DELETE FROM cache_entries`).run();
      this.db.prepare(`DELETE FROM videos`).run();
      this.db.prepare(`UPDATE metrics SET value = 0`).run();
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }
}
