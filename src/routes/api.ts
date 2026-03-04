import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { AppDb } from "../db";
import { SessionStore } from "../sessionStore";
import { CivitaiClient } from "../civitai/client";
import { FeedService } from "../services/feedService";
import { CacheService } from "../services/cacheService";
import { PrefetchService } from "../services/prefetchService";
import { AudioLibraryService } from "../services/audioLibraryService";
import type { AppConfig } from "../config";
import { loadRequestSpec } from "../config";
import type { FeedPeriod, FeedSort } from "../types";

interface Dependencies {
  config: AppConfig;
  db: AppDb;
  sessionStore: SessionStore;
  civitaiClient: CivitaiClient;
  feedService: FeedService;
  cacheService: CacheService;
  prefetchService: PrefetchService;
  audioLibraryService: AudioLibraryService;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const FEED_SORT_VALUES: FeedSort[] = ["Most Reactions", "Most Comments", "Most Collected", "Newest", "Oldest"];
const FEED_PERIOD_VALUES: FeedPeriod[] = ["Day", "Week", "Month", "Year", "AllTime"];

function normalizeFeedSort(value: unknown, fallback: FeedSort): FeedSort {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  const match = FEED_SORT_VALUES.find((candidate) => candidate.toLowerCase() === normalized);
  return match ?? fallback;
}

function normalizeFeedPeriod(value: unknown, fallback: FeedPeriod): FeedPeriod {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  const match = FEED_PERIOD_VALUES.find((candidate) => candidate.toLowerCase() === normalized);
  return match ?? fallback;
}

export async function registerApiRoutes(app: FastifyInstance, deps: Dependencies): Promise<void> {
  app.get("/api/health", async () => ({ ok: true, ts: new Date().toISOString() }));

  app.post<{ Body: { cookies?: string } }>("/api/auth/cookies", async (req, reply) => {
    const cookies = (req.body?.cookies ?? "").trim();
    if (!cookies) {
      reply.code(400);
      return { ok: false, error: "cookies is required" };
    }

    const payload = deps.sessionStore.setCookies(cookies);
    const authState = await deps.civitaiClient.validateAuth(cookies);
    return {
      ok: true,
      updatedAt: payload.updatedAt,
      validationPassed: authState.isValid,
      auth: authState
    };
  });

  app.get("/api/auth/status", async () => {
    const cookies = deps.sessionStore.getCookies();
    if (!cookies) {
      return {
        isValid: false,
        checkedAt: new Date().toISOString(),
        failureReason: "No cookies imported"
      };
    }

    return deps.civitaiClient.validateAuth(cookies);
  });

  app.post("/api/spec/reload", async () => {
    const spec = loadRequestSpec(deps.config.requestSpecPath);
    deps.civitaiClient.setRequestSpec(spec);

    return {
      ok: Boolean(spec),
      hasSpec: Boolean(spec),
      path: deps.config.requestSpecPath
    };
  });

  app.get<{ Querystring: { cursor?: string; limit?: string; author?: string } }>("/api/feed/next", async (req, reply) => {
    const limit = clamp(Number.parseInt(req.query.limit ?? "10", 10) || 10, 1, 20);
    const cursor = req.query.cursor?.trim() || null;
    const author = req.query.author?.trim() || null;

    try {
      const page = await deps.feedService.getNextFeed(cursor, limit, author);
      return {
        ok: true,
        author,
        ...page
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isAuth = /unauthorized|cookie|auth/i.test(message);
      reply.code(isAuth ? 401 : 500);
      return {
        ok: false,
        error: message,
        requiresReimport: isAuth
      };
    }
  });

  app.get<{ Querystring: { author?: string; refresh?: string } }>("/api/feed/author-stats", async (req, reply) => {
    const author = req.query.author?.trim() || "";
    if (!author) {
      reply.code(400);
      return {
        ok: false,
        error: "author is required"
      };
    }

    const refresh = req.query.refresh === "1" || req.query.refresh === "true";

    try {
      const result = await deps.feedService.getAuthorVideoTotal(author, { forceRefresh: refresh });
      return {
        ok: true,
        ...result
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isAuth = /unauthorized|cookie|auth/i.test(message);
      reply.code(isAuth ? 401 : 500);
      return {
        ok: false,
        error: message,
        requiresReimport: isAuth
      };
    }
  });

  app.post<{ Body: { videoIds?: string[] } }>("/api/prefetch", async (req, reply) => {
    const ids = Array.isArray(req.body?.videoIds)
      ? req.body.videoIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];

    if (ids.length === 0) {
      reply.code(400);
      return {
        ok: false,
        error: "videoIds must be a non-empty string[]"
      };
    }

    const result = await deps.prefetchService.prefetchVideoIds(ids);
    return {
      ok: true,
      ...result
    };
  });

  app.get<{ Params: { id: string } }>("/api/video/:id", async (req, reply) => {
    const video = deps.feedService.getVideo(req.params.id);
    if (!video) {
      reply.code(404);
      return {
        ok: false,
        error: "Video is not known locally. Fetch feed first."
      };
    }

    try {
      return deps.cacheService.streamVideo(video, reply);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isAuth = /unauthorized|cookie|auth/i.test(message);
      reply.code(isAuth ? 401 : 500);
      return {
        ok: false,
        error: message,
        requiresReimport: isAuth
      };
    }
  });

  app.get("/api/settings", async () => {
    const settings = deps.db.getSettings(deps.config.settings);
    deps.config.settings = settings;
    return {
      ok: true,
      settings
    };
  });

  app.get("/api/likes/users", async () => {
    return {
      ok: true,
      users: deps.db.listLikedUsers()
    };
  });

  app.post<{ Body: { username?: string; liked?: boolean } }>("/api/likes/user", async (req, reply) => {
    const username = (req.body?.username ?? "").trim().toLowerCase();
    if (!username) {
      reply.code(400);
      return {
        ok: false,
        error: "username is required"
      };
    }
    if (typeof req.body?.liked !== "boolean") {
      reply.code(400);
      return {
        ok: false,
        error: "liked must be a boolean"
      };
    }

    deps.db.setUserLiked(username, req.body.liked);
    return {
      ok: true,
      username,
      liked: deps.db.isUserLiked(username)
    };
  });

  app.post<{ Body: { videoId?: string; liked?: boolean } }>("/api/likes/video", async (req, reply) => {
    const videoId = (req.body?.videoId ?? "").trim();
    if (!videoId) {
      reply.code(400);
      return {
        ok: false,
        error: "videoId is required"
      };
    }
    if (typeof req.body?.liked !== "boolean") {
      reply.code(400);
      return {
        ok: false,
        error: "liked must be a boolean"
      };
    }

    const known = deps.db.getVideo(videoId);
    if (!known) {
      reply.code(404);
      return {
        ok: false,
        error: "Unknown videoId"
      };
    }

    deps.db.setVideoLiked(videoId, req.body.liked);
    return {
      ok: true,
      videoId,
      liked: req.body.liked
    };
  });

  app.put<{
    Body: {
      prefetchDepth?: number;
      lowDiskWarnGb?: number;
      audioEnabled?: boolean;
      audioAutoSwitchEnabled?: boolean;
      audioSwitchOnVideoChangeEnabled?: boolean;
      audioMinSwitchSec?: number;
      audioMaxSwitchSec?: number;
      audioCrossfadeSec?: number;
      browsingLevelR?: boolean;
      browsingLevelX?: boolean;
      browsingLevelXXX?: boolean;
      feedSort?: string;
      feedPeriod?: string;
    };
  }>("/api/settings", async (req, reply) => {
    const existing = deps.db.getSettings(deps.config.settings);
    const requestedAudioMin = Number(req.body?.audioMinSwitchSec ?? existing.audioMinSwitchSec);
    const requestedAudioMax = Number(req.body?.audioMaxSwitchSec ?? existing.audioMaxSwitchSec);
    const requestedAudioCrossfade = Number(req.body?.audioCrossfadeSec ?? existing.audioCrossfadeSec);
    const audioMinSwitchSec = clamp(Math.trunc(requestedAudioMin), 1, 3600);
    const audioMaxSwitchSec = clamp(Math.trunc(requestedAudioMax), 1, 3600);
    const normalizedAudioMin = Math.min(audioMinSwitchSec, audioMaxSwitchSec);
    const normalizedAudioMax = Math.max(audioMinSwitchSec, audioMaxSwitchSec);
    const normalizedAudioCrossfade = Math.max(0, Math.min(30, requestedAudioCrossfade));

    const next = {
      prefetchDepth: clamp(Number(req.body?.prefetchDepth ?? existing.prefetchDepth), 0, 10),
      lowDiskWarnGb: Math.max(0, Number(req.body?.lowDiskWarnGb ?? existing.lowDiskWarnGb)),
      audioEnabled: Boolean(req.body?.audioEnabled ?? existing.audioEnabled),
      audioAutoSwitchEnabled: Boolean(req.body?.audioAutoSwitchEnabled ?? existing.audioAutoSwitchEnabled),
      audioSwitchOnVideoChangeEnabled: Boolean(
        req.body?.audioSwitchOnVideoChangeEnabled ?? existing.audioSwitchOnVideoChangeEnabled
      ),
      audioMinSwitchSec: normalizedAudioMin,
      audioMaxSwitchSec: normalizedAudioMax,
      audioCrossfadeSec: normalizedAudioCrossfade,
      browsingLevelR: Boolean(req.body?.browsingLevelR ?? existing.browsingLevelR),
      browsingLevelX: Boolean(req.body?.browsingLevelX ?? existing.browsingLevelX),
      browsingLevelXXX: Boolean(req.body?.browsingLevelXXX ?? existing.browsingLevelXXX),
      feedSort: normalizeFeedSort(req.body?.feedSort, existing.feedSort),
      feedPeriod: normalizeFeedPeriod(req.body?.feedPeriod, existing.feedPeriod)
    };

    if (!Number.isFinite(next.lowDiskWarnGb)) {
      reply.code(400);
      return { ok: false, error: "lowDiskWarnGb must be a number" };
    }
    if (!Number.isFinite(requestedAudioMin) || !Number.isFinite(requestedAudioMax)) {
      reply.code(400);
      return { ok: false, error: "audioMinSwitchSec and audioMaxSwitchSec must be numbers" };
    }
    if (!Number.isFinite(requestedAudioCrossfade)) {
      reply.code(400);
      return { ok: false, error: "audioCrossfadeSec must be a number" };
    }

    deps.db.setSettings(next);
    deps.config.settings = next;

    return {
      ok: true,
      settings: next
    };
  });

  app.get("/api/cache/stats", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Pragma", "no-cache");
    const stats = deps.db.getCacheStats();
    const disk = await deps.cacheService.getDiskHealth();
    return {
      ok: true,
      stats,
      disk,
      cacheDir: deps.config.cacheVideosDir,
      specConfigured: fs.existsSync(deps.config.requestSpecPath)
    };
  });

  app.get("/api/audio/library", async () => {
    const files = await deps.audioLibraryService.listLibrary();
    return {
      ok: true,
      files,
      mediaDir: deps.config.mediaDir
    };
  });

  app.get<{ Params: { name: string } }>("/api/audio/file/:name", async (req, reply) => {
    const file = await deps.audioLibraryService.resolveAudioFile(req.params.name);
    if (!file) {
      reply.code(404);
      return {
        ok: false,
        error: "Audio file not found"
      };
    }

    reply.header("Content-Type", file.mimeType);
    reply.header("Content-Length", String(file.size));
    reply.header("Cache-Control", "public, max-age=3600");
    return reply.send(fs.createReadStream(file.path));
  });

  app.post<{ Body: { confirm?: boolean } }>("/api/cache/flush", async (req, reply) => {
    if (req.body?.confirm !== true) {
      reply.code(400);
      return {
        ok: false,
        error: "confirm=true is required"
      };
    }

    try {
      const result = await deps.cacheService.flushCacheAndIndex();
      deps.feedService.resetInMemoryState();
      return {
        ok: true,
        ...result
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(500);
      return {
        ok: false,
        error: message
      };
    }
  });
}
