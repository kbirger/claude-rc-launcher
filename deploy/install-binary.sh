#!/usr/bin/env bash
# Installs the compiled claude-rc-launcher binary onto the system PATH and restarts the service
# if it is running.
#
#   sudo deploy/install-binary.sh [path/to/binary]
#
# The binary defaults to ./dist/claude-rc-launcher (from `./install.sh --build`); pass the path of
# a downloaded release binary instead if you used that. Environment:
#   PREFIX   install prefix (default /usr/local; the binary goes to $PREFIX/bin/claude-rc-launcher)
#
# It COPIES the file (never symlinks it into a build tree: the service runs as root, so it must
# not execute a file somebody else can modify) and replaces it atomically, so upgrading a running
# service is safe. The systemd unit expects /usr/local/bin/claude-rc-launcher.
set -euo pipefail

SRC=${1:-"$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/dist/claude-rc-launcher"}
PREFIX=${PREFIX:-/usr/local}
NAME=claude-rc-launcher
DEST_DIR="$PREFIX/bin"
DEST="$DEST_DIR/$NAME"

case "${1:-}" in -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; esac

[ -f "$SRC" ] || { echo "error: binary not found: $SRC (build it with ./install.sh --build, or pass a path)" >&2; exit 1; }

# On Linux, make sure we are installing a native executable and not, say, an HTML error page that
# a failed download saved to disk.
if [ "$(uname -s)" = "Linux" ] && [ "$(head -c4 "$SRC" | od -An -c | tr -d ' ')" != '177ELF' ]; then
  echo "error: $SRC is not a Linux executable (ELF)." >&2
  exit 1
fi

if ! mkdir -p "$DEST_DIR" 2>/dev/null || [ ! -w "$DEST_DIR" ]; then
  echo "error: cannot write to $DEST_DIR; run with sudo." >&2
  exit 1
fi

# Write next to the destination, then rename over it: atomic, and safe while the old one runs.
TMP=$(mktemp "$DEST_DIR/.$NAME.XXXXXX")
trap 'rm -f "$TMP"' EXIT
install -m 755 "$SRC" "$TMP"
mv -f "$TMP" "$DEST"
trap - EXIT
echo "Installed $DEST"

if [ "$DEST" != "/usr/local/bin/$NAME" ]; then
  echo "note: deploy/$NAME.service expects /usr/local/bin/$NAME; edit its ExecStart= to use $DEST." >&2
fi

if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$NAME" 2>/dev/null; then
  echo "Restarting $NAME to pick up the new binary"
  systemctl restart "$NAME"
fi
