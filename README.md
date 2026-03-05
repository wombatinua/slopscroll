# SlopScroll

Local single-user cache-first video scroller for Civitai.

Current version: `0.18.0`

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

2. Generate Civitai request spec from HAR (required for online mode):

```bash
npm run parse-har -- /absolute/path/to/session.har
```

If `.env` exists in project root, it is loaded automatically on server startup.

3. Start app:

```bash
npm run dev
```

4. Open `http://localhost:3579`.

5. Paste full browser `Cookie` header in UI.

## PWA Install

- Open app in a browser with PWA support (Chrome/Edge/Safari iOS).
- Wait until top bar shows the `Install app` button (download icon).
- Click it and confirm install prompt.
- Installed app opens in standalone mode and reuses cached shell assets (`index`, `styles`, `app.js`, icons, manifest) via service worker.

## Docker

Run with Docker Compose:

```bash
./scripts/docker-up.sh
```

Run with local git commit embedded in image metadata (recommended):

```bash
APP_COMMIT=$(git rev-parse --short=7 HEAD) docker compose up -d --build
```

Stop:

```bash
docker compose down
```

Use prebuilt GHCR image (`wombatinua/slopscroll`):

```bash
docker pull ghcr.io/wombatinua/slopscroll:latest
docker run --rm -p 3579:3579 \
  -e APP_HOST=0.0.0.0 \
  -e APP_PORT=3579 \
  -e APP_DATA_DIR=/app/data \
  -v "$(pwd)/data:/app/data" \
  ghcr.io/wombatinua/slopscroll:latest
```

Package page: `https://github.com/wombatinua/slopscroll/pkgs/container/slopscroll`

Container runtime details:
- Uses `node:latest`.
- Health check probes `GET /api/health`.
- Compose auto-loads variables from `.env` for `APP_HOST`, `APP_PORT`, `DATA_DIR`, `DATA_IMAGES_DIR`, and `DATA_VIDEOS_DIR`.
- Binds local mutable data into container:
  - `${DATA_DIR}` -> `/app/data` (includes `sounds`, `session`, DB, spec)
  - `${DATA_IMAGES_DIR}` -> `/app/data/images` (optional override)
  - `${DATA_VIDEOS_DIR}` -> `/app/data/videos` (optional override)
- Image also includes `data/sounds` as fallback when no host data mount is used.

### Docker FAQ

Q: Why is container health `starting` for a while?
A: Startup includes boot + healthcheck start period. Wait ~25-30s, then check `docker compose ps`.

Q: Why is container `unhealthy`?
A: Check logs (`docker compose logs -f slopscroll`). Most common causes are invalid runtime config or app startup failure.

Q: Where are cached videos/images/database stored?
A: On host under `./data/*` because compose uses bind mounts.

Q: How do I override compose ports or bind paths?
A: Edit `.env` (`APP_HOST`, `APP_PORT`, `DATA_DIR`, `DATA_IMAGES_DIR`, `DATA_VIDEOS_DIR`).

Q: Why are cookies/spec missing after restart?
A: Confirm `./data/session` and `./data/civitai-request-spec.json` exist on host and are mounted to `/app/data`.

Q: How do I pick up code/dependency changes?
A: Rebuild image: `./scripts/docker-up.sh`.

Q: Why does settings show `SlopScroll X.X.X (unknown)` in local Docker?
A: Docker images do not include your `.git` metadata. Build via `./scripts/docker-up.sh` (or pass `APP_COMMIT=...` manually).

Q: I changed audio files under `data/sounds` and container still has old loops.
A: With compose defaults, loops come from host `${DATA_DIR}/sounds`, so changes apply immediately (restart container if needed). Rebuild is only required when running without host data mount.

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
- `GET /api/app/info`
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
- Feed request/page tuning defaults:
  - `feedPageSize`: `8` (`1..20`)
  - `loadMoreThreshold`: `4` (`0..20`)
  - `keepBehindCount`: `10` (`0..30`)
  - `keepAheadCount`: `2` (`0..10`)
- Settings are saved immediately on UI control change (no Save Settings button).
- Disabled settings controls are dimmed and show contextual hints:
  - Cookie import + content-level filters are disabled in offline modes.
  - Audio timer min/max require loop playback + random switch timer.
  - Audio crossfade/pitch require loop playback.
  - Auto-advance interval requires auto-advance toggle enabled.
- Settings panel footer shows `SlopScroll X.X.X (commit)`.
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
