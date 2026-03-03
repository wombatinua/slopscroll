import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { AppDb } from "../db";
import { SessionStore } from "../sessionStore";
import { CivitaiClient } from "../civitai/client";
import { FeedService } from "../services/feedService";
import { CacheService } from "../services/cacheService";
import { PrefetchService } from "../services/prefetchService";
import type { AppConfig } from "../config";
import { loadRequestSpec } from "../config";

interface Dependencies {
  config: AppConfig;
  db: AppDb;
  sessionStore: SessionStore;
  civitaiClient: CivitaiClient;
  feedService: FeedService;
  cacheService: CacheService;
  prefetchService: PrefetchService;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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

  app.put<{ Body: { prefetchDepth?: number; lowDiskWarnGb?: number } }>("/api/settings", async (req, reply) => {
    const existing = deps.db.getSettings(deps.config.settings);
    const next = {
      prefetchDepth: clamp(Number(req.body?.prefetchDepth ?? existing.prefetchDepth), 0, 10),
      lowDiskWarnGb: Math.max(0, Number(req.body?.lowDiskWarnGb ?? existing.lowDiskWarnGb))
    };

    if (!Number.isFinite(next.lowDiskWarnGb)) {
      reply.code(400);
      return { ok: false, error: "lowDiskWarnGb must be a number" };
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
