import fs from "node:fs";
import path from "node:path";
import { ensureParentDir } from "../src/utils/fs";
import type { CivitaiRequestSpec, HarAnalysisResult } from "../src/types";

interface HarHeader {
  name: string;
  value: string;
}

interface HarQuery {
  name: string;
  value: string;
}

interface HarContent {
  mimeType?: string;
  text?: string;
  encoding?: string;
}

interface HarEntry {
  request: {
    method: string;
    url: string;
    headers: HarHeader[];
    queryString?: HarQuery[];
  };
  response: {
    status: number;
    content?: HarContent;
  };
}

interface HarFile {
  log?: {
    entries?: HarEntry[];
  };
}

function usage(): never {
  console.error("Usage: npm run parse-har -- <path-to.har> [--out data/civitai-request-spec.json]");
  process.exit(1);
}

function toObject(entries: Array<{ name: string; value: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    out[entry.name] = entry.value;
  }
  return out;
}

function parseCookieNames(cookieHeader: string | undefined): string[] {
  if (!cookieHeader) {
    return [];
  }

  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((pair) => pair.split("=")[0]?.trim())
    .filter((value): value is string => Boolean(value));
}

function decodeBody(content: HarContent | undefined): string | null {
  if (!content?.text) {
    return null;
  }

  if (content.encoding === "base64") {
    return Buffer.from(content.text, "base64").toString("utf8");
  }

  return content.text;
}

function findArrayPaths(input: unknown, prefix = "", depth = 0, out: string[] = []): string[] {
  if (depth > 6 || input == null) {
    return out;
  }

  if (Array.isArray(input)) {
    if (input.length > 0 && typeof input[0] === "object") {
      out.push(prefix || "$");
    }
    return out;
  }

  if (typeof input !== "object") {
    return out;
  }

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const next = prefix ? `${prefix}.${key}` : key;
    findArrayPaths(value, next, depth + 1, out);
  }

  return out;
}

function scoreEntry(entry: HarEntry, body: unknown): number {
  let score = 0;
  const url = entry.request.url.toLowerCase();

  if (url.includes("/api/")) score += 2;
  if (url.includes("video")) score += 3;
  if (entry.response.status >= 200 && entry.response.status < 300) score += 1;

  const bodyString = JSON.stringify(body ?? "").toLowerCase();
  if (bodyString.includes("items")) score += 2;
  if (bodyString.includes("nextcursor") || bodyString.includes("cursor")) score += 2;
  if (bodyString.includes(".webm") || bodyString.includes(".mp4")) score += 2;

  return score;
}

function pickHeaders(headers: Record<string, string>): Record<string, string> {
  const allow = new Set([
    "accept",
    "accept-language",
    "content-type",
    "referer",
    "origin",
    "x-csrf-token",
    "x-requested-with",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform"
  ]);

  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!allow.has(lower)) {
      continue;
    }

    out[name] = value;
  }

  return out;
}

function detectCursorParam(query: Record<string, string>): string | undefined {
  const keys = Object.keys(query);
  return keys.find((k) => ["cursor", "nextCursor", "page"].includes(k));
}

function detectLimitParam(query: Record<string, string>): string | undefined {
  const keys = Object.keys(query);
  return keys.find((k) => ["limit", "perPage", "pageSize", "count"].includes(k));
}

function recommendedItemPath(body: unknown): string[] {
  const candidates = findArrayPaths(body).filter((entry) => entry !== "$");
  if (candidates.length === 0) {
    return ["result.data.json.items", "items", "data.items", "videos", "results"];
  }

  return candidates.slice(0, 5);
}

function findPathsByKey(input: unknown, targetKey: string, prefix = "", depth = 0, out: string[] = []): string[] {
  if (depth > 7 || input == null || typeof input !== "object") {
    return out;
  }

  if (Array.isArray(input)) {
    for (let i = 0; i < input.length; i += 1) {
      findPathsByKey(input[i], targetKey, prefix ? `${prefix}.${i}` : String(i), depth + 1, out);
    }
    return out;
  }

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (key === targetKey) {
      out.push(next);
    }
    findPathsByKey(value, targetKey, next, depth + 1, out);
  }

  return out;
}

function parseArgs(): { inputPath: string; outPath: string } {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    usage();
  }

  const inputPath = args[0];
  if (!inputPath) {
    usage();
  }

  let outPath = path.join(process.cwd(), "data", "civitai-request-spec.json");
  const outIdx = args.indexOf("--out");
  if (outIdx >= 0 && args[outIdx + 1]) {
    outPath = path.resolve(args[outIdx + 1]);
  }

  return {
    inputPath: path.resolve(inputPath),
    outPath
  };
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toCandidate(entry: HarEntry, body: unknown): HarAnalysisResult["candidates"][number] {
  const headerObject = toObject(entry.request.headers);
  const cookieHeader = headerObject.Cookie ?? headerObject.cookie;
  const queryObject = toObject(entry.request.queryString ?? []);
  if (typeof queryObject.input === "string") {
    try {
      const decoded = decodeURIComponent(queryObject.input);
      if (decoded) {
        queryObject.input = decoded;
      }
    } catch {
      // keep as-is
    }
  }

  return {
    url: entry.request.url,
    method: entry.request.method,
    score: scoreEntry(entry, body),
    status: entry.response.status,
    requiredHeaders: pickHeaders(headerObject),
    cookieNames: parseCookieNames(cookieHeader),
    query: queryObject
  };
}

function buildRecommendedSpec(best: HarAnalysisResult["candidates"][number], body: unknown): CivitaiRequestSpec {
  const url = new URL(best.url);
  const endpoint = `${url.protocol}//${url.host}${url.pathname}`;

  const nextCursorPaths = findPathsByKey(body, "nextCursor");
  const recommendedCursorPaths = Array.from(new Set([...nextCursorPaths, "result.data.json.nextCursor", "metadata.nextCursor", "nextCursor", "cursor.next", "pagination.nextCursor"]));

  return {
    endpoint,
    method: best.method === "POST" ? "POST" : "GET",
    query: best.query,
    headers: best.requiredHeaders,
    cursorParam: detectCursorParam(best.query),
    limitParam: detectLimitParam(best.query),
    itemPaths: recommendedItemPath(body),
    cursorPaths: recommendedCursorPaths,
    mediaUrlPaths: ["videoUrl", "mediaUrl", "url", "files.0.url", "assets.0.url"],
    pageUrlPaths: ["url", "pageUrl", "postUrl", "permalink"],
    authorPaths: ["author.username", "creator.username", "user.username", "author", "username"],
    durationPaths: ["duration", "meta.duration", "stats.duration"],
    createdAtPaths: ["createdAt", "publishedAt", "meta.createdAt"]
  };
}

function main(): void {
  const { inputPath, outPath } = parseArgs();

  if (!fs.existsSync(inputPath)) {
    console.error(`HAR file not found: ${inputPath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(inputPath, "utf8");
  const har = JSON.parse(raw) as HarFile;
  const entries = har.log?.entries ?? [];

  if (entries.length === 0) {
    console.error("No HAR entries found");
    process.exit(1);
  }

  const civitaiEntries = entries.filter((entry) => {
    try {
      const url = new URL(entry.request.url);
      const host = url.hostname.toLowerCase();
      const isMatch = host.includes("civitai.com") || host.includes("civit.ai");
      return isMatch && entry.response.status >= 200;
    } catch {
      return false;
    }
  });

  if (civitaiEntries.length === 0) {
    console.error("No matching civitai.com entries found");
    process.exit(1);
  }

  const analyzed = civitaiEntries
    .map((entry) => {
      const bodyText = decodeBody(entry.response.content);
      const body = bodyText ? safeParseJson(bodyText) : null;
      return {
        entry,
        body,
        candidate: toCandidate(entry, body)
      };
    })
    .filter((row) => row.candidate.status >= 200 && row.candidate.status < 500)
    .sort((a, b) => b.candidate.score - a.candidate.score);

  if (analyzed.length === 0) {
    console.error("Unable to score suitable entries");
    process.exit(1);
  }

  const top = analyzed[0];
  const result: HarAnalysisResult = {
    generatedAt: new Date().toISOString(),
    candidates: analyzed.slice(0, 10).map((row) => row.candidate),
    recommendedSpec: buildRecommendedSpec(top.candidate, top.body)
  };

  ensureParentDir(outPath);
  fs.writeFileSync(outPath, JSON.stringify(result.recommendedSpec, null, 2), "utf8");

  const reportPath = outPath.replace(/\.json$/i, ".analysis.json");
  fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), "utf8");

  console.log(`Wrote request spec: ${outPath}`);
  console.log(`Wrote analysis report: ${reportPath}`);
  console.log(`Top candidate: ${top.candidate.method} ${top.candidate.url} (score=${top.candidate.score})`);
}

main();
