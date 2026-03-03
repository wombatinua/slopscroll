export interface VideoRecord {
  id: string;
  sourceUrl: string;
  mediaUrl: string;
  pageUrl: string;
  duration?: number;
  author?: string;
  createdAt?: string;
  raw?: string;
}

export type CacheStatus = "ready" | "downloading" | "failed";

export interface CacheEntry {
  videoId: string;
  localPath: string;
  status: CacheStatus;
  fileSize: number;
  failureReason?: string;
}

export interface FeedCursor {
  rawCursor: string | null;
  page: number;
  fetchedAt: string;
}

export interface AuthState {
  isValid: boolean;
  checkedAt: string;
  failureReason?: string;
}

export interface Settings {
  prefetchDepth: number;
  lowDiskWarnGb: number;
  audioEnabled: boolean;
  audioMinSwitchSec: number;
  audioMaxSwitchSec: number;
  audioCrossfadeSec: number;
  audioSwitchOnFeedAdvance: boolean;
}

export interface FeedPage {
  items: VideoRecord[];
  nextCursor: string | null;
  page: number;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  body?: unknown;
  error?: string;
}

export interface CivitaiRequestSpec {
  endpoint: string;
  method: "GET" | "POST";
  query?: Record<string, string>;
  headers?: Record<string, string>;
  cursorParam?: string;
  limitParam?: string;
  itemPaths?: string[];
  cursorPaths?: string[];
  mediaUrlPaths?: string[];
  pageUrlPaths?: string[];
  authorPaths?: string[];
  durationPaths?: string[];
  createdAtPaths?: string[];
}

export interface HarAnalysisResult {
  generatedAt: string;
  candidates: Array<{
    url: string;
    method: string;
    score: number;
    status: number;
    requiredHeaders: Record<string, string>;
    cookieNames: string[];
    query: Record<string, string>;
  }>;
  recommendedSpec: Partial<CivitaiRequestSpec>;
}
