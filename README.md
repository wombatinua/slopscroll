# SlopScroll

Local single-user cache-first video scroller for Civitai.

## Stack

- Node.js + TypeScript
- Fastify backend + static UI
- SQLite metadata index (`node:sqlite` built into Node)
- Vanilla JS frontend

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Optional config override:

```bash
cp config/local.example.json config/local.json
```

3. Generate Civitai request spec from HAR (required for online mode):

```bash
npm run parse-har -- /absolute/path/to/session.har
```

4. Start app:

```bash
npm run dev
```

5. Open `http://localhost:3579`.

6. Paste full browser `Cookie` header in UI.

## API

- `POST /api/auth/cookies`
- `GET /api/auth/status`
- `GET /api/feed/next?cursor=...&limit=...`
- `GET /api/feed/author-stats?author=...`
- `POST /api/prefetch`
- `GET /api/video/:id`
- `GET /api/settings`
- `PUT /api/settings`
- `GET /api/cache/stats`
- `POST /api/spec/reload`
- `GET /api/audio/library`
- `GET /api/audio/file/:name`

## Data Layout

- `data/cache/videos/*.webm` - cached media
- `data/cache/thumbs/` - reserved for future use
- `data/slopscroll.db` - SQLite index
- `data/session/auth.json` - imported cookies
- `data/civitai-request-spec.json` - feed request spec
- `media/*` - local audio loop library (`.mp3`, `.wav`, `.ogg`, `.m4a`, `.aac`, `.flac`, `.opus`, `.webm`)

## Notes

- Cache is indefinite by design; no auto-eviction.
- Low disk only triggers warnings; downloads are not auto-deleted.
- Background prefetch depth default: `3` (configurable `0..10`).
- Settings are saved immediately on UI control change (no Save Settings button).
- Author-feed header navigation:
  - Back arrow returns to the exact main-feed position where author feed was opened.
  - Clicking `SlopScroll` always reinitializes main feed.
- Feed loading overlay appears during feed initialization and active-video buffering/loading.
- Offline mode is persisted in settings:
  - When enabled, feed and author feed are served from ready local cache only (no Civitai requests).
  - Top bar shows `OFFLINE` badge and bottom-right controls switch to `Newest / Oldest / Random`.
  - Empty cache in offline mode shows a centered empty-state overlay.
  - Online-only actions (`/api/auth/cookies`, `/api/spec/reload`) return `409`.
  - `/api/prefetch` remains available and works in local-only mode (no network).
- Audio loop controls include:
  - Toggle: automatic random switching (uses min/max window).
  - Toggle: switch loop on video change.
  - Crossfade duration setting (seconds).
