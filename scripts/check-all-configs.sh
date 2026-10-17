#!/usr/bin/env bash
# Runs `oracle check` against the fixture in every supported configuration:
# clean, then each defect flag alone. For each, restarts the fixture's
# order-service with FIXTURE_DEFECTS set, waits for health and for the flag
# to be reported, and runs the check. Exits non-zero if any configuration
# fails.
#
#   FIXTURE_DIR   path to the fixture-order-service checkout (default ../fixture-order-service)
#   TARGET        oracle target directory (default corpus/fixture-order-service)
#   CONFIGS       space-separated subset to run (default: clean and every flag in oracle.yaml)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="${FIXTURE_DIR:-$ROOT/../fixture-order-service}"
TARGET="${TARGET:-$ROOT/corpus/fixture-order-service}"
BASE_URL="${BASE_URL:-http://localhost:4000}"

if [[ ! -f "$FIXTURE_DIR/docker-compose.yml" ]]; then
  echo "fixture not found at $FIXTURE_DIR (set FIXTURE_DIR)" >&2
  exit 2
fi

if [[ -z "${CONFIGS:-}" ]]; then
  flags=$(sed -n '/^defect_flags:/,/^[^ -]/p' "$TARGET/oracle.yaml" | sed -n 's/^ *- *\([A-Za-z0-9_]*\).*/\1/p')
  CONFIGS="clean $flags"
fi

FIXTURE_SHA="$(git -C "$FIXTURE_DIR" rev-parse HEAD)"
cd "$ROOT" || exit 2
npm run --silent build || exit 2

wait_for() {
  local want="$1"
  for _ in $(seq 1 60); do
    if version=$(curl -fsS "$BASE_URL/__control/version" 2>/dev/null); then
      active=$(node -e 'const v=JSON.parse(process.argv[1]); console.log((v.defects||[]).join(",") || "clean")' "$version")
      [[ "$active" == "$want" ]] && return 0
    fi
    sleep 1
  done
  echo "order-service did not come up as $want" >&2
  return 1
}

declare -A results
status=0
for config in $CONFIGS; do
  defects=""
  [[ "$config" != "clean" ]] && defects="$config"
  echo "=== $config"
  (cd "$FIXTURE_DIR" && FIXTURE_DEFECTS="$defects" GIT_SHA="$FIXTURE_SHA" docker compose up -d --build order-service >/dev/null 2>&1)
  if ! wait_for "$config"; then
    results[$config]="startup failed"
    status=1
    continue
  fi
  node dist/cli/main.js check --target "$TARGET" --config "$config"
  code=$?
  results[$config]="exit $code"
  [[ $code -ne 0 ]] && status=1
  echo
done

# Leave the fixture clean.
(cd "$FIXTURE_DIR" && FIXTURE_DEFECTS="" GIT_SHA="$FIXTURE_SHA" docker compose up -d order-service >/dev/null 2>&1)

echo "=== summary"
for config in $CONFIGS; do
  printf '  %-34s %s\n' "$config" "${results[$config]}"
done
exit $status
