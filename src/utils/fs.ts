import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function ensureParentDir(filePath: string): void {
  ensureDir(path.dirname(filePath));
}

export async function getDiskFreeBytes(targetDir: string): Promise<number | null> {
  const fromDf = await getDiskFreeBytesFromDf(targetDir);
  if (fromDf != null) {
    return fromDf;
  }

  try {
    const stats = await fs.promises.statfs(targetDir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

async function getDiskFreeBytesFromDf(targetDir: string): Promise<number | null> {
  try {
    // Use POSIX-like 1K block output; this is more reliable than statfs on Docker Desktop bind mounts.
    const { stdout } = await execFileAsync("df", ["-k", targetDir], { encoding: "utf8" });
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length < 2) {
      return null;
    }

    const dataLine = lines[lines.length - 1];
    const columns = dataLine.split(/\s+/);
    if (columns.length < 4) {
      return null;
    }

    const availableBlocks = Number.parseInt(columns[3] ?? "", 10);
    if (!Number.isFinite(availableBlocks) || availableBlocks < 0) {
      return null;
    }

    return availableBlocks * 1024;
  } catch {
    return null;
  }
}
