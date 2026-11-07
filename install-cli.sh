#!/bin/sh
# Installs the claude-rc command-line client from a GitHub release. Safe to run again: it replaces the old copy.
#
#   curl -fsSL https://raw.githubusercontent.com/kbirger/claude-rc-launcher/main/install-cli.sh | sh
#
# Every argument is passed on to claude-rc after the install, so one line can also set up a node:
#
#   curl -fsSL https://raw.githubusercontent.com/kbirger/claude-rc-launcher/main/install-cli.sh | sh -s -- node setup --hub https://rc.example.com --listen 10.0.0.5 --name pi
#
# Settings are environment variables, because the arguments belong to claude-rc:
#   CLAUDE_RC_VERSION   release tag, for example v0.2.0 (default: the latest release)
#   CLAUDE_RC_PREFIX    install directory (default: /usr/local/bin, with sudo when it is not writable)
#
# The binary is checked against the SHA256SUMS file of the same release. That catches a damaged or incomplete
# download. It does not protect you from a compromised release: read the script and verify the release if that matters.
set -eu

REPO=kbirger/claude-rc-launcher
VERSION=${CLAUDE_RC_VERSION:-latest}

say() { printf '%s\n' "$*"; }
die() { printf 'install-cli: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  MINGW*|MSYS*|CYGWIN*) die "Windows is not supported by this script. Download claude-rc-windows-x64.exe from https://github.com/$REPO/releases" ;;
  *) die "unsupported operating system: $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported CPU architecture: $(uname -m)" ;;
esac
ASSET="claude-rc-$OS-$ARCH"
if [ "$VERSION" = latest ]; then BASE="https://github.com/$REPO/releases/latest/download"; else BASE="https://github.com/$REPO/releases/download/$VERSION"; fi

if command -v sha256sum >/dev/null 2>&1; then
  hash_of() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  hash_of() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  die "sha256sum or shasum is required to check the download"
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/claude-rc-install.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM

say "Downloading $ASSET ($VERSION)"
curl -fsSL -o "$TMP/$ASSET" "$BASE/$ASSET" || die "cannot download $BASE/$ASSET"
curl -fsSL -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS" || die "cannot download $BASE/SHA256SUMS"

WANT=$(awk -v f="$ASSET" '$2 == f { print $1 }' "$TMP/SHA256SUMS")
[ -n "$WANT" ] || die "SHA256SUMS has no entry for $ASSET"
HAVE=$(hash_of "$TMP/$ASSET")
[ "$WANT" = "$HAVE" ] || die "checksum of $ASSET does not match SHA256SUMS (expected $WANT, got $HAVE). Nothing was installed"

# Where to install, and whether that needs sudo.
DIR=${CLAUDE_RC_PREFIX:-/usr/local/bin}
writable() { d=$1; while [ ! -d "$d" ]; do d=$(dirname "$d"); done; [ -w "$d" ]; }
SUDO=""
if ! writable "$DIR"; then
  if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
    SUDO=sudo
  elif [ -z "${CLAUDE_RC_PREFIX:-}" ]; then
    DIR="$HOME/.local/bin"
    say "$DIR is used because /usr/local/bin is not writable and sudo is not available"
  else
    die "$DIR is not writable and sudo is not available"
  fi
fi
DEST="$DIR/claude-rc"

# Written under a temporary name and moved into place, so that a running copy is never overwritten in place.
$SUDO mkdir -p "$DIR"
$SUDO install -m 755 "$TMP/$ASSET" "$DIR/.claude-rc.new.$$"
$SUDO mv -f "$DIR/.claude-rc.new.$$" "$DEST"
say "Installed $DEST"
case ":$PATH:" in *":$DIR:"*) ;; *) say "Note: $DIR is not on your PATH. Add it, or run $DEST" ;; esac

if [ "$#" -gt 0 ]; then
  # The script itself arrives on stdin, so the program would see end-of-file where it expects the keyboard
  # (the sign-in paste prompt). Give it the terminal when there is one.
  if (: </dev/tty) 2>/dev/null; then exec "$DEST" "$@" </dev/tty; fi
  exec "$DEST" "$@"
fi
