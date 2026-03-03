import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { FastifyReply } from "fastify";
import { AppDb } from "../db";
import type { AppConfig } from "../config";
import { SessionStore } from "../sessionStore";
import { logger } from "../logger";
import type { CacheEntry, VideoRecord } from "../types";
import { ensureDir, getDiskFreeBytes } from "../utils/fs";
import { CivitaiClient } from "../civitai/client";
import { sha1 } from "../utils/hash";

function normalizeFileName(videoId: string): string {
  const compact = videoId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  if (compact.length > 0) {
    return compact;
  }
  return sha1(videoId);
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

export class CacheService {
  private readonly inFlight = new Map<string, Promise<CacheEntry>>();

  constructor(
    private readonly db: AppDb,
    private readonly config: AppConfig,
    private readonly sessionStore: SessionStore,
    private readonly civitaiClient: CivitaiClient
  ) {
    ensureDir(this.config.cacheVideosDir);
  }

  async ensureCached(video: VideoRecord): Promise<CacheEntry> {
    const existing = this.db.getCacheEntry(video.id);
    if (existing && existing.status === "ready") {
      const ok = await this.verifyReadyEntry(existing);
      if (ok) {
        this.db.incrementMetric("cache_hits");
        this.db.touchCacheAccess(video.id);
        logger.info("cache.hit", { videoId: video.id, localPath: existing.localPath });
        return this.db.getCacheEntry(video.id) as CacheEntry;
      }
    }

    this.db.incrementMetric("cache_misses");

    const running = this.inFlight.get(video.id);
    if (running) {
      return running;
    }

    const task = this.downloadAndStore(video);
    this.inFlight.set(video.id, task);

    try {
      return await task;
    } finally {
      this.inFlight.delete(video.id);
    }
  }

  async enqueuePrefetch(video: VideoRecord): Promise<void> {
    void this.ensureCached(video).catch((error) => {
      logger.warn("prefetch.error", {
        videoId: video.id,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  async streamVideo(video: VideoRecord, reply: FastifyReply): Promise<FastifyReply> {
    const entry = await this.ensureCached(video);
    const stat = await fs.promises.stat(entry.localPath);
    const mime = await this.detectVideoMime(entry.localPath);

    reply.header("Content-Type", mime);
    reply.header("Content-Length", String(stat.size));
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.send(fs.createReadStream(entry.localPath));
  }

  async getDiskHealth(): Promise<{ freeBytes: number | null; lowDisk: boolean }> {
    const free = await getDiskFreeBytes(this.config.cacheVideosDir);
    if (free == null) {
      return { freeBytes: null, lowDisk: false };
    }

    const threshold = this.config.settings.lowDiskWarnGb * 1024 * 1024 * 1024;
    const lowDisk = free < threshold;
    if (lowDisk) {
      logger.warn("disk.low_space", {
        freeBytes: free,
        thresholdBytes: threshold
      });
    }

    return { freeBytes: free, lowDisk };
  }

  async flushCacheAndIndex(): Promise<{ deletedFilesEstimate: number; deletedBytesEstimate: number }> {
    if (this.inFlight.size > 0) {
      throw new Error("Cannot flush cache while downloads are in progress");
    }

    const before = this.db.getCacheStats();
    await fs.promises.rm(this.config.cacheVideosDir, { recursive: true, force: true });
    ensureDir(this.config.cacheVideosDir);
    this.db.resetCacheIndex();

    logger.warn("cache.flushed", {
      deletedFilesEstimate: before.readyVideos,
      deletedBytesEstimate: before.totalBytes
    });

    return {
      deletedFilesEstimate: before.readyVideos,
      deletedBytesEstimate: before.totalBytes
    };
  }

  private async verifyReadyEntry(entry: CacheEntry): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(entry.localPath);
      if (stat.size <= 0) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async downloadAndStore(video: VideoRecord): Promise<CacheEntry> {
    const localPath = path.join(this.config.cacheVideosDir, `${normalizeFileName(video.id)}.webm`);
    const tmpPath = `${localPath}.part`;

    this.db.upsertCacheEntry({
      videoId: video.id,
      localPath,
      status: "downloading"
    });

    const maxAttempts = Math.max(1, this.config.civitai.maxDownloadRetries);
    let lastError = "Unknown download error";

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const cookies = this.sessionStore.getCookies();
        if (!cookies) {
          throw new Error("No cookies available for media download");
        }

        const mediaCandidates = this.getMediaCandidates(video.mediaUrl);
        const initialAttempt = await this.tryDownloadCandidates(video, mediaCandidates, cookies);

        let response: Response | null = initialAttempt.response;
        let usedCandidate: string | null = initialAttempt.usedCandidate;
        let triedCount = initialAttempt.triedCount;
        let sourceLabel = "direct";

        if (!response) {
          const pageCandidates = await this.civitaiClient.fetchVideoSourceCandidatesFromPage(video.pageUrl, cookies);
          const fallbackCandidates = pageCandidates.filter((candidate) => !mediaCandidates.includes(candidate));
          if (fallbackCandidates.length > 0) {
            const pageAttempt = await this.tryDownloadCandidates(video, fallbackCandidates, cookies);
            response = pageAttempt.response;
            usedCandidate = pageAttempt.usedCandidate;
            triedCount += pageAttempt.triedCount;
            sourceLabel = "page";
          }
        }

        if (!response) {
          throw new Error(`Media request failed for all URL candidates (tried ${triedCount})`);
        }

        if (response.status === 401 || response.status === 403) {
          this.db.incrementMetric("auth_failures");
          throw new Error(`Unauthorized media download (${response.status})`);
        }

        if (!response.ok) {
          if (response.status >= 500 && attempt < maxAttempts) {
            throw new RetryableError(`Media request transient failure (${response.status})`);
          }
          throw new Error(`Media request failed (${response.status})`);
        }

        if (!response.body) {
          throw new Error("Media response has empty body");
        }

        await fs.promises.mkdir(path.dirname(localPath), { recursive: true });

        const readable = Readable.fromWeb(response.body as unknown as NodeReadableStream);
        const writable = fs.createWriteStream(tmpPath, { flags: "w" });
        await pipeline(readable, writable);

        const stat = await fs.promises.stat(tmpPath);
        if (stat.size <= 0) {
          throw new Error("Downloaded file is empty");
        }

        await fs.promises.rename(tmpPath, localPath);

        this.db.upsertCacheEntry({
          videoId: video.id,
          localPath,
          status: "ready",
          fileSize: stat.size
        });
        this.db.touchCacheAccess(video.id);

        logger.info("cache.download.success", {
          videoId: video.id,
          mediaUrl: usedCandidate,
          source: sourceLabel,
          bytes: stat.size,
          attempt
        });

        return this.db.getCacheEntry(video.id) as CacheEntry;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = message;

        await this.safeUnlink(tmpPath);

        const retryable = error instanceof RetryableError;
        logger.warn("cache.download.failed_attempt", {
          videoId: video.id,
          attempt,
          maxAttempts,
          retryable,
          error: message
        });

        if (!retryable || attempt >= maxAttempts) {
          break;
        }

        await this.sleep(300 * attempt);
      }
    }

    this.db.incrementMetric("download_failures");
    this.db.upsertCacheEntry({
      videoId: video.id,
      localPath,
      status: "failed",
      failureReason: lastError
    });

    throw new Error(lastError);
  }

  private async tryDownloadCandidates(
    video: VideoRecord,
    candidates: string[],
    cookies: string
  ): Promise<{ response: Response | null; usedCandidate: string | null; triedCount: number }> {
    let triedCount = 0;

    for (const candidate of candidates) {
      triedCount += 1;
      const candidateResponse = await this.civitaiClient.downloadMedia(candidate, cookies, video.pageUrl);

      if (candidateResponse.status === 401 || candidateResponse.status === 403) {
        this.db.incrementMetric("auth_failures");
        throw new Error(`Unauthorized media download (${candidateResponse.status})`);
      }

      if (!candidateResponse.ok) {
        continue;
      }

      const contentType = (candidateResponse.headers.get("content-type") ?? "").toLowerCase();
      if (!this.isLikelyVideoContentType(contentType)) {
        logger.warn("cache.download.rejected_content_type", {
          videoId: video.id,
          candidate,
          contentType
        });
        continue;
      }

      return {
        response: candidateResponse,
        usedCandidate: candidate,
        triedCount
      };
    }

    return {
      response: null,
      usedCandidate: null,
      triedCount
    };
  }

  private async safeUnlink(filePath: string): Promise<void> {
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // noop
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isLikelyVideoContentType(contentType: string): boolean {
    const value = contentType.trim().toLowerCase();
    if (!value) {
      return true;
    }
    if (value.startsWith("video/")) {
      return true;
    }
    if (value.includes("mp4") || value.includes("webm")) {
      return true;
    }
    if (value === "application/octet-stream" || value === "binary/octet-stream") {
      return true;
    }
    return false;
  }

  private getMediaCandidates(mediaUrl: string): string[] {
    const candidates: string[] = [];
    const push = (url: string): void => {
      if (!url) {
        return;
      }
      if (!candidates.includes(url)) {
        candidates.push(url);
      }
    };

    push(mediaUrl);

    const key = this.extractMediaAssetKey(mediaUrl);
    if (key) {
      push(`https://image-b2.civitai.com/file/civitai-media-cache/${key}/original`);
      push(`https://image.civitai.com/file/civitai-media-cache/${key}/original`);
    }

    return candidates;
  }

  private extractMediaAssetKey(mediaUrl: string): string | null {
    const trimmed = mediaUrl.trim();
    if (looksLikeUuid(trimmed)) {
      return trimmed;
    }

    try {
      const parsed = new URL(trimmed);
      const segments = parsed.pathname.split("/").filter(Boolean);
      const last = segments.at(-1) ?? "";
      if (looksLikeUuid(last)) {
        return last;
      }

      const cacheIdx = segments.findIndex((segment) => segment === "civitai-media-cache");
      if (cacheIdx >= 0 && segments[cacheIdx + 1] && looksLikeUuid(segments[cacheIdx + 1])) {
        return segments[cacheIdx + 1];
      }
    } catch {
      // not an absolute URL
    }

    return null;
  }

  private async detectVideoMime(localPath: string): Promise<string> {
    const fh = await fs.promises.open(localPath, "r");
    try {
      const header = Buffer.alloc(16);
      const result = await fh.read(header, 0, 16, 0);
      const bytes = header.subarray(0, result.bytesRead);

      if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
        return "video/webm";
      }

      if (bytes.length >= 8) {
        const ftyp = bytes.subarray(4, 8).toString("ascii");
        if (ftyp === "ftyp") {
          return "video/mp4";
        }
      }

      return "application/octet-stream";
    } finally {
      await fh.close();
    }
  }
}

class RetryableError extends Error {}
