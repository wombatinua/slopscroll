import fs from "node:fs";
import path from "node:path";
import type { CivitaiRequestSpec, FeedMode, FeedPeriod, FeedSort, OfflineFeedOrder, Settings } from "./types";

export interface AppConfig {
  host: string;
  port: number;
  mediaDir: string;
  dataDir: string;
  cacheVideosDir: string;
  cacheImagesDir: string;
  dbPath: string;
  sessionPath: string;
  requestSpecPath: string;
  staticDir: string;
  settings: Settings;
  civitai: {
    validatePath: string;
    requestTimeoutMs: number;
    downloadTimeoutMs: number;
    maxDownloadRetries: number;
    prefetchConcurrency: number;
  };
}

interface PartialConfig {
  host?: string;
  port?: number;
  mediaDir?: string;
  dataDir?: string;
  settings?: Partial<Settings>;
  civitai?: {
    validatePath?: string;
    requestTimeoutMs?: number;
    downloadTimeoutMs?: number;
    maxDownloadRetries?: number;
    prefetchConcurrency?: number;
  };
}

const ROOT = process.cwd();
const DEFAULT_DATA_DIR = path.join(ROOT, "data");
const DEFAULT_MEDIA_DIR = path.join(ROOT, "media");
const ALLOWED_FEED_SORTS: FeedSort[] = ["Most Reactions", "Most Comments", "Most Collected", "Newest", "Oldest"];
const ALLOWED_FEED_PERIODS: FeedPeriod[] = ["Day", "Week", "Month", "Year", "AllTime"];
const ALLOWED_OFFLINE_FEED_ORDERS: OfflineFeedOrder[] = ["Newest", "Oldest", "Random"];
const ALLOWED_FEED_MODES: FeedMode[] = ["online", "offline_video", "offline_image"];

export const defaultConfig: AppConfig = {
  host: "0.0.0.0",
  port: 3579,
  mediaDir: DEFAULT_MEDIA_DIR,
  dataDir: DEFAULT_DATA_DIR,
  cacheVideosDir: path.join(DEFAULT_DATA_DIR, "cache", "videos"),
  cacheImagesDir: path.join(DEFAULT_DATA_DIR, "cache", "images"),
  dbPath: path.join(DEFAULT_DATA_DIR, "slopscroll.db"),
  sessionPath: path.join(DEFAULT_DATA_DIR, "session", "auth.json"),
  requestSpecPath: path.join(DEFAULT_DATA_DIR, "civitai-request-spec.json"),
  staticDir: path.join(ROOT, "public"),
  settings: {
    prefetchDepth: 3,
    lowDiskWarnGb: 2,
    audioEnabled: false,
    audioAutoSwitchEnabled: true,
    audioSwitchOnVideoChangeEnabled: true,
    audioMinSwitchSec: 15,
    audioMaxSwitchSec: 45,
    audioCrossfadeSec: 2,
    browsingLevelR: false,
    browsingLevelX: true,
    browsingLevelXXX: true,
    feedSort: "Newest",
    feedPeriod: "Week",
    feedMode: "online",
    offlineFeedOrder: "Newest"
  },
  civitai: {
    validatePath: "",
    requestTimeoutMs: 15000,
    downloadTimeoutMs: 60000,
    maxDownloadRetries: 3,
    prefetchConcurrency: 1
  }
};

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as T;
}

function toInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNum(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toFeedSort(value: string | undefined, fallback: FeedSort): FeedSort {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  const match = ALLOWED_FEED_SORTS.find((candidate) => candidate.toLowerCase() === normalized);
  return match ?? fallback;
}

function toFeedPeriod(value: string | undefined, fallback: FeedPeriod): FeedPeriod {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  const match = ALLOWED_FEED_PERIODS.find((candidate) => candidate.toLowerCase() === normalized);
  return match ?? fallback;
}

function toOfflineFeedOrder(value: string | undefined, fallback: OfflineFeedOrder): OfflineFeedOrder {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  const match = ALLOWED_OFFLINE_FEED_ORDERS.find((candidate) => candidate.toLowerCase() === normalized);
  return match ?? fallback;
}

function toFeedMode(value: string | undefined, fallback: FeedMode): FeedMode {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  const match = ALLOWED_FEED_MODES.find((candidate) => candidate.toLowerCase() === normalized);
  return match ?? fallback;
}

export function loadConfig(): AppConfig {
  const localPath = path.join(ROOT, "config", "local.json");
  const localConfig = readJsonFile<PartialConfig>(localPath) ?? {};
  const legacyLocalOfflineEnabledRaw = (localConfig.settings as { offlineModeEnabled?: unknown } | undefined)?.offlineModeEnabled;
  const legacyLocalOfflineEnabled =
    typeof legacyLocalOfflineEnabledRaw === "boolean"
      ? legacyLocalOfflineEnabledRaw
      : String(legacyLocalOfflineEnabledRaw ?? "").toLowerCase() === "true";
  const legacyEnvOfflineEnabledRaw = process.env.SLOPSCROLL_OFFLINE_MODE_ENABLED;
  const legacyEnvOfflineEnabled = legacyEnvOfflineEnabledRaw != null && legacyEnvOfflineEnabledRaw.toLowerCase() === "true";
  const inferredLegacyFeedMode = legacyEnvOfflineEnabled || legacyLocalOfflineEnabled ? "offline_video" : "online";

  const host = process.env.SLOPSCROLL_HOST ?? localConfig.host ?? defaultConfig.host;
  const port = toInt(process.env.SLOPSCROLL_PORT, localConfig.port ?? defaultConfig.port);
  const mediaDir = process.env.SLOPSCROLL_MEDIA_DIR ?? localConfig.mediaDir ?? defaultConfig.mediaDir;
  const dataDir = process.env.SLOPSCROLL_DATA_DIR ?? localConfig.dataDir ?? defaultConfig.dataDir;

  const settings: Settings = {
    prefetchDepth: toInt(process.env.SLOPSCROLL_PREFETCH_DEPTH, localConfig.settings?.prefetchDepth ?? defaultConfig.settings.prefetchDepth),
    lowDiskWarnGb: toNum(process.env.SLOPSCROLL_LOW_DISK_WARN_GB, localConfig.settings?.lowDiskWarnGb ?? defaultConfig.settings.lowDiskWarnGb),
    audioEnabled:
      (process.env.SLOPSCROLL_AUDIO_ENABLED ?? String(localConfig.settings?.audioEnabled ?? defaultConfig.settings.audioEnabled)).toLowerCase() ===
      "true",
    audioAutoSwitchEnabled:
      (
        process.env.SLOPSCROLL_AUDIO_AUTO_SWITCH_ENABLED ??
        String(localConfig.settings?.audioAutoSwitchEnabled ?? defaultConfig.settings.audioAutoSwitchEnabled)
      ).toLowerCase() === "true",
    audioSwitchOnVideoChangeEnabled:
      (
        process.env.SLOPSCROLL_AUDIO_SWITCH_ON_VIDEO_CHANGE_ENABLED ??
        String(localConfig.settings?.audioSwitchOnVideoChangeEnabled ?? defaultConfig.settings.audioSwitchOnVideoChangeEnabled)
      ).toLowerCase() === "true",
    audioMinSwitchSec: toInt(
      process.env.SLOPSCROLL_AUDIO_MIN_SWITCH_SEC,
      localConfig.settings?.audioMinSwitchSec ?? defaultConfig.settings.audioMinSwitchSec
    ),
    audioMaxSwitchSec: toInt(
      process.env.SLOPSCROLL_AUDIO_MAX_SWITCH_SEC,
      localConfig.settings?.audioMaxSwitchSec ?? defaultConfig.settings.audioMaxSwitchSec
    ),
    audioCrossfadeSec: toNum(
      process.env.SLOPSCROLL_AUDIO_CROSSFADE_SEC,
      localConfig.settings?.audioCrossfadeSec ?? defaultConfig.settings.audioCrossfadeSec
    ),
    browsingLevelR:
      (process.env.SLOPSCROLL_BROWSING_LEVEL_R ?? String(localConfig.settings?.browsingLevelR ?? defaultConfig.settings.browsingLevelR)).toLowerCase() ===
      "true",
    browsingLevelX:
      (process.env.SLOPSCROLL_BROWSING_LEVEL_X ?? String(localConfig.settings?.browsingLevelX ?? defaultConfig.settings.browsingLevelX)).toLowerCase() ===
      "true",
    browsingLevelXXX:
      (
        process.env.SLOPSCROLL_BROWSING_LEVEL_XXX ??
        String(localConfig.settings?.browsingLevelXXX ?? defaultConfig.settings.browsingLevelXXX)
      ).toLowerCase() === "true",
    feedSort: toFeedSort(process.env.SLOPSCROLL_FEED_SORT, localConfig.settings?.feedSort ?? defaultConfig.settings.feedSort),
    feedPeriod: toFeedPeriod(process.env.SLOPSCROLL_FEED_PERIOD, localConfig.settings?.feedPeriod ?? defaultConfig.settings.feedPeriod),
    feedMode: toFeedMode(
      process.env.SLOPSCROLL_FEED_MODE,
      localConfig.settings?.feedMode ?? (inferredLegacyFeedMode as FeedMode)
    ),
    offlineFeedOrder: toOfflineFeedOrder(
      process.env.SLOPSCROLL_OFFLINE_FEED_ORDER,
      localConfig.settings?.offlineFeedOrder ?? defaultConfig.settings.offlineFeedOrder
    )
  };

  const civitai = {
    validatePath: process.env.SLOPSCROLL_CIVITAI_VALIDATE_PATH ?? localConfig.civitai?.validatePath ?? defaultConfig.civitai.validatePath,
    requestTimeoutMs: toInt(process.env.SLOPSCROLL_REQUEST_TIMEOUT_MS, localConfig.civitai?.requestTimeoutMs ?? defaultConfig.civitai.requestTimeoutMs),
    downloadTimeoutMs: toInt(process.env.SLOPSCROLL_DOWNLOAD_TIMEOUT_MS, localConfig.civitai?.downloadTimeoutMs ?? defaultConfig.civitai.downloadTimeoutMs),
    maxDownloadRetries: toInt(process.env.SLOPSCROLL_DOWNLOAD_RETRIES, localConfig.civitai?.maxDownloadRetries ?? defaultConfig.civitai.maxDownloadRetries),
    prefetchConcurrency: Math.max(
      1,
      toInt(process.env.SLOPSCROLL_PREFETCH_CONCURRENCY, localConfig.civitai?.prefetchConcurrency ?? defaultConfig.civitai.prefetchConcurrency)
    )
  };

  return {
    host,
    port,
    mediaDir,
    dataDir,
    cacheVideosDir: path.join(dataDir, "cache", "videos"),
    cacheImagesDir: path.join(dataDir, "cache", "images"),
    dbPath: path.join(dataDir, "slopscroll.db"),
    sessionPath: path.join(dataDir, "session", "auth.json"),
    requestSpecPath: path.join(dataDir, "civitai-request-spec.json"),
    staticDir: defaultConfig.staticDir,
    settings,
    civitai
  };
}

export function loadRequestSpec(specPath: string): CivitaiRequestSpec | null {
  try {
    const raw = readJsonFile<CivitaiRequestSpec>(specPath);
    if (!raw?.endpoint || !raw.method) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}
