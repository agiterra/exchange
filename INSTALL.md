# Installing Wire

Wire ships as a standalone bun-compiled binary. No runtime dependencies.

## One-command install

```bash
curl -fsSL https://raw.githubusercontent.com/agiterra/wire/main/scripts/install.sh | bash
```

What this does:

1. Detects platform + arch (macOS/Linux × arm64/x64).
2. Fetches the matching binary zip from the latest GitHub release.
3. Verifies its sha256 against `SHA256SUMS` from the same release.
4. Installs the binary to `~/.wire/bin/wire`.
5. Creates `~/.wire/.env` with sensible defaults (if missing).
6. Installs a service unit:
   - **macOS**: `~/Library/LaunchAgents/com.wire.gateway.plist` (launchd).
   - **Linux**: `~/.config/systemd/user/wire.service` (systemd --user).
7. Loads and starts the service.

Config lives at `~/.wire/.env`. Data lives at `~/.wire/wire.db`. Logs at `~/.wire/wire.log`.

## Pinning a version

```bash
curl -fsSL https://raw.githubusercontent.com/agiterra/wire/main/scripts/install.sh | WIRE_VERSION=v1.0.0 bash
```

## Overrides

| Env var         | Default               | Effect                                            |
| --------------- | --------------------- | ------------------------------------------------- |
| `WIRE_VERSION`  | latest release        | Pin to a specific tag.                            |
| `WIRE_HOME`     | `$HOME/.wire`         | Where to install binary + config + DB.            |
| `NO_SERVICE`    | unset                 | Skip service unit install — run manually instead. |
| `SKIP_CHECKSUM` | unset                 | Skip sha256 verification (not recommended).       |

## Manual install

If you prefer to not run `install.sh`:

1. Download the zip for your platform from the [releases page](https://github.com/agiterra/wire/releases).
2. Verify against `SHA256SUMS`: `shasum -a 256 wire-<platform>.zip`.
3. Unzip and `chmod +x wire-<platform>`.
4. Run directly: `./wire-<platform>` (reads env from `~/.wire/.env`).

## Upgrading

Re-run the installer:

```bash
curl -fsSL https://raw.githubusercontent.com/agiterra/wire/main/scripts/install.sh | bash
```

The binary is replaced, the service is reloaded, config and DB are preserved.

## Uninstalling

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/com.wire.gateway.plist
rm ~/Library/LaunchAgents/com.wire.gateway.plist

# Linux
systemctl --user disable --now wire.service
rm ~/.config/systemd/user/wire.service

# Common
rm -rf ~/.wire   # removes binary, config, DB, logs
```

## Health check

```bash
curl -fsS http://localhost:9800/health
# {"status":"ok","ts":...}
```

## Logs

```bash
tail -f ~/.wire/wire.log
```

## Service controls

**macOS:**

```bash
launchctl list | grep com.wire.gateway          # is it running?
launchctl kickstart -k gui/$UID/com.wire.gateway # restart
launchctl stop  com.wire.gateway
launchctl start com.wire.gateway
```

**Linux:**

```bash
systemctl --user status  wire
systemctl --user restart wire
systemctl --user stop    wire
systemctl --user start   wire
```
