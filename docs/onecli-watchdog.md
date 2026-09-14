# WSL OneCLI connectivity recovery

On 2026-09-13 a WSL package update restarted WSL without rebooting Windows.
NanoClaw and llama.cpp restarted successfully, but WSL connections to the
OneCLI published port were reset even though its container health was green.
Restarting only `onecli` restored connectivity and NanoClaw resumed queued work.

The local user service `nanoclaw-onecli-watchdog.service` runs an installed copy
of `scripts/onecli-connectivity-watchdog.sh` once per minute. It checks both
`127.0.0.1:10254/v1/health` and `127.0.0.1:10255/healthz` from WSL, bypassing
HTTP proxy environment settings. After three failed checks it restarts only
`onecli`, with a persistent 15-minute minimum interval between attempts.
Recovery is verified on subsequent checks. Existing queued work can resume
automatically and several reports may arrive together.

It does nothing when NanoClaw is inactive or OneCLI is stopped/missing. If
Docker is unavailable it logs the problem; it does not restart Windows, WSL,
Docker Desktop, PostgreSQL, llama.cpp, or NanoClaw. This addresses the observed
published-port failure, not every possible startup failure. It runs only while
WSL and the user's systemd manager are running. The install uses the existing
Docker group through `sg`, like the NanoClaw host service.

## Installed paths and management

- Script: `~/.local/libexec/nanoclaw/onecli-connectivity-watchdog.sh`
- Units: `~/.config/systemd/user/nanoclaw-onecli-watchdog.{service,timer}`
- Private counters: `~/.local/state/nanoclaw-onecli-watchdog/`

```bash
systemctl --user status nanoclaw-onecli-watchdog.timer
journalctl --user -u nanoclaw-onecli-watchdog.service -n 40 --no-pager
# Run one check (may recover after the third consecutive failure):
systemctl --user start nanoclaw-onecli-watchdog.service
# Disable automatic recovery before intentional gateway maintenance:
systemctl --user disable --now nanoclaw-onecli-watchdog.timer
# Re-enable:
systemctl --user enable --now nanoclaw-onecli-watchdog.timer
```

Source changes require reinstalling the script; the timer deliberately does not
execute mutable checkout code. The installed units are local machine settings,
not part of the NanoClaw main service. No host build or agent restart is needed.

## Install or update (from the checkout root)

Requires user systemd, `bash`, `curl`, `timeout`, `flock`, Docker CLI and membership
in the `docker` group. Existing user lingering enables startup with WSL.

```bash
node --test scripts/onecli-connectivity-watchdog.test.mjs
systemd-analyze --user verify scripts/nanoclaw-onecli-watchdog.service scripts/nanoclaw-onecli-watchdog.timer
install -D -m 0755 scripts/onecli-connectivity-watchdog.sh "$HOME/.local/libexec/nanoclaw/onecli-connectivity-watchdog.sh"
install -D -m 0644 scripts/nanoclaw-onecli-watchdog.service "$HOME/.config/systemd/user/nanoclaw-onecli-watchdog.service"
install -D -m 0644 scripts/nanoclaw-onecli-watchdog.timer "$HOME/.config/systemd/user/nanoclaw-onecli-watchdog.timer"
systemctl --user daemon-reload
systemctl --user enable --now nanoclaw-onecli-watchdog.timer
```

Tests mock Docker and HTTP failures: they do not interrupt the real gateway.
The timer starts after boot (two-minute grace) and runs 60 seconds after each
check finishes, with up to five seconds of timer coalescing. Three failed checks
therefore normally trigger recovery in a few minutes, not immediately.
