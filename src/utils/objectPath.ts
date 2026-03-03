export function getByPath(input: unknown, pathExpr: string): unknown {
  if (!pathExpr) {
    return undefined;
  }

  const parts = pathExpr.split(".").filter(Boolean);
  let cursor: unknown = input;

  for (const part of parts) {
    if (cursor == null) {
      return undefined;
    }

    if (Array.isArray(cursor)) {
      const idx = Number.parseInt(part, 10);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) {
        return undefined;
      }
      cursor = cursor[idx];
      continue;
    }

    if (typeof cursor !== "object") {
      return undefined;
    }

    const next = (cursor as Record<string, unknown>)[part];
    cursor = next;
  }

  return cursor;
}

export function firstStringByPaths(input: unknown, paths: string[]): string | undefined {
  for (const p of paths) {
    const value = getByPath(input, p);
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

export function firstNumberByPaths(input: unknown, paths: string[]): number | undefined {
  for (const p of paths) {
    const value = getByPath(input, p);
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}
