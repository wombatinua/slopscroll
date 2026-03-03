import fs from "node:fs";
import path from "node:path";

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function ensureParentDir(filePath: string): void {
  ensureDir(path.dirname(filePath));
}

export async function getDiskFreeBytes(targetDir: string): Promise<number | null> {
  try {
    const stats = await fs.promises.statfs(targetDir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}
