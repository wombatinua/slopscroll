type Level = "info" | "warn" | "error";

function format(level: Level, event: string, payload?: unknown): string {
  const ts = new Date().toISOString();
  if (payload === undefined) {
    return `[${ts}] ${level.toUpperCase()} ${event}`;
  }
  return `[${ts}] ${level.toUpperCase()} ${event} ${JSON.stringify(payload)}`;
}

export const logger = {
  info(event: string, payload?: unknown): void {
    console.log(format("info", event, payload));
  },
  warn(event: string, payload?: unknown): void {
    console.warn(format("warn", event, payload));
  },
  error(event: string, payload?: unknown): void {
    console.error(format("error", event, payload));
  }
};
