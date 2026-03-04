import fs from "node:fs";
import path from "node:path";
import { sha1 } from "../utils/hash";
import type { OfflineFeedOrder, ImageRecord } from "../types";

interface ImageCatalogEntry {
  id: string;
  absolutePath: string;
  relativePath: string;
  fileName: string;
  modifiedAtMs: number;
  fileSize: number;
}

const SUPPORTED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"]);

export class ImageCatalogService {
  private loaded = false;
  private entries: ImageCatalogEntry[] = [];
  private readonly byId = new Map<string, ImageCatalogEntry>();
  private readonly randomOrderByKey = new Map<string, string[]>();

  constructor(private readonly imagesRoot: string) {}

  reset(): void {
    this.loaded = false;
    this.entries = [];
    this.byId.clear();
    this.randomOrderByKey.clear();
  }

  async listFeedPage(options: {
    cursor: string | null;
    limit: number;
    order: OfflineFeedOrder;
    randomKey: string;
  }): Promise<{ items: ImageRecord[]; nextCursor: string | null; totalCount: number; page: number }> {
    await this.ensureLoaded();
    if (options.order === "Random" && options.cursor == null) {
      this.randomOrderByKey.delete(options.randomKey);
    }

    const safeLimit = Math.max(1, Math.min(20, Math.trunc(options.limit)));
    const offset = this.parseOffset(options.cursor);
    const ids = this.getOrderedIds(options.order, options.randomKey);
    const totalCount = ids.length;

    if (offset >= totalCount) {
      return {
        items: [],
        nextCursor: null,
        totalCount,
        page: this.parsePage(offset, safeLimit)
      };
    }

    const slice = ids.slice(offset, offset + safeLimit);
    const items = slice
      .map((id) => this.byId.get(id))
      .filter((entry): entry is ImageCatalogEntry => Boolean(entry))
      .map((entry) => this.toImageRecord(entry));
    const nextOffset = offset + slice.length;

    return {
      items,
      nextCursor: nextOffset < totalCount ? String(nextOffset) : null,
      totalCount,
      page: this.parsePage(offset, safeLimit)
    };
  }

  async resolveImagePathById(idRaw: string): Promise<{ path: string; mimeType: string } | null> {
    await this.ensureLoaded();
    const id = idRaw.trim();
    if (!id) {
      return null;
    }
    const entry = this.byId.get(id);
    if (!entry) {
      return null;
    }
    try {
      const stat = await fs.promises.stat(entry.absolutePath);
      if (!stat.isFile() || stat.size <= 0) {
        return null;
      }
    } catch {
      return null;
    }

    return {
      path: entry.absolutePath,
      mimeType: this.detectImageMime(entry.absolutePath)
    };
  }

  async warmImageIds(ids: string[]): Promise<{ queued: string[]; skipped: string[] }> {
    await this.ensureLoaded();
    const queued: string[] = [];
    const skipped: string[] = [];

    for (const rawId of ids) {
      const id = rawId.trim();
      if (!id) {
        skipped.push(rawId);
        continue;
      }
      const entry = this.byId.get(id);
      if (!entry) {
        skipped.push(id);
        continue;
      }
      try {
        await fs.promises.access(entry.absolutePath, fs.constants.R_OK);
        queued.push(id);
      } catch {
        skipped.push(id);
      }
    }

    return { queued, skipped };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    await this.rebuildCatalog();
    this.loaded = true;
  }

  private async rebuildCatalog(): Promise<void> {
    this.entries = [];
    this.byId.clear();
    this.randomOrderByKey.clear();

    await this.collectEntries(this.imagesRoot);
  }

  private async collectEntries(dirPath: string): Promise<void> {
    let children: fs.Dirent[];
    try {
      children = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const child of children) {
      if (child.name.startsWith(".")) {
        continue;
      }
      const absolute = path.join(dirPath, child.name);
      if (child.isDirectory()) {
        await this.collectEntries(absolute);
        continue;
      }
      if (!child.isFile()) {
        continue;
      }

      const extension = path.extname(child.name).toLowerCase();
      if (!SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(absolute);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size <= 0) {
        continue;
      }

      const relativePath = this.toRelativePath(absolute);
      const id = sha1(`${relativePath}|${stat.size}|${stat.mtimeMs}`);
      const entry: ImageCatalogEntry = {
        id,
        absolutePath: absolute,
        relativePath,
        fileName: path.basename(absolute),
        modifiedAtMs: stat.mtimeMs,
        fileSize: stat.size
      };
      this.entries.push(entry);
      this.byId.set(id, entry);
    }
  }

  private getOrderedIds(order: OfflineFeedOrder, randomKey: string): string[] {
    if (order === "Random") {
      let ids = this.randomOrderByKey.get(randomKey);
      if (!ids) {
        ids = this.entries.map((entry) => entry.id);
        this.shuffleInPlace(ids);
        this.randomOrderByKey.set(randomKey, ids);
      }
      return ids;
    }

    const sorted = this.entries
      .slice()
      .sort((left, right) => {
        if (left.modifiedAtMs !== right.modifiedAtMs) {
          return order === "Oldest" ? left.modifiedAtMs - right.modifiedAtMs : right.modifiedAtMs - left.modifiedAtMs;
        }
        return left.relativePath.localeCompare(right.relativePath);
      })
      .map((entry) => entry.id);
    return sorted;
  }

  private toImageRecord(entry: ImageCatalogEntry): ImageRecord {
    return {
      id: entry.id,
      kind: "image",
      imageUrl: `/api/image/${encodeURIComponent(entry.id)}`,
      fileName: entry.fileName,
      relativePath: entry.relativePath,
      modifiedAt: new Date(entry.modifiedAtMs).toISOString()
    };
  }

  private parseOffset(cursor: string | null): number {
    if (!cursor) {
      return 0;
    }
    const parsed = Number.parseInt(cursor, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return 0;
    }
    return parsed;
  }

  private parsePage(offset: number, limit: number): number {
    const safeLimit = Math.max(1, Math.trunc(limit));
    return Math.floor(Math.max(0, offset) / safeLimit) + 1;
  }

  private toRelativePath(absolutePath: string): string {
    const relative = path.relative(this.imagesRoot, absolutePath);
    return relative.split(path.sep).join("/");
  }

  private detectImageMime(filePath: string): string {
    const extension = path.extname(filePath).toLowerCase();
    switch (extension) {
      case ".jpg":
      case ".jpeg":
        return "image/jpeg";
      case ".png":
        return "image/png";
      case ".webp":
        return "image/webp";
      case ".gif":
        return "image/gif";
      case ".avif":
        return "image/avif";
      case ".bmp":
        return "image/bmp";
      default:
        return "application/octet-stream";
    }
  }

  private shuffleInPlace(values: string[]): void {
    for (let idx = values.length - 1; idx > 0; idx -= 1) {
      const swapIdx = Math.floor(Math.random() * (idx + 1));
      const tmp = values[idx];
      values[idx] = values[swapIdx];
      values[swapIdx] = tmp;
    }
  }
}
