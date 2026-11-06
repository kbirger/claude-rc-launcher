#!/usr/bin/env bash
# Installs the build dependencies for claude-rc-launcher (root + web/), optionally builds it.
# Only Bun is needed: no Node.js or npm.
#
#   ./install.sh            install dependencies (installs Bun first if it is missing)
#   ./install.sh --build    install dependencies, then build dist/claude-rc-launcher
#
# If Bun is missing it is installed with Bun's official installer into ~/.bun (no root, no system
# changes), pinned to the version in .bun-version. To skip building on the server entirely, download
# a prebuilt binary from the GitHub releases page instead (see README.md "Install").
# Deploying the binary and the systemd unit is a separate, root-only step: see README.md.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

BUILD=0
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

BUN_VERSION=$(tr -d '[:space:]' < .bun-version)

if ! command -v bun >/dev/null 2>&1 && [ -x "$HOME/.bun/bin/bun" ]; then
  export PATH="$HOME/.bun/bin:$PATH"
fi

if ! command -v bun >/dev/null 2>&1; then
  command -v curl >/dev/null 2>&1 || { echo "error: curl is required to install Bun (or install Bun yourself: https://bun.sh)." >&2; exit 1; }
  command -v unzip >/dev/null 2>&1 || { echo "error: unzip is required by the Bun installer (or install Bun yourself: https://bun.sh)." >&2; exit 1; }
  echo "==> Bun not found; installing Bun ${BUN_VERSION} into \$HOME/.bun (official installer, https://bun.sh)"
  curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
  export PATH="$HOME/.bun/bin:$PATH"
fi

have=$(bun --version)
if [ "$have" != "$BUN_VERSION" ]; then
  echo "warning: bun $have found; this project is built and tested with $BUN_VERSION (.bun-version)." >&2
fi

echo "==> Installing server dependencies"
bun install --frozen-lockfile
echo "==> Installing web dependencies"
(cd web && bun install --frozen-lockfile)

# Runtime prerequisites. These only warn: the build itself does not need them.
command -v systemctl >/dev/null 2>&1 || echo "warning: systemctl not found; the launcher needs systemd to run instances." >&2
command -v claude >/dev/null 2>&1 || echo "warning: 'claude' not on PATH for this user; it must be installed for SERVICE_USER (set CLAUDE_BIN)." >&2

if [ "$BUILD" -eq 1 ]; then
  echo "==> Building"
  bun run build
  echo "Built: dist/claude-rc-launcher"
else
  echo "Done. Run './install.sh --build' (or 'bun run build') to produce dist/claude-rc-launcher."
fi
