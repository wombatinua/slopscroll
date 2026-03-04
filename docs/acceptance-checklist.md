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
- [ ] In author feed, back arrow returns to exact previous position in main feed.
- [ ] Clicking `SlopScroll` reinitializes main feed from start.
- [ ] Offline badge appears in header when Offline mode is enabled.
- [ ] Offline mode replaces sort/period controls with `Newest / Oldest / Random`.
- [ ] Offline mode with zero cache shows centered empty-state overlay.

## Audio Behavior

- [ ] With audio enabled + random switch enabled, loop switches by configured min/max random window.
- [ ] With audio enabled + switch-on-video-change enabled, loop switches when active video changes.
- [ ] With audio enabled + both switch toggles disabled, current loop continues indefinitely.
- [ ] Audio switch toggles and numeric settings become effective immediately after UI change.

## Offline Mode

- [ ] Enabling Offline mode immediately reinitializes feed and serves cached-ready items only.
- [ ] While Offline mode is enabled, no outbound requests to `civitai.com` / `civit.ai` occur during browsing/playback.
- [ ] Offline author feed and author totals are computed from local ready cache only.
- [ ] `POST /api/auth/cookies` and `POST /api/spec/reload` return `409` with offline reason.
- [ ] `POST /api/prefetch` remains available in Offline mode and performs local-only prefetch behavior.
- [ ] `GET /api/auth/status` returns synthetic valid offline status.
- [ ] `GET /api/video/:id` in offline mode streams ready cached files and returns `409` for uncached/missing files.

## Ops

- [ ] `GET /api/cache/stats` returns bytes/hit-rate counts.
- [ ] Low-disk warning state exposed in stats.
- [ ] Logs show feed/cache/auth/download events.
