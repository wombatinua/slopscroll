import fs from "node:fs";
import path from "node:path";
import type { CivitaiRequestSpec, FeedMode, FeedPeriod, FeedSort, OfflineFeedOrder, Settings } from "./types";

export interface AppConfig {
  host: string;
  port: number;
  soundsDir: string;
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

const ROOT = process.cwd();
const DEFAULT_DATA_DIR = path.join(ROOT, "data");
const DEFAULT_SOUNDS_DIR = path.join(DEFAULT_DATA_DIR, "sounds");
const ALLOWED_FEED_SORTS: FeedSort[] = ["Most Reactions", "Most Comments", "Most Collected", "Newest", "Oldest"];
const ALLOWED_FEED_PERIODS: FeedPeriod[] = ["Day", "Week", "Month", "Year", "AllTime"];
const ALLOWED_OFFLINE_FEED_ORDERS: OfflineFeedOrder[] = ["Newest", "Oldest", "Random"];
const ALLOWED_FEED_MODES: FeedMode[] = ["online", "offline_video", "offline_image"];

export const defaultConfig: AppConfig = {
  host: "0.0.0.0",
  port: 3579,
  soundsDir: DEFAULT_SOUNDS_DIR,
  dataDir: DEFAULT_DATA_DIR,
  cacheVideosDir: path.join(DEFAULT_DATA_DIR, "videos"),
  cacheImagesDir: path.join(DEFAULT_DATA_DIR, "images"),
  dbPath: path.join(DEFAULT_DATA_DIR, "database.db"),
  sessionPath: path.join(DEFAULT_DATA_DIR, "session", "auth.json"),
  requestSpecPath: path.join(DEFAULT_DATA_DIR, "civitai-request-spec.json"),
  staticDir: path.join(ROOT, "public"),
  settings: {
    prefetchDepth: 3,
    lowDiskWarnGb: 64,
    audioEnabled: false,
    audioAutoSwitchEnabled: true,
    audioSwitchOnVideoChangeEnabled: true,
    audioMinSwitchSec: 5,
    audioMaxSwitchSec: 30,
    audioCrossfadeSec: 1,
    audioPlaybackRate: 1,
    panicShortcutEnabled: true,
    browsingLevelR: false,
    browsingLevelX: false,
    browsingLevelXXX: false,
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
  const legacyEnvOfflineEnabledRaw = process.env.SLOPSCROLL_OFFLINE_MODE_ENABLED;
  const legacyEnvOfflineEnabled = legacyEnvOfflineEnabledRaw != null && legacyEnvOfflineEnabledRaw.toLowerCase() === "true";
  const inferredLegacyFeedMode = legacyEnvOfflineEnabled ? "offline_video" : "online";

  const host = process.env.APP_HOST ?? defaultConfig.host;
  const port = toInt(process.env.APP_PORT, defaultConfig.port);
  const dataDir = process.env.APP_DATA_DIR ?? defaultConfig.dataDir;
  const soundsDir = path.join(dataDir, "sounds");

  const settings: Settings = {
    prefetchDepth: toInt(process.env.SLOPSCROLL_PREFETCH_DEPTH, defaultConfig.settings.prefetchDepth),
    lowDiskWarnGb: toNum(process.env.SLOPSCROLL_LOW_DISK_WARN_GB, defaultConfig.settings.lowDiskWarnGb),
    audioEnabled: (process.env.SLOPSCROLL_AUDIO_ENABLED ?? String(defaultConfig.settings.audioEnabled)).toLowerCase() === "true",
    audioAutoSwitchEnabled:
      (process.env.SLOPSCROLL_AUDIO_AUTO_SWITCH_ENABLED ?? String(defaultConfig.settings.audioAutoSwitchEnabled)).toLowerCase() === "true",
    audioSwitchOnVideoChangeEnabled:
      (process.env.SLOPSCROLL_AUDIO_SWITCH_ON_VIDEO_CHANGE_ENABLED ?? String(defaultConfig.settings.audioSwitchOnVideoChangeEnabled)).toLowerCase() ===
      "true",
    audioMinSwitchSec: toInt(process.env.SLOPSCROLL_AUDIO_MIN_SWITCH_SEC, defaultConfig.settings.audioMinSwitchSec),
    audioMaxSwitchSec: toInt(process.env.SLOPSCROLL_AUDIO_MAX_SWITCH_SEC, defaultConfig.settings.audioMaxSwitchSec),
    audioCrossfadeSec: toNum(process.env.SLOPSCROLL_AUDIO_CROSSFADE_SEC, defaultConfig.settings.audioCrossfadeSec),
    audioPlaybackRate: toNum(process.env.SLOPSCROLL_AUDIO_PLAYBACK_RATE, defaultConfig.settings.audioPlaybackRate),
    panicShortcutEnabled:
      (process.env.SLOPSCROLL_PANIC_SHORTCUT_ENABLED ?? String(defaultConfig.settings.panicShortcutEnabled)).toLowerCase() === "true",
    browsingLevelR: (process.env.SLOPSCROLL_BROWSING_LEVEL_R ?? String(defaultConfig.settings.browsingLevelR)).toLowerCase() === "true",
    browsingLevelX: (process.env.SLOPSCROLL_BROWSING_LEVEL_X ?? String(defaultConfig.settings.browsingLevelX)).toLowerCase() === "true",
    browsingLevelXXX:
      (process.env.SLOPSCROLL_BROWSING_LEVEL_XXX ?? String(defaultConfig.settings.browsingLevelXXX)).toLowerCase() === "true",
    feedSort: toFeedSort(process.env.SLOPSCROLL_FEED_SORT, defaultConfig.settings.feedSort),
    feedPeriod: toFeedPeriod(process.env.SLOPSCROLL_FEED_PERIOD, defaultConfig.settings.feedPeriod),
    feedMode: toFeedMode(process.env.SLOPSCROLL_FEED_MODE, inferredLegacyFeedMode as FeedMode),
    offlineFeedOrder: toOfflineFeedOrder(process.env.SLOPSCROLL_OFFLINE_FEED_ORDER, defaultConfig.settings.offlineFeedOrder)
  };
  settings.audioPlaybackRate = Math.max(0.5, Math.min(2, settings.audioPlaybackRate));

  const civitai = {
    validatePath: process.env.SLOPSCROLL_CIVITAI_VALIDATE_PATH ?? defaultConfig.civitai.validatePath,
    requestTimeoutMs: toInt(process.env.SLOPSCROLL_REQUEST_TIMEOUT_MS, defaultConfig.civitai.requestTimeoutMs),
    downloadTimeoutMs: toInt(process.env.SLOPSCROLL_DOWNLOAD_TIMEOUT_MS, defaultConfig.civitai.downloadTimeoutMs),
    maxDownloadRetries: toInt(process.env.SLOPSCROLL_DOWNLOAD_RETRIES, defaultConfig.civitai.maxDownloadRetries),
    prefetchConcurrency: Math.max(
      1,
      toInt(process.env.SLOPSCROLL_PREFETCH_CONCURRENCY, defaultConfig.civitai.prefetchConcurrency)
    )
  };

  return {
    host,
    port,
    soundsDir,
    dataDir,
    cacheVideosDir: path.join(dataDir, "videos"),
    cacheImagesDir: path.join(dataDir, "images"),
    dbPath: path.join(dataDir, "database.db"),
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
