# SlopScroll

Local single-user cache-first video scroller for Civitai.

Current version: `0.17.0`

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

## Docker

Run with Docker Compose:

```bash
docker compose up -d --build
```

Stop:

```bash
docker compose down
```

Container runtime details:
- Uses `node:latest`.
- Health check probes `GET /api/health`.
- Binds local data folders into container:
  - `./data/images` -> `/app/data/images`
  - `./data/videos` -> `/app/data/videos`
  - `./data/sounds` -> `/app/data/sounds`
  - `./data/session` -> `/app/data/session`

### Docker FAQ

Q: Why is container health `starting` for a while?
A: Startup includes boot + healthcheck start period. Wait ~25-30s, then check `docker compose ps`.

Q: Why is container `unhealthy`?
A: Check logs (`docker compose logs -f slopscroll`). Most common causes are invalid runtime config or app startup failure.

Q: Where are cached videos/images/database stored?
A: On host under `./data/*` because compose uses bind mounts.

Q: Why are cookies/spec missing after restart?
A: Confirm `./data/session` and `./data/civitai-request-spec.json` exist on host and are mounted to `/app/data`.

Q: How do I pick up code/dependency changes?
A: Rebuild image: `docker compose up -d --build`.

## API

- `POST /api/auth/cookies`
- `GET /api/auth/status`
- `GET /api/feed/next?cursor=...&limit=...`
- `GET /api/feed/author-stats?author=...`
- `POST /api/prefetch`
- `GET /api/video/:id`
- `GET /api/image/:id`
- `GET /api/settings`
- `PUT /api/settings`
- `GET /api/cache/stats`
- `POST /api/spec/reload`
- `GET /api/audio/library`
- `GET /api/audio/file/:name`

## Data Layout

- `data/videos/*.webm` - cached media
- `data/images/**/*` - offline image-mode source files (recursive)
- `data/database.db` - SQLite index
- `data/session/auth.json` - imported cookies
- `data/civitai-request-spec.json` - feed request spec
- `data/sounds/*` - local audio loop library (`.mp3`, `.wav`, `.ogg`, `.m4a`, `.aac`, `.flac`, `.opus`, `.webm`)

## Notes

- Cache is indefinite by design; no auto-eviction.
- Low disk only triggers warnings; downloads are not auto-deleted.
- Background prefetch depth default: `3` (configurable `0..10`).
- Settings are saved immediately on UI control change (no Save Settings button).
- Author-feed header navigation:
  - Back arrow returns to the exact main-feed position where author feed was opened.
  - Clicking `SlopScroll` always reinitializes main feed.
- Feed loading overlay appears during feed initialization and active-video buffering/loading.
- Feed mode is persisted in settings (`online | offline_video | offline_image`):
  - `online`: normal Civitai-backed video feed.
  - `offline_video`: main/author feeds from ready local cached videos only (no Civitai requests).
  - `offline_image`: feed from local files under `data/images` only.
  - Top bar badge shows `OFFLINE VIDEO` or `OFFLINE IMAGE` when not in online mode.
  - Bottom-right controls switch to offline order (`Newest / Oldest / Random`) in both offline modes.
  - Empty offline feeds show a centered non-blocking empty-state overlay.
  - Online-only actions (`/api/auth/cookies`, `/api/spec/reload`) return `409` in both offline modes.
  - In `offline_image`, likes and author feed are disabled (UI hidden + API `409`).
  - `/api/prefetch` remains available in both offline modes and runs local-only behavior.
- Audio loop controls include:
  - Toggle: automatic random switching (uses min/max window).
  - Toggle: switch loop on feed item change.
  - Crossfade duration setting (seconds).
  - Pitch shift control (semitone steps) applied via playback speed.
- Panic mode:
  - Optional `Spacebar` panic trigger in settings.
  - Panic overlay presents a Google-like new-tab search surface.
  - Tab title switches to `New Tab` while panic overlay is active.
  - Enter/search redirects in the same tab; input supports both search text and direct URLs.
