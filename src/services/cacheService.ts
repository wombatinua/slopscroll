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

interface PrefetchTask {
  video: VideoRecord;
}

interface CandidateDiagnostics {
  statusCounts: Record<string, number>;
  rejectedContentTypeCounts: Record<string, number>;
  sampleFailures: string[];
}

interface CandidateAttemptResult {
  response: Response | null;
  usedCandidate: string | null;
  triedCount: number;
  diagnostics: CandidateDiagnostics;
}

export class CacheService {
  private readonly inFlight = new Map<string, Promise<CacheEntry>>();
  private readonly prefetchQueue: PrefetchTask[] = [];
  private readonly queuedPrefetchIds = new Set<string>();
  private activePrefetchWorkers = 0;

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
        logger.info("cache.hit", { videoId: video.id, localPath: existing.localPath });
        return this.db.getCacheEntry(video.id) as CacheEntry;
      }
    }

    const running = this.inFlight.get(video.id);
    if (running) {
      return running;
    }

    this.db.incrementMetric("cache_misses");

    const task = this.downloadAndStore(video);
    this.inFlight.set(video.id, task);

    try {
      return await task;
    } finally {
      this.inFlight.delete(video.id);
    }
  }

  async enqueuePrefetch(video: VideoRecord): Promise<void> {
    const existing = this.db.getCacheEntry(video.id);
    if (existing?.status === "ready") {
      const ok = await this.verifyReadyEntry(existing);
      if (ok) {
        return;
      }
    }
    if (this.inFlight.has(video.id) || this.queuedPrefetchIds.has(video.id)) {
      return;
    }

    this.prefetchQueue.push({ video });
    this.queuedPrefetchIds.add(video.id);
    this.pumpPrefetchQueue();
  }

  async streamVideo(video: VideoRecord, reply: FastifyReply): Promise<FastifyReply> {
    const entry = await this.ensureCached(video);
    return this.streamCachedFile(entry.localPath, reply);
  }

  async streamCachedFile(localPath: string, reply: FastifyReply): Promise<FastifyReply> {
    const resolvedPath = this.resolveStoredCachePath(localPath);
    const stat = await fs.promises.stat(resolvedPath);
    const mime = await this.detectVideoMime(resolvedPath);

    reply.header("Content-Type", mime);
    reply.header("Content-Length", String(stat.size));
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.send(fs.createReadStream(resolvedPath));
  }

  hasStoredCacheFile(localPath: string): boolean {
    const resolvedPath = this.resolveStoredCachePath(localPath);
    try {
      const stat = fs.statSync(resolvedPath);
      return stat.isFile() && stat.size > 0;
    } catch {
      return false;
    }
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

    this.prefetchQueue.length = 0;
    this.queuedPrefetchIds.clear();

    const before = this.db.getCacheStats();
    await this.clearDirectoryContents(this.config.cacheVideosDir);
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
    const resolvedPath = this.resolveStoredCachePath(entry.localPath);
    try {
      const stat = await fs.promises.stat(resolvedPath);
      if (stat.size <= 0) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async downloadAndStore(video: VideoRecord): Promise<CacheEntry> {
    const localPath = `${normalizeFileName(video.id)}.webm`;
    const resolvedPath = this.resolveStoredCachePath(localPath);
    const tmpPath = `${resolvedPath}.part`;

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
        const initialAttempt = await this.tryDownloadCandidates(video, mediaCandidates, cookies, attempt);

        let response: Response | null = initialAttempt.response;
        let usedCandidate: string | null = initialAttempt.usedCandidate;
        let triedCount = initialAttempt.triedCount;
        let sourceLabel = "direct";
        const diagnostics = this.createCandidateDiagnostics();
        this.mergeCandidateDiagnostics(diagnostics, initialAttempt.diagnostics);

        if (!response) {
          const pageCandidates = await this.civitaiClient.fetchVideoSourceCandidatesFromPage(video.pageUrl, cookies);
          const fallbackCandidates = pageCandidates.filter((candidate) => !mediaCandidates.includes(candidate));
          if (fallbackCandidates.length > 0) {
            const pageAttempt = await this.tryDownloadCandidates(video, fallbackCandidates, cookies, attempt);
            response = pageAttempt.response;
            usedCandidate = pageAttempt.usedCandidate;
            triedCount += pageAttempt.triedCount;
            this.mergeCandidateDiagnostics(diagnostics, pageAttempt.diagnostics);
            sourceLabel = "page";
          }
        }

        if (!response) {
          const diagnosticsSummary = this.formatCandidateDiagnostics(diagnostics);
          throw new Error(`Media request failed for all URL candidates (tried ${triedCount}; ${diagnosticsSummary})`);
        }

        if (response.status === 401 || response.status === 403) {
          this.db.incrementMetric("auth_failures");
          throw new Error(`Unauthorized media download (${response.status})`);
        }

        if (response.status === 429) {
          throw new RetryableError("Media request rate limited (429)", this.getRetryDelayMs(response, attempt));
        }

        if (!response.ok) {
          if (response.status >= 500 && attempt < maxAttempts) {
            throw new RetryableError(`Media request transient failure (${response.status})`, this.computeJitteredBackoffMs(attempt));
          }
          throw new Error(`Media request failed (${response.status})`);
        }

        if (!response.body) {
          throw new Error("Media response has empty body");
        }

        await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });

        const readable = Readable.fromWeb(response.body as unknown as NodeReadableStream);
        const writable = fs.createWriteStream(tmpPath, { flags: "w" });
        await pipeline(readable, writable);

        const stat = await fs.promises.stat(tmpPath);
        if (stat.size <= 0) {
          throw new Error("Downloaded file is empty");
        }

        await fs.promises.rename(tmpPath, resolvedPath);

        this.db.upsertCacheEntry({
          videoId: video.id,
          localPath,
          status: "ready",
          fileSize: stat.size
        });

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
        const retryDelayMs = retryable ? this.resolveRetryDelayMs(error, attempt) : null;
        logger.warn("cache.download.failed_attempt", {
          videoId: video.id,
          attempt,
          maxAttempts,
          retryable,
          retryDelayMs,
          error: message
        });

        if (!retryable || attempt >= maxAttempts) {
          break;
        }

        await this.sleep(retryDelayMs ?? this.computeJitteredBackoffMs(attempt));
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
    cookies: string,
    attempt: number
  ): Promise<CandidateAttemptResult> {
    let triedCount = 0;
    let transientFailure: RetryableError | null = null;
    const diagnostics = this.createCandidateDiagnostics();

    for (const candidate of candidates) {
      triedCount += 1;
      const candidateResponse = await this.civitaiClient.downloadMedia(candidate, cookies, video.pageUrl);
      this.bumpCounter(diagnostics.statusCounts, String(candidateResponse.status));

      if (candidateResponse.status === 401 || candidateResponse.status === 403) {
        this.db.incrementMetric("auth_failures");
        this.pushFailureSample(diagnostics, candidate, `status=${candidateResponse.status}`);
        throw new Error(`Unauthorized media download (${candidateResponse.status})`);
      }

      if (candidateResponse.status === 429) {
        const retryDelayMs = this.getRetryDelayMs(candidateResponse, attempt);
        logger.warn("cache.download.rate_limited", {
          videoId: video.id,
          candidate,
          retryDelayMs
        });
        throw new RetryableError("Media request rate limited (429)", retryDelayMs);
      }

      if (candidateResponse.status >= 500) {
        this.pushFailureSample(diagnostics, candidate, `status=${candidateResponse.status}`);
        transientFailure = new RetryableError(
          `Media request transient failure (${candidateResponse.status})`,
          this.computeJitteredBackoffMs(attempt)
        );
        continue;
      }

      if (!candidateResponse.ok) {
        this.pushFailureSample(diagnostics, candidate, `status=${candidateResponse.status}`);
        continue;
      }

      const contentType = (candidateResponse.headers.get("content-type") ?? "").toLowerCase();
      if (!this.isLikelyVideoContentType(contentType)) {
        this.bumpCounter(diagnostics.rejectedContentTypeCounts, contentType || "<empty>");
        this.pushFailureSample(diagnostics, candidate, `content-type=${contentType || "<empty>"}`);
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
        triedCount,
        diagnostics
      };
    }

    if (transientFailure) {
      throw transientFailure;
    }

    return {
      response: null,
      usedCandidate: null,
      triedCount,
      diagnostics
    };
  }

  private createCandidateDiagnostics(): CandidateDiagnostics {
    return {
      statusCounts: {},
      rejectedContentTypeCounts: {},
      sampleFailures: []
    };
  }

  private mergeCandidateDiagnostics(target: CandidateDiagnostics, source: CandidateDiagnostics): void {
    this.mergeCounters(target.statusCounts, source.statusCounts);
    this.mergeCounters(target.rejectedContentTypeCounts, source.rejectedContentTypeCounts);
    for (const sample of source.sampleFailures) {
      if (target.sampleFailures.length >= 6) {
        break;
      }
      target.sampleFailures.push(sample);
    }
  }

  private mergeCounters(target: Record<string, number>, source: Record<string, number>): void {
    for (const [key, value] of Object.entries(source)) {
      target[key] = (target[key] ?? 0) + value;
    }
  }

  private bumpCounter(counter: Record<string, number>, key: string): void {
    counter[key] = (counter[key] ?? 0) + 1;
  }

  private pushFailureSample(diagnostics: CandidateDiagnostics, candidate: string, reason: string): void {
    if (diagnostics.sampleFailures.length >= 6) {
      return;
    }
    diagnostics.sampleFailures.push(`${reason} @ ${candidate}`);
  }

  private formatCounter(counter: Record<string, number>): string {
    const entries = Object.entries(counter);
    if (entries.length === 0) {
      return "none";
    }
    return entries
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => `${key}x${count}`)
      .join(", ");
  }

  private formatCandidateDiagnostics(diagnostics: CandidateDiagnostics): string {
    const statusSummary = this.formatCounter(diagnostics.statusCounts);
    const contentTypeSummary = this.formatCounter(diagnostics.rejectedContentTypeCounts);
    const samples = diagnostics.sampleFailures.length > 0 ? diagnostics.sampleFailures.join(" | ") : "none";
    return `statuses: ${statusSummary}; rejected-content-types: ${contentTypeSummary}; samples: ${samples}`;
  }

  private pumpPrefetchQueue(): void {
    const limit = Math.max(1, this.config.civitai.prefetchConcurrency);
    while (this.activePrefetchWorkers < limit && this.prefetchQueue.length > 0) {
      const task = this.prefetchQueue.shift();
      if (!task) {
        break;
      }

      this.queuedPrefetchIds.delete(task.video.id);
      this.activePrefetchWorkers += 1;

      void this.ensureCached(task.video)
        .catch((error) => {
          logger.warn("prefetch.error", {
            videoId: task.video.id,
            error: error instanceof Error ? error.message : String(error)
          });
        })
        .finally(() => {
          this.activePrefetchWorkers -= 1;
          this.pumpPrefetchQueue();
        });
    }
  }

  private async safeUnlink(filePath: string): Promise<void> {
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // noop
    }
  }

  private async clearDirectoryContents(dirPath: string): Promise<void> {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === ".gitkeep") {
          continue;
        }
        const targetPath = path.join(dirPath, entry.name);
        await fs.promises.rm(targetPath, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private resolveRetryDelayMs(error: RetryableError, attempt: number): number {
    const delayMs = error.delayMs;
    if (typeof delayMs === "number" && Number.isFinite(delayMs) && delayMs > 0) {
      return Math.max(100, Math.min(60000, Math.round(delayMs)));
    }
    return this.computeJitteredBackoffMs(attempt);
  }

  private computeJitteredBackoffMs(attempt: number): number {
    const baseMs = 400;
    const maxMs = 10000;
    const exponential = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
    const jitter = 0.7 + Math.random() * 0.6;
    return Math.round(exponential * jitter);
  }

  private getRetryDelayMs(response: Response, attempt: number): number {
    const retryAfter = response.headers.get("retry-after");
    if (!retryAfter) {
      return this.computeJitteredBackoffMs(attempt);
    }

    const retrySeconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(retrySeconds)) {
      return Math.max(100, Math.min(60000, Math.round(retrySeconds * 1000)));
    }

    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      const delay = retryAt - Date.now();
      return Math.max(100, Math.min(60000, delay));
    }

    return this.computeJitteredBackoffMs(attempt);
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

  private resolveStoredCachePath(localPath: string): string {
    const normalized = path.basename(localPath.trim().replace(/\\/g, "/"));
    if (!normalized) {
      throw new Error("Invalid cached localPath");
    }
    return path.join(this.config.cacheVideosDir, normalized);
  }
}

class RetryableError extends Error {
  constructor(
    message: string,
    public readonly delayMs?: number
  ) {
    super(message);
  }
}
