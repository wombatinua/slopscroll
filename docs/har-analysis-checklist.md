# HAR Analysis Checklist

Use this only for online mode setup/troubleshooting. Offline mode can run from local ready cache without HAR/spec reload.

1. Log in to `https://civitai.com` (or `https://civit.ai`) in your browser (Google login is fine).
2. Open DevTools -> Network.
3. Enable **Preserve log**.
4. Navigate to `https://civitai.com/videos`.
5. Scroll through several videos so feed API calls are captured.
6. In Network tab, filter to `Fetch/XHR`.
7. Export all as HAR (`Save all as HAR with content`).
8. Run:

```bash
npm run parse-har -- /path/to/session.har
```

9. Confirm files were produced:
- `data/civitai-request-spec.json`
- `data/civitai-request-spec.analysis.json`

10. Validate in app:
- `POST /api/spec/reload`
- `GET /api/auth/status`
- `GET /api/feed/next`

If feed/auth fails, regenerate HAR with a fresh login and include additional scrolling requests.
