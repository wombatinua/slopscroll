import fs from "node:fs";
import path from "node:path";
import type { CivitaiRequestSpec, Settings } from "./types";

export interface AppConfig {
  host: string;
  port: number;
  mediaDir: string;
  dataDir: string;
  cacheVideosDir: string;
  cacheThumbsDir: string;
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
  };
}

const ROOT = process.cwd();
const DEFAULT_DATA_DIR = path.join(ROOT, "data");
const DEFAULT_MEDIA_DIR = path.join(ROOT, "media");

export const defaultConfig: AppConfig = {
  host: "0.0.0.0",
  port: 3579,
  mediaDir: DEFAULT_MEDIA_DIR,
  dataDir: DEFAULT_DATA_DIR,
  cacheVideosDir: path.join(DEFAULT_DATA_DIR, "cache", "videos"),
  cacheThumbsDir: path.join(DEFAULT_DATA_DIR, "cache", "thumbs"),
  dbPath: path.join(DEFAULT_DATA_DIR, "slopscroll.db"),
  sessionPath: path.join(DEFAULT_DATA_DIR, "session", "auth.json"),
  requestSpecPath: path.join(DEFAULT_DATA_DIR, "civitai-request-spec.json"),
  staticDir: path.join(ROOT, "public"),
  settings: {
    prefetchDepth: 3,
    lowDiskWarnGb: 2,
    audioEnabled: false,
    audioMinSwitchSec: 15,
    audioMaxSwitchSec: 45,
    audioCrossfadeSec: 2,
    audioSwitchOnFeedAdvance: false
  },
  civitai: {
    validatePath: "",
    requestTimeoutMs: 15000,
    downloadTimeoutMs: 60000,
    maxDownloadRetries: 3
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

export function loadConfig(): AppConfig {
  const localPath = path.join(ROOT, "config", "local.json");
  const localConfig = readJsonFile<PartialConfig>(localPath) ?? {};

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
    audioSwitchOnFeedAdvance:
      (process.env.SLOPSCROLL_AUDIO_SWITCH_ON_FEED_ADVANCE ??
        String(localConfig.settings?.audioSwitchOnFeedAdvance ?? defaultConfig.settings.audioSwitchOnFeedAdvance)).toLowerCase() === "true"
  };

  const civitai = {
    validatePath: process.env.SLOPSCROLL_CIVITAI_VALIDATE_PATH ?? localConfig.civitai?.validatePath ?? defaultConfig.civitai.validatePath,
    requestTimeoutMs: toInt(process.env.SLOPSCROLL_REQUEST_TIMEOUT_MS, localConfig.civitai?.requestTimeoutMs ?? defaultConfig.civitai.requestTimeoutMs),
    downloadTimeoutMs: toInt(process.env.SLOPSCROLL_DOWNLOAD_TIMEOUT_MS, localConfig.civitai?.downloadTimeoutMs ?? defaultConfig.civitai.downloadTimeoutMs),
    maxDownloadRetries: toInt(process.env.SLOPSCROLL_DOWNLOAD_RETRIES, localConfig.civitai?.maxDownloadRetries ?? defaultConfig.civitai.maxDownloadRetries)
  };

  return {
    host,
    port,
    mediaDir,
    dataDir,
    cacheVideosDir: path.join(dataDir, "cache", "videos"),
    cacheThumbsDir: path.join(dataDir, "cache", "thumbs"),
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
