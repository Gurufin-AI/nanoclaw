#!/usr/bin/env bash
# Checks the WSL -> Docker published ports, not merely container health.
# Installed by the operator as a user systemd timer; see docs/onecli-watchdog.md.
set -euo pipefail
export LC_ALL=C
state_dir="${STATE_DIRECTORY:?systemd StateDirectory is required}"
mkdir -p "$state_dir"
exec 9>"$state_dir/lock"
flock -n 9 || exit 0

reset_failures() { printf '0\n' > "$state_dir/failures"; }
read_number() {
  local value=0
  if [[ -f "$1" ]]; then read -r value < "$1" || true; fi
  if [[ ! "$value" =~ ^[0-9]{1,10}$ ]]; then value=0; fi
  printf '%s' "$value"
}

# Respect intentional service/container shutdown. A missing Docker integration
# is diagnosed, not repaired by restarting the entire desktop/WSL instance.
if ! systemctl --user is-active --quiet nanoclaw.service; then
  reset_failures
  exit 0
fi
if ! timeout 10 docker info >/dev/null 2>&1; then
  echo 'Docker unavailable; no recovery attempted'
  reset_failures
  exit 0
fi
running=$(timeout 10 docker inspect --format '{{.State.Running}}' onecli 2>/dev/null) || {
  echo 'OneCLI container missing; no recovery attempted'
  reset_failures
  exit 0
}
if [[ "$running" != true ]]; then
  reset_failures
  exit 0
fi

if curl --noproxy '*' --fail --silent --show-error --max-time 5 http://127.0.0.1:10254/v1/health >/dev/null 2>&1 &&
   curl --noproxy '*' --fail --silent --show-error --max-time 5 http://127.0.0.1:10255/healthz >/dev/null 2>&1; then
  if (( $(read_number "$state_dir/failures") > 0 )); then echo 'OneCLI host connectivity recovered'; fi
  reset_failures
  exit 0
fi

failures=$(read_number "$state_dir/failures")
failures=$((failures + 1))
printf '%s\n' "$failures" > "$state_dir/failures"
echo "OneCLI host connectivity failed ($failures consecutive checks)"
if (( failures < 3 )); then exit 0; fi

now=$(date +%s)
last=$(read_number "$state_dir/last-restart")
if (( last > 0 && now - last < 900 )); then
  echo 'Restart cooldown active; no recovery attempted'
  exit 0
fi
# Re-check intentional shutdown immediately before changing anything.
systemctl --user is-active --quiet nanoclaw.service || exit 0
[[ $(timeout 10 docker inspect --format '{{.State.Running}}' onecli) == true ]] || exit 0
# Stamp before the attempt: even a failed/hung restart must be rate limited.
printf '%s\n' "$now" > "$state_dir/last-restart"
echo 'Restarting only OneCLI to restore published-port connectivity'
timeout 45 docker restart -t 10 onecli
reset_failures
# Next timer run verifies recovery. NanoClaw retries its own queue; never
# restart the host, LLM, database, or agent containers here.
