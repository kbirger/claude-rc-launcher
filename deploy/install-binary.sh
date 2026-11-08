#!/usr/bin/env bash
# Installs the compiled claude-rc-launcher binary onto the system PATH, optionally sets up the
# systemd service, and restarts the service if it is running.
#
#   sudo deploy/install-binary.sh [--service [--node]] [path/to/binary]
#
# The binary defaults to ./dist/claude-rc-launcher (from `./install.sh --build`); pass the path of
# a downloaded release binary instead if you used that.
#
#   --service   also install the systemd unit and /etc/claude-rc-launcher/config.toml (see below)
#   --node      with --service: set this host up as a NODE (managed by a hub) instead of a hub
#
# The binary is COPIED to $PREFIX/bin (never symlinked into a build tree: the service runs as
# root, so it must not execute a file somebody else can modify) and replaced atomically, so
# upgrading a running service is safe.
#
# With --service:
#   * the unit is installed to /etc/systemd/system/claude-rc-launcher.service; an existing, different
#     unit is left alone (you may have edited it) and a warning is printed
#   * /etc/claude-rc-launcher/config.toml is created from deploy/config.example.toml (mode 644, no
#     secrets) and session.secret is generated next to it (mode 600). Existing files are NEVER modified.
#     With --node the node example config is used and no session.secret is created.
#   * systemd is reloaded, but the service is only enabled and started once config.toml has no
#     placeholders left and oidc-client.secret exists and is non-empty (node: at least one
#     [[node_auth.hub_key]] or [[node_auth.secret]] row is present). Otherwise it prints what to fill in; run the same command
#     again afterwards.
#
# Environment (mainly for testing): PREFIX (default /usr/local), SYSTEMD_DIR (default
# /etc/systemd/system), CONFIG_DIR (default /etc/claude-rc-launcher), SKIP_SYSTEMCTL=1.
set -euo pipefail

NAME=claude-rc-launcher
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PREFIX=${PREFIX:-/usr/local}
SYSTEMD_DIR=${SYSTEMD_DIR:-/etc/systemd/system}
CONFIG_DIR=${CONFIG_DIR:-/etc/claude-rc-launcher}
DEST_DIR="$PREFIX/bin"
DEST="$DEST_DIR/$NAME"

SERVICE=0
NODE=0
SRC=""
for arg in "$@"; do
  case "$arg" in
    -h|--help) sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --service) SERVICE=1 ;;
    --node) NODE=1 ;;
    -*) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
    *) [ -z "$SRC" ] || { echo "error: more than one binary path given" >&2; exit 2; }; SRC=$arg ;;
  esac
done
SRC=${SRC:-"$HERE/../dist/claude-rc-launcher"}
[ "$NODE" -eq 0 ] || [ "$SERVICE" -eq 1 ] || { echo "error: --node requires --service" >&2; exit 2; }

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
[ -z "${SKIP_SYSTEMCTL:-}" ] && command -v systemctl >/dev/null 2>&1 && HAVE_SYSTEMCTL=1

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
if [ "$NODE" -eq 1 ]; then CONF_SRC="$HERE/node.config.example.toml"; else CONF_SRC="$HERE/config.example.toml"; fi
[ -f "$UNIT_SRC" ] && [ -f "$CONF_SRC" ] || { echo "error: $UNIT_SRC or $CONF_SRC missing (run from a full checkout)" >&2; exit 1; }

# Unit: render with the real binary path, never clobber a different existing unit.
UNIT_DEST="$SYSTEMD_DIR/$NAME.service"
mkdir -p "$SYSTEMD_DIR"
RENDERED=$(mktemp)
trap 'rm -f "$RENDERED"' EXIT
sed "s|^ExecStart=.*|ExecStart=$DEST --config $CONFIG_DIR/config.toml|" "$UNIT_SRC" > "$RENDERED"
if [ ! -e "$UNIT_DEST" ]; then
  install -m 644 "$RENDERED" "$UNIT_DEST"
  echo "Installed $UNIT_DEST"
elif cmp -s "$RENDERED" "$UNIT_DEST"; then
  echo "Unit already up to date: $UNIT_DEST"
else
  echo "warning: $UNIT_DEST exists and differs from the shipped unit; leaving it unchanged." >&2
  echo "         Compare with: diff $UNIT_DEST $UNIT_SRC" >&2
fi

# Config: create once; never touch existing files.
CONF="$CONFIG_DIR/config.toml"
SESSION_SECRET_FILE="$CONFIG_DIR/session.secret"
mkdir -p "$CONFIG_DIR"
if [ ! -e "$CONF" ]; then
  install -m 644 "$CONF_SRC" "$CONF"
  echo "Created $CONF (mode 644, contains no secrets)"
else
  echo "Keeping existing $CONF"
fi
if [ "$NODE" -eq 0 ]; then
  if [ ! -e "$SESSION_SECRET_FILE" ]; then
    if command -v openssl >/dev/null 2>&1; then
      SECRET=$(openssl rand -hex 32)
    else
      SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
    fi
    ( umask 077; printf '%s\n' "$SECRET" > "$SESSION_SECRET_FILE" )
    chmod 600 "$SESSION_SECRET_FILE"
    echo "Created $SESSION_SECRET_FILE (mode 600)"
  else
    echo "Keeping existing $SESSION_SECRET_FILE"
  fi
fi

if [ "$HAVE_SYSTEMCTL" -eq 1 ]; then systemctl daemon-reload; fi

# Readiness: no placeholders left in config.toml, plus the auth material the role needs.
MISSING=()
if grep -qE 'example\.com|replace-with' "$CONF"; then MISSING+=("placeholder values in $CONF"); fi
if [ "$NODE" -eq 1 ]; then
  if ! grep -qE '^\[\[node_auth\.(hub_key|secret)\]\]' "$CONF"; then
    MISSING+=("a node_auth method in $CONF ([[node_auth.hub_key]] with the hub public key from 'claude-rc node config', or [[node_auth.secret]] with the sha256 from 'claude-rc-launcher gen-secret')")
  fi
elif [ ! -s "$CONFIG_DIR/oidc-client.secret" ]; then
  MISSING+=("$CONFIG_DIR/oidc-client.secret (mode 600)")
fi

if [ "$NODE" -eq 1 ]; then
  STATE_DIR=$(grep -E '^[[:space:]]*state_dir[[:space:]]*=' "$CONF" | tail -n1 | sed 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*#.*$//; s/"//g' || true)
  STATE_DIR=${STATE_DIR:-/var/lib/claude-rc-launcher}
  echo
  echo "Node setup: on first start the node generates its TLS certificate in $STATE_DIR."
  echo "  * certificate to pin on the hub: $STATE_DIR/node-cert.pem (copy it to the hub as the host's ca_file)"
  echo "  * compare the SHA-256 fingerprint with the one logged at start:"
  echo "      journalctl -u $NAME | grep 'node certificate fingerprint'"
fi

FLAGS="--service"; [ "$NODE" -eq 0 ] || FLAGS="--service --node"
if [ "${#MISSING[@]}" -gt 0 ]; then
  echo
  echo "Not enabling the service yet. Fill in:"
  for m in "${MISSING[@]}"; do echo "  - $m"; done
  echo "(see README.md, 'Authentik setup'), then run again:  sudo $0 $FLAGS"
  exit 0
fi

if [ "$HAVE_SYSTEMCTL" -eq 0 ]; then
  echo "systemctl not found; start $DEST --config $CONF yourself."
  exit 0
fi
systemctl enable "$NAME"
# enable --now does not restart a running service, so restart explicitly to pick up the new binary.
systemctl restart "$NAME"

# Tell the user where to check, using the port/host actually configured (defaults: 8080, all
# interfaces -> use loopback).
get() { grep -E "^$1[[:space:]]*=" "$CONF" | tail -n1 | sed 's/^[^=]*=[[:space:]]*//; s/[[:space:]]*#.*$//; s/"//g' || true; }
PORT=$(get port); if [ "$NODE" -eq 1 ]; then PORT=${PORT:-8443}; else PORT=${PORT:-8080}; fi
HOST=$(get host)
case "$HOST" in ""|0.0.0.0|::|"[::]") HOST=127.0.0.1 ;; esac
if [ "$NODE" -eq 1 ]; then
  echo "Enabled and started $NAME (node). Check: curl --cacert $STATE_DIR/node-cert.pem https://<tls name>:$PORT/healthz"
else
  echo "Enabled and started $NAME. Check: curl http://$HOST:$PORT/healthz"
fi
