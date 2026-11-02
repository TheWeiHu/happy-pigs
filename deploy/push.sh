#!/usr/bin/env bash
set -euo pipefail
: "${HAPPY_PIGS_SSH_TARGET:?Set HAPPY_PIGS_SSH_TARGET to the configured AWS host}"
ssh_opts=()
if [[ -n "${HAPPY_PIGS_SSH_KEY:-}" ]]; then ssh_opts=(-i "$HAPPY_PIGS_SSH_KEY"); fi
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
if [[ -n "$(git status --porcelain)" ]]; then echo 'Commit the release before deploying.' >&2; exit 1; fi
release=$(git rev-parse HEAD)
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT
git archive --format=tar "$release" > "$archive"
ssh "${ssh_opts[@]}" "$HAPPY_PIGS_SSH_TARGET" "test ! -e /opt/happy-pigs/releases/$release && sudo install -d -o \"\$(id -un)\" /opt/happy-pigs/releases/$release"
ssh "${ssh_opts[@]}" "$HAPPY_PIGS_SSH_TARGET" "tar -xf - -C /opt/happy-pigs/releases/$release" < "$archive"
ssh "${ssh_opts[@]}" "$HAPPY_PIGS_SSH_TARGET" bash -s -- "$release" <<'REMOTE'
set -euo pipefail
release=$1
export PATH=/opt/happy-pigs/node/bin:$PATH
cd "/opt/happy-pigs/releases/$release"
npm ci --omit=dev --no-audit --no-fund
npm run build
printf '%s\n' "$release" > RELEASE
previous=$(readlink -f /opt/happy-pigs/current || true)
sudo chown -R root:root "/opt/happy-pigs/releases/$release"
sudo ln -sfn "/opt/happy-pigs/releases/$release" /opt/happy-pigs/next
sudo mv -Tf /opt/happy-pigs/next /opt/happy-pigs/current
sudo systemctl restart happy-pigs
for attempt in $(seq 1 20); do
    if curl --fail --silent http://127.0.0.1:8791/health >/dev/null; then echo "Deployed $release"; exit 0; fi
    sleep 1
done
if [[ -n "$previous" ]]; then
    sudo ln -sfn "$previous" /opt/happy-pigs/next
    sudo mv -Tf /opt/happy-pigs/next /opt/happy-pigs/current
    sudo systemctl restart happy-pigs
fi
echo 'Health check failed; restored the previous release.' >&2
exit 1
REMOTE
