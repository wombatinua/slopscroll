# SlopScroll Runbook

## Setup

1. `npm install`
2. `cp config/local.example.json config/local.json` (optional)
3. `npm run parse-har -- /path/to/civitai.har` (needed for online mode)
4. `npm run dev`
5. Open `http://localhost:3579`
6. Paste full browser `Cookie` header in UI

## Docker Operation

Start/rebuild:
1. `docker compose up -d --build`
2. `docker compose ps`
3. `docker compose logs -f slopscroll` (if needed)

Stop:
1. `docker compose down`

Notes:
- Service health is based on `GET /api/health`.
- Persistent state is host-mounted from `./data` (`images`, `videos`, `sounds`, `session`).

## Daily Operation

- If feed fails with auth error, re-import fresh cookies.
- If Civitai endpoint shape changes, export a new HAR and rerun parser.
- Use UI stats panel or `GET /api/cache/stats` for cache/disk health.
- Settings are autosaved on change; there is no explicit Save Settings action.
- In author feed, use header back arrow to return to the exact previous main-feed position.
- Clicking `SlopScroll` in header always reinitializes main feed.
- Feed mode selector (`Settings -> Feed mode`) controls source:
  - `Online`: Civitai-backed feed.
  - `Offline Video Mode`: ready cached videos only.
  - `Offline Image Mode`: local images from `data/images` only.

## Troubleshooting

### Auth invalid after import

- Re-copy the cookie string from active authenticated browser session.
- Run `POST /api/spec/reload`.
- Check if response from `GET /api/auth/status` says unauthorized.

### Feed returns empty

- Inspect `data/civitai-request-spec.analysis.json`.
- Adjust `itemPaths` / `mediaUrlPaths` in `data/civitai-request-spec.json`.
- Reload spec and retry.
- If `Offline Video Mode` is enabled, confirm ready cached videos exist (`GET /api/cache/stats`) or switch mode.
- If `Offline Image Mode` is enabled, confirm files exist under `data/images` and reinitialize feed.
- Prefetch depth still applies in both offline modes; `/api/prefetch` runs local-only and does not download.

### Video playback fails

- Confirm video exists in DB via feed API first.
- Check download status in `GET /api/cache/stats` and logs.
- If file is corrupt/empty, request same video again to redownload.
- In `Offline Video Mode`, uncached videos are intentionally blocked with `409`.
- In `Offline Image Mode`, `/api/video/:id` is intentionally blocked with `409`.

### Offline Mode Behavior

- `GET /api/auth/status` returns synthetic valid status while either offline mode is enabled.
- `POST /api/auth/cookies` and `POST /api/spec/reload` return `409` while either offline mode is enabled.
- `POST /api/prefetch` stays enabled in both offline modes and returns local-only prefetch status.
- Bottom-right feed controls switch from online sort/period to offline order (`Newest`, `Oldest`, `Random`) in both offline modes.
- In `Offline Image Mode`, likes endpoints and author-feed endpoints are blocked with `409`.
- If no eligible items exist, the app shows a centered empty-state overlay instead of a blank feed.

### Black bar between videos

- Confirm feed loading overlay appears during active-video buffering.
- If overlay appears but playback stalls, check browser media/network errors and retry item.
- If overlay does not appear, refresh page and verify frontend assets are up to date.

### Audio loops switch unexpectedly or not at all

- Check `Enable background loop playback` first.
- Check `Enable automatic random loop switching` for timer-based random changes.
- Check `Switch loop on feed item change` for feed-advance-driven loop changes.
- Check `Pitch shift` if perceived loop tone/speed is unexpected.
- If both switch toggles are off, current loop is expected to continue indefinitely.

### Panic mode

- If enabled in settings, pressing `Spacebar` triggers panic overlay immediately.
- Panic overlay intentionally does not close in-app; use search/URL input to navigate away.
- Tab title is changed to `New Tab` when panic mode activates.

### Low disk warning

- Cache never auto-deletes.
- Increase storage or manually remove files in `data/videos` if desired.

### Docker FAQ

- Container stuck in `starting`:
  - Wait for healthcheck `start_period` (about 25 seconds).
  - Check `docker compose ps` again.
- Container shows `unhealthy`:
  - Run `docker compose logs -f slopscroll`.
  - Verify app responds on `http://localhost:3579/api/health`.
- Data not persisting:
  - Verify host folders exist under `./data`.
  - Verify compose bind mounts are not overridden.
- Changes not applied after pull/edit:
  - Rebuild image with `docker compose up -d --build`.
