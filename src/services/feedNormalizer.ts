import { firstNumberByPaths, firstStringByPaths, getByPath } from "../utils/objectPath";
import { sha1 } from "../utils/hash";
import type { CivitaiRequestSpec, VideoRecord } from "../types";

const DEFAULT_ITEM_PATHS = ["items", "data.items", "result.data.json.items", "data", "results", "videos"];
const DEFAULT_CURSOR_PATHS = [
  "result.data.json.nextCursor",
  "metadata.nextCursor",
  "nextCursor",
  "cursor.next",
  "pagination.nextCursor"
];
const DEFAULT_MEDIA_URL_PATHS = [
  "videoUrl",
  "mediaUrl",
  "files.0.url",
  "assets.0.url",
  "meta.videoUrl",
  "meta.url",
  "url"
];
const DEFAULT_PAGE_URL_PATHS = ["pageUrl", "postUrl", "permalink", "url"];
const DEFAULT_AUTHOR_PATHS = ["author.username", "creator.username", "user.username", "author", "username"];
const DEFAULT_DURATION_PATHS = ["duration", "meta.duration", "stats.duration"];
const DEFAULT_CREATED_AT_PATHS = ["createdAt", "publishedAt", "meta.createdAt"];

function mergePaths(primary: string[] | undefined, fallback: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => {
    const key = value.trim();
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(key);
  };

  for (const value of primary ?? []) {
    add(value);
  }
  for (const value of fallback) {
    add(value);
  }

  return out;
}

function toAbsoluteUrl(maybeUrl: string, originHint: string | undefined): string {
  if (/^https?:\/\//i.test(maybeUrl)) {
    return maybeUrl;
  }
  if (originHint && /^https?:\/\//i.test(originHint)) {
    const base = new URL(originHint);
    return new URL(maybeUrl, `${base.protocol}//${base.host}`).toString();
  }
  return maybeUrl;
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

function isLikelyVideoRow(row: Record<string, unknown>): boolean {
  if (String(row.type ?? "").toLowerCase() === "video") {
    return true;
  }

  const mimeType = String(row.mimeType ?? "").toLowerCase();
  if (mimeType.startsWith("video/")) {
    return true;
  }

  const metadata = row.metadata;
  if (metadata && typeof metadata === "object" && typeof (metadata as Record<string, unknown>).duration === "number") {
    return true;
  }

  return false;
}

function deriveMediaUrl(rawValue: string, row: Record<string, unknown>, originHint: string | undefined): string {
  const value = rawValue.trim();

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  if (value.startsWith("/")) {
    return toAbsoluteUrl(value, originHint);
  }

  if (looksLikeUuid(value) && isLikelyVideoRow(row)) {
    return `https://image-b2.civitai.com/file/civitai-media-cache/${value}/original`;
  }

  return toAbsoluteUrl(value, originHint);
}

function derivePageUrl(row: Record<string, unknown>, pageRaw: string | undefined, originHint: string | undefined): string {
  if (pageRaw && /^https?:\/\//i.test(pageRaw)) {
    return pageRaw;
  }

  const id = row.id;
  if ((typeof id === "string" && id.trim()) || typeof id === "number") {
    return `https://civitai.com/images/${id}`;
  }

  if (pageRaw) {
    return toAbsoluteUrl(pageRaw, originHint);
  }

  return originHint ?? "https://civitai.com/videos";
}

function getId(raw: Record<string, unknown>, mediaUrl: string, pageUrl: string): string {
  const rawId = raw.id;
  if (typeof rawId === "string" && rawId.trim()) {
    return rawId;
  }
  if (typeof rawId === "number") {
    return String(rawId);
  }

  const stable = `${mediaUrl}::${pageUrl}`;
  return sha1(stable);
}

function pickItems(body: unknown, itemPaths: string[]): unknown[] {
  if (Array.isArray(body)) {
    return body;
  }

  for (const path of itemPaths) {
    const value = getByPath(body, path);
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

export function normalizeFeedResponse(body: unknown, spec: CivitaiRequestSpec): { items: VideoRecord[]; nextCursor: string | null } {
  const itemPaths = mergePaths(spec.itemPaths, DEFAULT_ITEM_PATHS);
  const mediaPaths = mergePaths(spec.mediaUrlPaths, DEFAULT_MEDIA_URL_PATHS);
  const pagePaths = mergePaths(spec.pageUrlPaths, DEFAULT_PAGE_URL_PATHS);
  const authorPaths = mergePaths(spec.authorPaths, DEFAULT_AUTHOR_PATHS);
  const durationPaths = mergePaths(spec.durationPaths, DEFAULT_DURATION_PATHS);
  const createdAtPaths = mergePaths(spec.createdAtPaths, DEFAULT_CREATED_AT_PATHS);
  const cursorPaths = mergePaths(spec.cursorPaths, DEFAULT_CURSOR_PATHS);

  const rawItems = pickItems(body, itemPaths);
  const normalized: VideoRecord[] = [];

  for (const item of rawItems) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const row = item as Record<string, unknown>;
    const mediaRaw = firstStringByPaths(row, mediaPaths);
    if (!mediaRaw) {
      continue;
    }

    const pageRaw = firstStringByPaths(row, pagePaths);
    const mediaUrl = deriveMediaUrl(mediaRaw, row, spec.endpoint);
    const pageUrl = derivePageUrl(row, pageRaw, spec.endpoint);
    const id = getId(row, mediaUrl, pageUrl);

    normalized.push({
      id,
      sourceUrl: spec.endpoint,
      mediaUrl,
      pageUrl,
      author: firstStringByPaths(row, authorPaths),
      duration: firstNumberByPaths(row, durationPaths),
      createdAt: firstStringByPaths(row, createdAtPaths),
      raw: JSON.stringify(row)
    });
  }

  let nextCursor: string | null = null;
  for (const cPath of cursorPaths) {
    const value = getByPath(body, cPath);
    if (typeof value === "string" && value.trim()) {
      nextCursor = value;
      break;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      nextCursor = String(value);
      break;
    }
  }

  return {
    items: normalized,
    nextCursor
  };
}
