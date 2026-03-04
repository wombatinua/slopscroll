import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { loadConfig, loadRequestSpec } from "./config";
import { logger } from "./logger";
import { ensureDir } from "./utils/fs";
import { AppDb } from "./db";
import { SessionStore } from "./sessionStore";
import { CivitaiClient } from "./civitai/client";
import { FeedService } from "./services/feedService";
import { ImageCatalogService } from "./services/imageCatalogService";
import { CacheService } from "./services/cacheService";
import { PrefetchService } from "./services/prefetchService";
import { AudioLibraryService } from "./services/audioLibraryService";
import { registerApiRoutes } from "./routes/api";

async function bootstrap(): Promise<void> {
  const config = loadConfig();

  ensureDir(config.dataDir);
  ensureDir(config.soundsDir);
  ensureDir(config.cacheVideosDir);
  ensureDir(config.cacheImagesDir);
  ensureDir(path.dirname(config.sessionPath));

  const db = new AppDb(config.dbPath);
  const cachePathReconcile = db.normalizeCacheLocalPathsToFileNames();
  if (cachePathReconcile.updated > 0) {
    logger.info("startup.cache_paths_normalized", cachePathReconcile);
  }
  const settings = db.getSettings(config.settings);
  db.setSettings(settings);
  config.settings = settings;

  const sessionStore = new SessionStore(config.sessionPath);
  const requestSpec = loadRequestSpec(config.requestSpecPath);
  const civitaiClient = new CivitaiClient(config, requestSpec);
  const imageCatalogService = new ImageCatalogService(config.cacheImagesDir);
  const feedService = new FeedService(config, db, sessionStore, civitaiClient, imageCatalogService);
  const cacheService = new CacheService(db, config, sessionStore, civitaiClient);
  const prefetchService = new PrefetchService(feedService, cacheService);
  const audioLibraryService = new AudioLibraryService(config.soundsDir);

  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024 * 2
  });

  app.register(fastifyStatic, {
    root: config.staticDir,
    prefix: "/"
  });

  app.get("/", async (_req, reply) => {
    return reply.sendFile("index.html");
  });

  await registerApiRoutes(app, {
    config,
    db,
    sessionStore,
    civitaiClient,
    feedService,
    cacheService,
    prefetchService,
    audioLibraryService
  });

  app.addHook("onClose", async () => {
    db.close();
  });

  if (!requestSpec) {
    logger.warn("startup.request_spec_missing", {
      path: config.requestSpecPath,
      message: "Generate via: npm run parse-har -- <path-to.har>"
    });
  }

  const sessionExists = Boolean(sessionStore.getCookies());
  logger.info("startup", {
    appVersion: config.appVersion,
    appCommit: config.appCommit,
    appCommitBuild: config.appCommitBuild,
    appCommitLocal: config.appCommitLocal,
    port: config.port,
    host: config.host,
    staticDir: config.staticDir,
    soundsDir: config.soundsDir,
    hasCookies: sessionExists,
    hasRequestSpec: Boolean(requestSpec)
  });

  try {
    await app.listen({ port: config.port, host: config.host });
    logger.info("server.listening", {
      url: `http://${config.host}:${config.port}`
    });
  } catch (error) {
    logger.error("server.start_failed", {
      error: error instanceof Error ? error.message : String(error)
    });
    process.exit(1);
  }
}

void bootstrap();
