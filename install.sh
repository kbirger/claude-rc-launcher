#!/usr/bin/env bash
# Installs the build dependencies for claude-rc-launcher (root + web/), optionally builds it.
#
#   ./install.sh            install dependencies
#   ./install.sh --build    install dependencies, then build dist/claude-rc-launcher
#
# Bun is installed locally as a devDependency (node_modules/.bin/bun); nothing global is touched.
# Deploying the binary and the systemd unit is a separate, root-only step: see README.md "Install".
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

BUILD=0
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=1 ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' is required but not found. $2" >&2; exit 1; }
}

need node "Install Node.js 20 or newer (https://nodejs.org or your package manager)."
need npm "It ships with Node.js."

node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 20 ]; then
  echo "error: Node.js 20+ is required (found $(node --version))." >&2
  exit 1
fi

# npm ci is reproducible when a lockfile exists; fall back to install otherwise.
install_deps() {
  local dir=$1
  if [ -f "$dir/package-lock.json" ]; then
    npm --prefix "$dir" ci
  else
    npm --prefix "$dir" install
  fi
}

echo "==> Installing server dependencies (includes a local Bun)"
install_deps .
echo "==> Installing web dependencies"
install_deps web

echo "==> Checking bun"
./node_modules/.bin/bun --version

# Runtime prerequisites. These only warn: the build itself does not need them.
command -v systemctl >/dev/null 2>&1 || echo "warning: systemctl not found; the launcher needs systemd to run instances." >&2
command -v claude >/dev/null 2>&1 || echo "warning: 'claude' not on PATH for this user; it must be installed for SERVICE_USER (set CLAUDE_BIN)." >&2

if [ "$BUILD" -eq 1 ]; then
  echo "==> Building"
  PATH="$PWD/node_modules/.bin:$PATH" npm run build
  echo "Built: dist/claude-rc-launcher"
else
  echo "Done. Run './install.sh --build' (or 'npm run build') to produce dist/claude-rc-launcher."
fi
