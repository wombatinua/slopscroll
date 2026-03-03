# Civitai Request Replication Spec

This project uses `data/civitai-request-spec.json` as the source of truth for replaying feed requests.

## Schema

```json
{
  "endpoint": "https://civitai.com/api/...",
  "method": "GET|POST",
  "query": { "key": "value" },
  "headers": { "Header-Name": "value" },
  "cursorParam": "cursor",
  "limitParam": "limit",
  "itemPaths": ["items", "data.items"],
  "cursorPaths": ["nextCursor", "pagination.nextCursor"],
  "mediaUrlPaths": ["videoUrl", "files.0.url"],
  "pageUrlPaths": ["url", "pageUrl"],
  "authorPaths": ["author.username", "username"],
  "durationPaths": ["duration"],
  "createdAtPaths": ["createdAt"]
}
```

## Generation Flow

1. Capture HAR from authenticated browser session.
2. Run `npm run parse-har -- <HAR_FILE>`.
3. Review generated `data/civitai-request-spec.analysis.json`.
4. Optionally edit `data/civitai-request-spec.json` if required headers/paths need tuning.
5. Reload spec in app (`POST /api/spec/reload`) or restart server.

## Expired Cookie Behavior

- Feed requests returning `401/403` are treated as auth expiry.
- API returns `requiresReimport: true`.
- UI shows auth overlay prompting cookie re-import.

## Failure Modes

- Missing spec file: feed/auth validation blocked.
- Wrong endpoint/headers: feed request returns non-200.
- Wrong extraction paths: feed call succeeds but zero normalized items.
