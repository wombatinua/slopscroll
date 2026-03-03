# SlopScroll Runbook

## Setup

1. `npm install`
2. `cp config/local.example.json config/local.json` (optional)
3. `npm run parse-har -- /path/to/civitai.har`
4. `npm run dev`
5. Open `http://localhost:3579`
6. Paste full browser `Cookie` header in UI

## Daily Operation

- If feed fails with auth error, re-import fresh cookies.
- If Civitai endpoint shape changes, export a new HAR and rerun parser.
- Use UI stats panel or `GET /api/cache/stats` for cache/disk health.

## Troubleshooting

### Auth invalid after import

- Re-copy the cookie string from active authenticated browser session.
- Run `POST /api/spec/reload`.
- Check if response from `GET /api/auth/status` says unauthorized.

### Feed returns empty

- Inspect `data/civitai-request-spec.analysis.json`.
- Adjust `itemPaths` / `mediaUrlPaths` in `data/civitai-request-spec.json`.
- Reload spec and retry.

### Video playback fails

- Confirm video exists in DB via feed API first.
- Check download status in `GET /api/cache/stats` and logs.
- If file is corrupt/empty, request same video again to redownload.

### Low disk warning

- Cache never auto-deletes.
- Increase storage or manually remove files in `data/cache/videos` if desired.
