import crypto from "node:crypto";

export function sha1(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex");
}
