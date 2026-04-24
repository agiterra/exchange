#!/usr/bin/env bash
# Wire installer — one-command install on macOS or Linux.
#
# Usage (from a fresh machine):
#   curl -fsSL https://raw.githubusercontent.com/agiterra/wire/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/agiterra/wire/main/scripts/install.sh | WIRE_VERSION=v1.0.0 bash
#
# What it does:
#   1. Detects platform + arch. Aborts on anything other than
#      macOS or Linux on arm64 / x64.
#   2. Downloads the matching binary zip from the GitHub release
#      (defaults to latest, pinnable via WIRE_VERSION).
#   3. Verifies sha256 against SHA256SUMS from the release.
#   4. Installs the binary to ~/.wire/bin/wire.
#   5. Writes a default ~/.wire/.env if one is not already present.
#   6. Installs a service unit — launchd on macOS, systemd --user on
#      Linux — that starts the binary on login / boot with restart
#      on failure.
#   7. Loads the service.
#
# Safe to re-run. If the service is already loaded, the script
# reloads it with the updated binary. Config and DB are preserved.
#
# Environment overrides:
#   WIRE_VERSION   — release tag to install (default: latest)
#   WIRE_HOME      — where to install (default: $HOME/.wire)
#   NO_SERVICE     — if set, skip the launchd/systemd step
#   SKIP_CHECKSUM  — if set, skip sha256 verification (not recommended)

set -euo pipefail

REPO="agiterra/wire"
WIRE_HOME="${WIRE_HOME:-$HOME/.wire}"
VERSION="${WIRE_VERSION:-}"

log()   { printf '\033[36m[wire-install]\033[0m %s\n' "$*"; }
die()   { printf '\033[31m[wire-install:error]\033[0m %s\n' "$*" >&2; exit 1; }
warn()  { printf '\033[33m[wire-install:warn]\033[0m %s\n' "$*" >&2; }

# --- Platform detection ---

os=""
arch=""
case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *)      die "unsupported OS: $(uname -s). Supported: Darwin, Linux." ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *)             die "unsupported arch: $(uname -m). Supported: arm64 / x64." ;;
esac
target="${os}-${arch}"

# --- Resolve version ---

if [[ -z "${VERSION}" ]]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | awk -F'"' '/"tag_name"/ {print $4; exit}')"
  if [[ -z "${VERSION}" ]]; then
    die "failed to resolve latest release tag. Try pinning with WIRE_VERSION=v1.0.0"
  fi
fi
log "installing wire ${VERSION} for ${target} into ${WIRE_HOME}"

# --- Download ---

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

base="https://github.com/${REPO}/releases/download/${VERSION}"
zip_name="wire-${target}.zip"
zip_url="${base}/${zip_name}"
sums_url="${base}/SHA256SUMS"

log "  fetching ${zip_url}"
curl -fsSL "${zip_url}" -o "${tmp}/${zip_name}"

if [[ -z "${SKIP_CHECKSUM:-}" ]]; then
  log "  verifying sha256"
  curl -fsSL "${sums_url}" -o "${tmp}/SHA256SUMS"
  expected="$(awk -v name="${zip_name}" '$2==name || $2=="./"name {print $1; exit}' "${tmp}/SHA256SUMS")"
  if [[ -z "${expected}" ]]; then
    warn "  ${zip_name} not found in SHA256SUMS — skipping verification"
  else
    actual="$(shasum -a 256 "${tmp}/${zip_name}" | awk '{print $1}')"
    if [[ "${expected}" != "${actual}" ]]; then
      die "sha256 mismatch: expected ${expected}, got ${actual}"
    fi
  fi
fi

# --- Unpack + install binary ---

mkdir -p "${WIRE_HOME}/bin"
(cd "${tmp}" && unzip -q -o "${zip_name}")
bin="${tmp}/wire-${target}"
[[ -f "${bin}" ]] || die "zip did not contain wire-${target}"
chmod +x "${bin}"
mv "${bin}" "${WIRE_HOME}/bin/wire"
log "  installed binary to ${WIRE_HOME}/bin/wire"

# --- Default .env ---

env_file="${WIRE_HOME}/.env"
if [[ ! -f "${env_file}" ]]; then
  cat > "${env_file}" <<EOF
# Wire config. Reload the service after edits.
WIRE_PORT=9800
# WIRE_DB=${WIRE_HOME}/wire.db   # default
# STALE_MS=15000
# DISCONNECT_MS=60000
# RECONCILER_INTERVAL_MS=10000
# EPHEMERAL_TTL_MS=300000
EOF
  log "  wrote default config to ${env_file}"
else
  log "  keeping existing ${env_file}"
fi

# --- Service unit ---

if [[ -n "${NO_SERVICE:-}" ]]; then
  log "NO_SERVICE set — skipping service installation"
  log "run manually: ${WIRE_HOME}/bin/wire"
  exit 0
fi

if [[ "${os}" = "darwin" ]]; then
  plist="${HOME}/Library/LaunchAgents/com.wire.gateway.plist"
  log "  writing launchd plist to ${plist}"
  mkdir -p "$(dirname "${plist}")"
  cat > "${plist}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>            <string>com.wire.gateway</string>
    <key>ProgramArguments</key> <array><string>${WIRE_HOME}/bin/wire</string></array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key> <string>${HOME}</string>
        <key>PATH</key> <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    </dict>
    <key>RunAtLoad</key>        <true/>
    <key>KeepAlive</key>        <true/>
    <key>StandardOutPath</key>  <string>${WIRE_HOME}/wire.log</string>
    <key>StandardErrorPath</key><string>${WIRE_HOME}/wire.log</string>
    <key>WorkingDirectory</key> <string>${WIRE_HOME}</string>
</dict>
</plist>
EOF
  log "  loading launchd unit"
  launchctl unload "${plist}" 2>/dev/null || true
  launchctl load   "${plist}"
  log "done. service: launchctl list | grep com.wire.gateway"
elif [[ "${os}" = "linux" ]]; then
  unit="${HOME}/.config/systemd/user/wire.service"
  log "  writing systemd user unit to ${unit}"
  mkdir -p "$(dirname "${unit}")"
  cat > "${unit}" <<EOF
[Unit]
Description=Wire — multi-agent message broker
After=network.target

[Service]
Type=simple
ExecStart=${WIRE_HOME}/bin/wire
Restart=always
RestartSec=2
WorkingDirectory=${WIRE_HOME}
StandardOutput=append:${WIRE_HOME}/wire.log
StandardError=append:${WIRE_HOME}/wire.log

[Install]
WantedBy=default.target
EOF
  log "  enabling + starting via systemctl --user"
  systemctl --user daemon-reload
  systemctl --user enable --now wire.service
  log "done. service: systemctl --user status wire"
fi

log "Wire v${VERSION} installed."
log "Next steps:"
log "  - edit ${env_file} to configure (reload with 'launchctl kickstart -k gui/\$UID/com.wire.gateway' or 'systemctl --user restart wire')"
log "  - health check: curl -fsS http://localhost:\$(awk -F= '/^WIRE_PORT=/{print \$2}' ${env_file} 2>/dev/null || echo 9800)/health"
log "  - logs: tail -f ${WIRE_HOME}/wire.log"
