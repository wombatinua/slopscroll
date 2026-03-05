# Changelog

## 0.18.0 - 2026-03-05

- Added automatic `.env` loading on server startup (`dotenv/config`).
- Added feed window tuning settings (UI + API + DB + config):
  - `feedPageSize` (`1..20`)
  - `loadMoreThreshold` (`0..20`)
  - `keepBehindCount` (`0..30`)
  - `keepAheadCount` (`0..10`)
- Added env path aliases used by Docker/dev setups:
  - `DATA_DIR` fallback for app data root
  - `DATA_VIDEOS_DIR` / `DATA_IMAGES_DIR` for cache path overrides
- Fixed cache stream edge case that could leave browser requests pending by awaiting stream handlers in API routes.
- Hardened offline-video retrieval to skip stale/missing "ready" cache entries while paging.
- Prefetch now re-verifies "ready" cache entries before skipping downloads.
- Improved settings UX consistency:
  - Disabled + dimmed controls for offline-only/audio-dependent options.
  - Added inline contextual notes for disabled settings.
  - Cookie input and `Save Cookies` are disabled together in offline modes.

## 0.17.0 - 2026-03-04

- Updated dependencies to latest stable major/minor releases:
  - `fastify@5.7.4`
  - `@fastify/static@9.0.0`
  - `typescript@5.9.3`
  - `tsx@4.21.0`
  - `@types/node@25.3.3`
- Added containerization files:
  - `Dockerfile` (multi-stage, `node:latest`)
  - `compose.yaml` (data bind mounts + healthcheck)
  - `.dockerignore`
- Expanded documentation for Docker setup, operations, troubleshooting, and acceptance checks.
- Included `data/sounds` assets in git as part of the application dataset.

## 0.16.0 - 2026-03-04

- Renamed local audio library path from `data/media` to `data/sounds`.
- Renamed SQLite file from `data/slopscroll.db` to `data/database.db`.
- Updated runtime wiring, config example, and docs to match new storage paths.

## 0.15.0 - 2026-03-04

Release rationale: version moved from `0.1.0` to `0.15.0` to match 14 major feature increments implemented since initial baseline.

Major feature set included in this release line:
- Mobile playback and UI hardening.
- Background audio loop library and random switching controls.
- Audio loop crossfade and feed-advance loop switching controls.
- Auto-advance behavior improvements.
- Feed browsing sort/period filters and total counter behavior updates.
- Likes support and author-like flows.
- Main-feed snapshot restore from author feed.
- Loading UX improvements (initial feed loader and active media loading feedback).
- Strict offline video mode (cached-only, no Civitai network).
- Offline image mode (local filesystem image feed).
- Feed mode selector with offline order controls.
- Immediate settings autosave and application.
- Pitch shift control for audio loops.
- Configurable panic mode with Google-like overlay and same-tab redirect behavior.
