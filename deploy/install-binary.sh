#!/usr/bin/env bash
# Installs the compiled claude-rc-launcher binary onto the system PATH, optionally sets up the
# systemd service, and restarts the service if it is running.
#
#   sudo deploy/install-binary.sh [--service] [path/to/binary]
#
# The binary defaults to ./dist/claude-rc-launcher (from `./install.sh --build`); pass the path of
# a downloaded release binary instead if you used that.
#
#   --service   also install the systemd unit and /etc/claude-rc-launcher.env (see below)
#
# The binary is COPIED to $PREFIX/bin (never symlinked into a build tree: the service runs as
# root, so it must not execute a file somebody else can modify) and replaced atomically, so
# upgrading a running service is safe.
#
# With --service:
#   * the unit is installed to /etc/systemd/system/claude-rc-launcher.service; an existing, different
#     unit is left alone (you may have edited it) and a warning is printed
#   * /etc/claude-rc-launcher.env is created from deploy/launcher.env.example (mode 600) with a freshly
#     generated SESSION_SECRET. An existing env file is NEVER modified.
#   * systemd is reloaded, but the service is only enabled and started once the env file has real
#     values for PUBLIC_URL, OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and SESSION_SECRET. Otherwise
#     it prints what to fill in; run the same command again afterwards.
#
# Environment (mainly for testing): PREFIX (default /usr/local), SYSTEMD_DIR (default
# /etc/systemd/system), ENV_FILE (default /etc/claude-rc-launcher.env).
set -euo pipefail

NAME=claude-rc-launcher
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PREFIX=${PREFIX:-/usr/local}
SYSTEMD_DIR=${SYSTEMD_DIR:-/etc/systemd/system}
ENV_FILE=${ENV_FILE:-/etc/claude-rc-launcher.env}
DEST_DIR="$PREFIX/bin"
DEST="$DEST_DIR/$NAME"

SERVICE=0
SRC=""
for arg in "$@"; do
  case "$arg" in
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --service) SERVICE=1 ;;
    -*) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
    *) [ -z "$SRC" ] || { echo "error: more than one binary path given" >&2; exit 2; }; SRC=$arg ;;
  esac
done
SRC=${SRC:-"$HERE/../dist/claude-rc-launcher"}

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

HAVE_SYSTEMCTL=0
command -v systemctl >/dev/null 2>&1 && HAVE_SYSTEMCTL=1

# --------------------------------------------------------------------------------------------
if [ "$SERVICE" -eq 0 ]; then
  if [ "$DEST" != "/usr/local/bin/$NAME" ]; then
    echo "note: $NAME.service expects /usr/local/bin/$NAME; edit its ExecStart= to use $DEST." >&2
  fi
  if [ "$HAVE_SYSTEMCTL" -eq 1 ] && systemctl is-active --quiet "$NAME" 2>/dev/null; then
    echo "Restarting $NAME to pick up the new binary"
    systemctl restart "$NAME"
  fi
  exit 0
fi

# ---- --service ------------------------------------------------------------------------------
UNIT_SRC="$HERE/$NAME.service"
ENV_SRC="$HERE/launcher.env.example"
[ -f "$UNIT_SRC" ] && [ -f "$ENV_SRC" ] || { echo "error: $UNIT_SRC or $ENV_SRC missing (run from a full checkout)" >&2; exit 1; }

# Unit: render with the real binary path, never clobber a different existing unit.
UNIT_DEST="$SYSTEMD_DIR/$NAME.service"
mkdir -p "$SYSTEMD_DIR"
RENDERED=$(mktemp)
trap 'rm -f "$RENDERED"' EXIT
sed "s|^ExecStart=.*|ExecStart=$DEST|" "$UNIT_SRC" > "$RENDERED"
if [ ! -e "$UNIT_DEST" ]; then
  install -m 644 "$RENDERED" "$UNIT_DEST"
  echo "Installed $UNIT_DEST"
elif cmp -s "$RENDERED" "$UNIT_DEST"; then
  echo "Unit already up to date: $UNIT_DEST"
else
  echo "warning: $UNIT_DEST exists and differs from the shipped unit; leaving it unchanged." >&2
  echo "         Compare with: diff $UNIT_DEST $UNIT_SRC" >&2
fi

# Env file: create once with a generated SESSION_SECRET; never touch an existing one.
if [ ! -e "$ENV_FILE" ]; then
  if command -v openssl >/dev/null 2>&1; then
    SECRET=$(openssl rand -hex 32)
  else
    SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  fi
  install -m 600 "$ENV_SRC" "$ENV_FILE"
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$SECRET|" "$ENV_FILE"
  echo "Created $ENV_FILE (mode 600) with a generated SESSION_SECRET"
else
  echo "Keeping existing $ENV_FILE"
fi

if [ "$HAVE_SYSTEMCTL" -eq 1 ]; then systemctl daemon-reload; fi

# Readiness: every required key must be set to a real (non-placeholder) value.
get() { grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true; }
MISSING=()
for key in PUBLIC_URL OIDC_ISSUER OIDC_CLIENT_ID OIDC_CLIENT_SECRET SESSION_SECRET; do
  val=$(get "$key")
  case "$val" in
    ""|*replace-with*|*example.com*) MISSING+=("$key") ;;
  esac
done

if [ "${#MISSING[@]}" -gt 0 ]; then
  echo
  echo "Not enabling the service yet: set real values for ${MISSING[*]} in $ENV_FILE"
  echo "(see README.md, 'Authentik setup'), then run again:  sudo $0 --service"
  exit 0
fi

if [ "$HAVE_SYSTEMCTL" -eq 0 ]; then
  echo "systemctl not found; start $DEST yourself with $ENV_FILE loaded."
  exit 0
fi
systemctl enable "$NAME"
# enable --now does not restart a running service, so restart explicitly to pick up the new binary.
systemctl restart "$NAME"

# Tell the user where to check, using the port/host actually configured (defaults: 8080, all
# interfaces -> use loopback).
PORT=$(get PORT); PORT=${PORT:-8080}
HOST=$(get HOST)
case "$HOST" in ""|0.0.0.0|::|"[::]") HOST=127.0.0.1 ;; esac
echo "Enabled and started $NAME. Check: curl http://$HOST:$PORT/healthz"
