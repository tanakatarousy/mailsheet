#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${SITES_ENV_READY:-}" != "1" ]]; then
  exec "${script_dir}/sites-env.sh" -- bash "$0" "$@"
fi

command -v timeout >/dev/null || {
  echo "install-ci.sh requires GNU timeout." >&2
  exit 69
}

echo "[sites] running one bounded npm ci"
timeout --signal=TERM --kill-after=15s "${SITES_INSTALL_TIMEOUT:-8m}" npm ci
test -x "${SITES_PROJECT_ROOT}/node_modules/.bin/vite" || {
  echo "npm ci completed without Vite." >&2
  exit 69
}
