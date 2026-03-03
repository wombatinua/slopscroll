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

3. Generate Civitai request spec from HAR:

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
