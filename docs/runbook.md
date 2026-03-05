# SlopScroll Runbook

## Setup

1. `npm install`
2. `npm run parse-har -- /path/to/civitai.har` (needed for online mode)
3. `npm run dev`
4. Open `http://localhost:3579`
5. Paste full browser `Cookie` header in UI
6. Optional: install as PWA via `Install app` button in top bar (when browser exposes install prompt)

## Docker Operation

Start/rebuild:
1. `./scripts/docker-up.sh`
2. `docker compose ps`
3. `docker compose logs -f slopscroll` (if needed)

Stop:
1. `docker compose down`

Notes:
- Service health is based on `GET /api/health`.
- Compose reads override values from `.env` (`APP_HOST`, `APP_PORT`, `DATA_DIR`, `DATA_IMAGES_DIR`, `DATA_VIDEOS_DIR`).
- Persistent mutable state is host-mounted from `${DATA_DIR}` (includes `images`, `videos`, `sounds`, `session`, DB/spec files).
- `DATA_IMAGES_DIR` and `DATA_VIDEOS_DIR` can optionally override only those two subpaths.

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

## Smoke Check (10-15 min)

Run this before release or after changes in feed/cache/settings/audio logic.

1. Startup
- Run `npm run dev` (or `./scripts/docker-up.sh`).
- Open `http://localhost:3579`.
- Expect: app loads without JS errors, settings panel opens, version label is visible.

2. Online auth + feed
- Set `Feed mode = Online`.
- Import valid cookies.
- Expect: auth status is valid, first feed page loads, active item starts normally.

3. Feed navigation + incremental load
- Scroll 10-20 items (mouse/touch/keyboard `j/k` or arrows).
- Expect: no stuck pending requests, no blank card gaps, load-more triggers near the end.

4. Cache + replay sanity
- Open DevTools Network and replay a few already visited items.
- Expect: videos already seen are served from local cache path via backend without hangs.

5. Settings persistence
- Change `Prefetch depth`, `Feed page size`, `Load-more threshold`, `Keep-behind`, `Keep-ahead`.
- Reload page.
- Expect: values persist and apply immediately after reload.

6. Disabled-state consistency
- Switch to `Offline Video` or `Offline Image`.
- Expect: cookie input + `Save Cookies` disabled and dimmed; content-level toggles disabled and dimmed.
- Toggle `Auto-advance` off/on.
- Expect: interval selector is disabled only when auto-advance is off, with helper note.
- Toggle `Enable loop playback` off/on.
- Expect: `Crossfade` + `Pitch shift` disabled only when loop playback is off.
- Toggle `Random loop switching (timer)` off/on (with loop playback on).
- Expect: random min/max disabled only when timer is off.

7. Offline modes
- `Offline Video`: verify feed shows only ready cached videos, no Civitai requests.
- `Offline Image`: verify image-only feed from `data/images`, likes/author flow hidden.
- Expect: empty offline source shows centered empty-state overlay (not blank screen).

8. Audio behavior quick pass
- With loop playback on, test:
  - random timer on: loop switches in configured min/max window
  - switch-on-video-change on: loop switches on item change
- With both switches off: current loop continues.

9. Panic mode
- If enabled, press `Spacebar`.
- Expect: panic overlay appears immediately, tab title becomes `New Tab`, audio/feed playback pauses.

10. Final health
- Check `GET /api/health` and `GET /api/cache/stats`.
- Expect: service healthy, stats endpoint responds, no obvious error spikes in logs.

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
  - Rebuild image with `./scripts/docker-up.sh`.
