#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${SITES_ENV_READY:-}" != "1" ]]; then
  exec "${script_dir}/sites-env.sh" -- bash "$0" "$@"
fi

command -v timeout >/dev/null || {
  echo "build-verified.sh requires GNU timeout." >&2
  exit 69
}

vite_bin="${SITES_PROJECT_ROOT}/node_modules/.bin/vite"
if [[ ! -x "${vite_bin}" ]]; then
  echo "Vite is unavailable. Run npm run install:ci first." >&2
  exit 69
fi

echo "Running bounded Vite build..."
rm -rf "${SITES_PROJECT_ROOT}/dist"
timeout --signal=TERM --kill-after=10s "${SITES_BUILD_TIMEOUT:-3m}" "${vite_bin}" build
