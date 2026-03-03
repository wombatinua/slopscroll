import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../utils/fs";

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".opus", ".webm"]);

export interface AudioLibraryItem {
  name: string;
  url: string;
  size: number;
  updatedAt: string;
}

export interface AudioFile {
  name: string;
  path: string;
  size: number;
  mimeType: string;
}

export class AudioLibraryService {
  constructor(private readonly mediaDir: string) {
    ensureDir(this.mediaDir);
  }

  async listLibrary(): Promise<AudioLibraryItem[]> {
    const entries = await fs.promises.readdir(this.mediaDir, { withFileTypes: true });
    const audioEntries = entries
      .filter((entry) => entry.isFile() && this.isSupportedAudio(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    const out: AudioLibraryItem[] = [];
    for (const name of audioEntries) {
      const fullPath = path.join(this.mediaDir, name);
      const stat = await fs.promises.stat(fullPath);
      out.push({
        name,
        url: `/api/audio/file/${encodeURIComponent(name)}`,
        size: stat.size,
        updatedAt: stat.mtime.toISOString()
      });
    }

    return out;
  }

  async resolveAudioFile(rawName: string): Promise<AudioFile | null> {
    const name = this.normalizeFileName(rawName);
    if (!name || !this.isSupportedAudio(name)) {
      return null;
    }

    const fullPath = path.join(this.mediaDir, name);
    if (!this.isInsideMediaDir(fullPath)) {
      return null;
    }

    try {
      const stat = await fs.promises.stat(fullPath);
      if (!stat.isFile()) {
        return null;
      }

      return {
        name,
        path: fullPath,
        size: stat.size,
        mimeType: this.mimeTypeFor(name)
      };
    } catch {
      return null;
    }
  }

  private normalizeFileName(rawName: string): string {
    let decoded = rawName;
    try {
      decoded = decodeURIComponent(rawName);
    } catch {
      decoded = rawName;
    }
    decoded = decoded.trim();
    if (!decoded) {
      return "";
    }
    if (decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
      return "";
    }
    return decoded;
  }

  private isSupportedAudio(name: string): boolean {
    const ext = path.extname(name).toLowerCase();
    return AUDIO_EXTENSIONS.has(ext);
  }

  private isInsideMediaDir(targetPath: string): boolean {
    const resolvedRoot = path.resolve(this.mediaDir);
    const resolvedTarget = path.resolve(targetPath);
    return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
  }

  private mimeTypeFor(name: string): string {
    const ext = path.extname(name).toLowerCase();
    switch (ext) {
      case ".mp3":
        return "audio/mpeg";
      case ".wav":
        return "audio/wav";
      case ".ogg":
        return "audio/ogg";
      case ".m4a":
        return "audio/mp4";
      case ".aac":
        return "audio/aac";
      case ".flac":
        return "audio/flac";
      case ".opus":
        return "audio/opus";
      case ".webm":
        return "audio/webm";
      default:
        return "application/octet-stream";
    }
  }
}
