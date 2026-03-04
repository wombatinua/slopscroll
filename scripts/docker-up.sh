#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

resolve_commit() {
  if [[ -n "${APP_COMMIT:-}" ]]; then
    printf '%s' "${APP_COMMIT}"
    return
  fi

  if command -v git >/dev/null 2>&1; then
    local sha
    sha="$(git rev-parse --short=7 HEAD 2>/dev/null || true)"
    if [[ -n "${sha}" ]]; then
      printf '%s' "${sha}"
      return
    fi
  fi

  printf '%s' "unknown"
}

COMMIT="$(resolve_commit)"
printf 'Using APP_COMMIT=%s\n' "${COMMIT}"

APP_COMMIT="${COMMIT}" docker compose up -d --build "$@"
