import { DatabaseSync } from "node:sqlite";
import { ensureParentDir } from "./utils/fs";
import type { CacheEntry, Settings, VideoRecord } from "./types";

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

function nowIso(): string {
  return new Date().toISOString();
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
        source_url TEXT NOT NULL,
        media_url TEXT NOT NULL,
        page_url TEXT NOT NULL,
        duration REAL,
        author TEXT,
        created_at TEXT,
        raw TEXT,
        inserted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metrics (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);

    this.ensureCacheEntriesSchema();

    const seedMetric = this.db.prepare(`
      INSERT INTO metrics (key, value, updated_at)
      VALUES (?, 0, ?)
      ON CONFLICT(key) DO NOTHING
    `);

    const ts = nowIso();
    for (const key of METRIC_KEYS) {
      seedMetric.run(key, ts);
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
    this.db.exec("BEGIN;");
    try {
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
      this.db.exec(`
        INSERT INTO cache_entries_new (video_id, local_path, status, file_size, failure_reason)
        SELECT video_id, local_path, status, COALESCE(file_size, 0), ${failureReasonSelect}
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

  close(): void {
    this.db.close();
  }

  upsertVideo(video: VideoRecord): void {
    const ts = nowIso();
    this.db
      .prepare(`
        INSERT INTO videos (id, source_url, media_url, page_url, duration, author, created_at, raw, inserted_at, updated_at)
        VALUES (@id, @sourceUrl, @mediaUrl, @pageUrl, @duration, @author, @createdAt, @raw, @insertedAt, @updatedAt)
        ON CONFLICT(id) DO UPDATE SET
          source_url = excluded.source_url,
          media_url = excluded.media_url,
          page_url = excluded.page_url,
          duration = excluded.duration,
          author = excluded.author,
          created_at = excluded.created_at,
          raw = excluded.raw,
          updated_at = excluded.updated_at
      `)
      .run({
        id: video.id,
        sourceUrl: video.sourceUrl,
        mediaUrl: video.mediaUrl,
        pageUrl: video.pageUrl,
        duration: video.duration ?? null,
        author: video.author ?? null,
        createdAt: video.createdAt ?? null,
        raw: video.raw ?? null,
        insertedAt: ts,
        updatedAt: ts
      });
  }

  getVideo(videoId: string): VideoRecord | null {
    const row = this.db
      .prepare(`
        SELECT id, source_url, media_url, page_url, duration, author, created_at, raw
        FROM videos
        WHERE id = ?
      `)
      .get(videoId) as
      | {
          id: string;
          source_url: string;
          media_url: string;
          page_url: string;
          duration: number | null;
          author: string | null;
          created_at: string | null;
          raw: string | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      sourceUrl: row.source_url,
      mediaUrl: row.media_url,
      pageUrl: row.page_url,
      duration: row.duration ?? undefined,
      author: row.author ?? undefined,
      createdAt: row.created_at ?? undefined,
      raw: row.raw ?? undefined
    };
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
        SET value = value + ?, updated_at = ?
        WHERE key = ?
      `)
      .run(by, nowIso(), key);
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
        `SELECT key, value FROM settings WHERE key IN ('prefetchDepth', 'lowDiskWarnGb', 'audioEnabled', 'audioMinSwitchSec', 'audioMaxSwitchSec', 'audioCrossfadeSec', 'audioSwitchOnFeedAdvance')`
      )
      .all() as Array<{ key: string; value: string }>;

    const output: Settings = { ...defaults };
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
      if (row.key === "audioSwitchOnFeedAdvance") {
        output.audioSwitchOnFeedAdvance = row.value.toLowerCase() === "true";
      }
    }
    return output;
  }

  setSettings(settings: Settings): void {
    const ts = nowIso();
    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    this.db.exec("BEGIN;");
    try {
      stmt.run("prefetchDepth", String(settings.prefetchDepth), ts);
      stmt.run("lowDiskWarnGb", String(settings.lowDiskWarnGb), ts);
      stmt.run("audioEnabled", String(settings.audioEnabled), ts);
      stmt.run("audioMinSwitchSec", String(settings.audioMinSwitchSec), ts);
      stmt.run("audioMaxSwitchSec", String(settings.audioMaxSwitchSec), ts);
      stmt.run("audioCrossfadeSec", String(settings.audioCrossfadeSec), ts);
      stmt.run("audioSwitchOnFeedAdvance", String(settings.audioSwitchOnFeedAdvance), ts);
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
    const ts = nowIso();
    this.db.exec("BEGIN;");
    try {
      this.db.prepare(`DELETE FROM cache_entries`).run();
      this.db.prepare(`DELETE FROM videos`).run();
      this.db.prepare(`UPDATE metrics SET value = 0, updated_at = ?`).run(ts);
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }
}
