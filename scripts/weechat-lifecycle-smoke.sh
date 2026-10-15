#!/usr/bin/env bash
# Credential-free Docker gate. No external network, host files, or credentials.
# Direct-app SIGTERM is primary; standard PID-1 SIGTERM is a separate comparison.
set -euo pipefail
image=${1:-cuse:validation}
name="cuse-lifecycle-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$"
cleanup() {
  status=$?
  if (( status != 0 )); then docker logs "$name" >&2 || true; fi
  docker rm --force "$name" >/dev/null 2>&1 || true
  for target in app pid1; do docker volume rm "${name}-${target}" >/dev/null 2>&1 || true; done
  exit "$status"
}
trap cleanup EXIT
for target in app pid1; do
  volume="${name}-${target}"
  docker volume create "$volume" >/dev/null
  for generation in first second; do
    # The exact installed tsx CLI/config from cuse-entrypoint. No init wrapper.
    docker run --detach --name "$name" --network none \
      --mount "type=volume,source=$volume,target=/lifecycle" \
      --env "CUSE_LIFECYCLE_GENERATION=$generation" \
      --entrypoint /app/node_modules/.bin/tsx "$image" \
      --tsconfig /app/tsconfig.json /app/cuse/weechat-lifecycle-smoke.mts >/dev/null
    timeout 75 docker exec "$name" node /app/cuse/weechat-lifecycle-check.mjs ready "$generation"
    if [[ $target == pid1 ]]; then
      # Ordinary container SIGTERM with a generous grace period, never pause.
      timeout 40 docker stop --time 30 "$name" >/dev/null
    else
      # The exec may be torn down as tsx exits; final status/evidence is decisive.
      result=0
      timeout 10 docker exec "$name" node /app/cuse/weechat-lifecycle-check.mjs stop-app "$generation" || result=$?
      [[ $result == 0 || $result == 137 ]]
    fi
    test "$(timeout 40 docker wait "$name")" = 0
    test "$(docker inspect --format '{{.State.ExitCode}}' "$name")" = 0
    docker logs "$name"
    docker run --rm --network none \
      --mount "type=volume,source=$volume,target=/lifecycle,readonly" \
      --entrypoint node "$image" /app/cuse/weechat-lifecycle-check.mjs verify-closed "$generation"
    docker rm "$name" >/dev/null
    echo "Lifecycle verified: signal target=$target, generation=$generation, native/bridge processes reaped, locks=0, container exit=0"
  done
done
echo 'Native lifecycle gate passed: PID-1 and direct-app SIGTERM, clean shutdown, same-volume recovery; no retained-console claim.'
