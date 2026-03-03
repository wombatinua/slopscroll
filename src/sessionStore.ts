import fs from "node:fs";
import { ensureParentDir } from "./utils/fs";

export interface SessionPayload {
  cookies: string;
  updatedAt: string;
}

export class SessionStore {
  private payload: SessionPayload | null = null;

  constructor(private readonly filePath: string) {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as SessionPayload;
      if (parsed.cookies) {
        this.payload = parsed;
      }
    } catch {
      this.payload = null;
    }
  }

  getCookies(): string | null {
    return this.payload?.cookies ?? null;
  }

  getUpdatedAt(): string | null {
    return this.payload?.updatedAt ?? null;
  }

  setCookies(cookies: string): SessionPayload {
    const payload: SessionPayload = {
      cookies,
      updatedAt: new Date().toISOString()
    };

    ensureParentDir(this.filePath);
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2), "utf8");
    this.payload = payload;
    return payload;
  }

  clear(): void {
    this.payload = null;
    if (fs.existsSync(this.filePath)) {
      fs.unlinkSync(this.filePath);
    }
  }
}
