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
- [ ] Loading/error states are visible.

## Ops

- [ ] `GET /api/cache/stats` returns bytes/hit-rate counts.
- [ ] Low-disk warning state exposed in stats.
- [ ] Logs show feed/cache/auth/download events.
