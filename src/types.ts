export interface VideoRecord {
  id: string;
  sourceUrl?: string;
  mediaUrl: string;
  pageUrl: string;
  kind?: "video";
  duration?: number;
  author?: string;
  createdAt?: string;
  raw?: string;
  liked?: boolean;
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

export type FeedSort = "Most Reactions" | "Most Comments" | "Most Collected" | "Newest" | "Oldest";
export type FeedPeriod = "Day" | "Week" | "Month" | "Year" | "AllTime";
export type OfflineFeedOrder = "Newest" | "Oldest" | "Random";
export type FeedMode = "online" | "offline_video" | "offline_image";

export interface ImageRecord {
  id: string;
  kind: "image";
  imageUrl: string;
  fileName: string;
  relativePath: string;
  modifiedAt: string;
}

export type FeedItem = VideoRecord | ImageRecord;

export interface Settings {
  prefetchDepth: number;
  lowDiskWarnGb: number;
  audioEnabled: boolean;
  audioAutoSwitchEnabled: boolean;
  audioSwitchOnVideoChangeEnabled: boolean;
  audioMinSwitchSec: number;
  audioMaxSwitchSec: number;
  audioCrossfadeSec: number;
  audioPlaybackRate: number;
  panicShortcutEnabled: boolean;
  browsingLevelR: boolean;
  browsingLevelX: boolean;
  browsingLevelXXX: boolean;
  feedSort: FeedSort;
  feedPeriod: FeedPeriod;
  feedMode: FeedMode;
  offlineFeedOrder: OfflineFeedOrder;
}

export interface FeedPage {
  items: FeedItem[];
  nextCursor: string | null;
  page: number;
  totalCount?: number;
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
