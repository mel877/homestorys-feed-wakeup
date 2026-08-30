#!/usr/bin/env bash
set -euo pipefail

test -n "${NIGHTLY_CYCLE_URL:-}"
test -n "${INTERNAL_API_SECRET:-}"

cycle_key="${REQUESTED_CYCLE_KEY:-$(date -u +%F)}"
deadline=$((SECONDS + 10740))

while (( SECONDS < deadline )); do
  response_file="$(mktemp)"
  trap 'rm -f "$response_file"' EXIT

  http_code="$(
    curl --silent --show-error \
      --max-time 45 \
      --output "$response_file" \
      --write-out '%{http_code}' \
      -X POST "$NIGHTLY_CYCLE_URL" \
      -H "Authorization: Bearer $INTERNAL_API_SECRET" \
      -H "Content-Type: application/json" \
      --data "{\"cycleKey\":\"$cycle_key\"}"
  )" || http_code="000"

  if [[ "$http_code" == "502" || "$http_code" == "503" || "$http_code" == "504" || "$http_code" == "000" ]]; then
    echo "Transient HTTP $http_code while advancing cycle $cycle_key; retrying"
    rm -f "$response_file"
    trap - EXIT
    sleep 10
    continue
  fi

  if [[ ! "$http_code" =~ ^2[0-9][0-9]$ ]]; then
    echo "Nightly cycle returned HTTP $http_code" >&2
    cat "$response_file" >&2
    exit 1
  fi

  if ! jq -e . "$response_file" >/dev/null 2>&1; then
    echo "Nightly cycle returned invalid JSON with HTTP $http_code" >&2
    cat "$response_file" >&2
    exit 1
  fi

  status="$(jq -r '.status // "failed"' "$response_file")"
  phase="$(jq -r '.phase // "unknown"' "$response_file")"
  echo "Nightly cycle status=$status phase=$phase"

  case "$status" in
    completed)
      exit 0
      ;;
    failed)
      jq . "$response_file"
      exit 1
      ;;
    running)
      ;;
    idle)
      sleep 10
      ;;
    *)
      jq . "$response_file"
      exit 1
      ;;
  esac

  rm -f "$response_file"
  trap - EXIT
done

echo "Nightly cycle exceeded its three-hour watchdog" >&2
exit 1