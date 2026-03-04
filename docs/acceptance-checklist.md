# SlopScroll v1 Acceptance Checklist

## Core

- [ ] `npm run dev` starts app and serves UI.
- [ ] Single server hosts both UI and API.
- [ ] Manual cookie import persists to `data/session/auth.json`.

## Auth

- [ ] `GET /api/auth/status` reports invalid without cookies.
- [ ] Valid cookie import enables feed loading.
- [ ] Expired cookies trigger invalid state and re-import prompt.

## Feed + Cache

- [ ] `GET /api/feed/next` returns normalized items.
- [ ] `GET /api/feed/author-stats` returns totals for selected author.
- [ ] `GET /api/video/:id` downloads on first hit and serves from disk.
- [ ] Subsequent playback is cache-hit (no re-download).
- [ ] No automatic cache deletion.

## Prefetch

- [ ] Default prefetch depth is 3.
- [ ] Settings allow `0..10` prefetch depth.
- [ ] Next-N items are queued in background.
- [ ] Duplicate prefetch/download requests are deduplicated.

## UI

- [ ] Vertical snap-scroller works on desktop + mobile widths.
- [ ] Active video autoplays and loops.
- [ ] Scroll/keyboard navigation advances feed.
- [ ] Feed initialization loader appears quickly (no blank/stuck-looking screen).
- [ ] Active-video buffering/loading shows loader (no lingering black bar with no feedback).
- [ ] Loading/error states are visible.
- [ ] Settings apply instantly when controls change (no Save Settings button).
- [ ] Settings panel footer shows `SlopScroll X.X.X (commit)`.
- [ ] In author feed, back arrow returns to exact previous position in main feed.
- [ ] Clicking `SlopScroll` reinitializes main feed from start.
- [ ] Mode badge appears in header (`OFFLINE VIDEO` or `OFFLINE IMAGE`) when not in online mode.
- [ ] Both offline modes replace sort/period controls with `Newest / Oldest / Random`.
- [ ] Offline mode with zero eligible items shows centered empty-state overlay.
- [ ] Panic mode (`Spacebar`, if enabled) opens Google-like overlay and changes tab title to `New Tab`.
- [ ] Panic overlay search submit redirects in same tab and supports both search text and direct URL input.

## Audio Behavior

- [ ] With audio enabled + random switch enabled, loop switches by configured min/max random window.
- [ ] With audio enabled + switch-on-video-change enabled, loop switches when active video changes.
- [ ] With audio enabled + both switch toggles disabled, current loop continues indefinitely.
- [ ] Audio switch toggles and numeric settings become effective immediately after UI change.
- [ ] Pitch shift setting applies immediately and persists across reloads.

## Feed Modes

- [ ] Feed mode setting persists and applies immediately (`online`, `offline_video`, `offline_image`).
- [ ] While either offline mode is enabled, no outbound requests to `civitai.com` / `civit.ai` occur during browsing/playback.
- [ ] `offline_video`: author feed and author totals are computed from local ready cache only.
- [ ] `offline_video`: `GET /api/video/:id` streams ready cached files and returns `409` for uncached/missing files.
- [ ] `offline_image`: feed is served from recursive files under `data/images`.
- [ ] `offline_image`: feed renders images (not videos) with filename + counter.
- [ ] `offline_image`: author navigation and likes UI are hidden/disabled.
- [ ] `offline_image`: `/api/feed/author-stats`, likes routes, and `/api/video/:id` return `409`.
- [ ] `POST /api/auth/cookies` and `POST /api/spec/reload` return `409` in both offline modes.
- [ ] `POST /api/prefetch` remains available in both offline modes and performs local-only prefetch behavior.
- [ ] `GET /api/auth/status` returns synthetic valid status in both offline modes.

## Ops

- [ ] `GET /api/cache/stats` returns bytes/hit-rate counts.
- [ ] Low-disk warning state exposed in stats.
- [ ] Logs show feed/cache/auth/download events.

## Docker

- [ ] `docker compose up -d --build` succeeds.
- [ ] Service transitions to `healthy` via healthcheck.
- [ ] Host `${DATA_DIR}` bind mount is used for persistence (images/videos/sounds/session + DB/spec).
- [ ] Optional `${DATA_IMAGES_DIR}` / `${DATA_VIDEOS_DIR}` overrides work when set.
