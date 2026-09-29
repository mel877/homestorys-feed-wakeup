#!/usr/bin/env bash
set -euo pipefail

test -n "${NIGHTLY_CYCLE_URL:-}"
test -n "${INTERNAL_API_SECRET:-}"

cycle_key="${REQUESTED_CYCLE_KEY:-}"
if [[ -z "$cycle_key" ]]; then
  cycle_key="$(date -u +%F)"
fi
if ! [[ "$cycle_key" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "Invalid cycle key: $cycle_key" >&2
  exit 1
fi

watchdog_seconds="${NIGHTLY_WATCHDOG_SECONDS:-17400}"
deadline=$((SECONDS + watchdog_seconds))
response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT
last_line=""

echo "Starting durable nightly cycle: $cycle_key"

while (( SECONDS < deadline )); do
  : > "$response_file"
  http_code="$(
    curl --silent --show-error \
      --max-time 180 \
      --connect-timeout 15 \
      --output "$response_file" \
      --write-out '%{http_code}' \
      -X POST "$NIGHTLY_CYCLE_URL" \
      -H "Authorization: Bearer $INTERNAL_API_SECRET" \
      -H "Content-Type: application/json" \
      --data "{\"cycleKey\":\"$cycle_key\"}"
  )" || http_code="000"

  is_json=false
  if jq -e . "$response_file" >/dev/null 2>&1; then
    is_json=true
  fi

  # A JSON body that reports a failure is final, whatever the status code.
  if [[ "$is_json" == true ]] && [[ "$(jq -r '.status // empty' "$response_file")" == "failed" ]] \
    && [[ "$http_code" =~ ^(2[0-9][0-9]|500)$ ]]; then
    echo "::error::Durable nightly cycle reported failure (HTTP $http_code)"
    jq . "$response_file"
    exit 1
  fi

  if [[ "$http_code" == "000" || "$http_code" =~ ^5[0-9][0-9]$ ]]; then
    echo "Transient HTTP $http_code while advancing cycle $cycle_key; retrying"
    if [[ "$is_json" == true ]]; then jq -c . "$response_file"; fi
    sleep 10
    continue
  fi

  if [[ ! "$http_code" =~ ^2[0-9][0-9]$ ]]; then
    echo "Nightly cycle returned HTTP $http_code" >&2
    cat "$response_file" >&2
    exit 1
  fi

  if [[ "$is_json" != true ]]; then
    echo "Nightly cycle returned invalid JSON with HTTP $http_code; retrying"
    sleep 10
    continue
  fi

  status="$(jq -r '.status // "missing"' "$response_file")"
  phase="$(jq -r '.phase // "unknown"' "$response_file")"
  detail="$(jq -r '[
      (if .summary then "steps=\(.summary.completed)/\(.summary.total) pending=\(.summary.pending) running=\(.summary.running)" else empty end),
      (if .blockingFeedRunId then "blockingFeedRunId=\(.blockingFeedRunId)" else empty end),
      (if .error then "error=\(.error)" else empty end)
    ] | join(" ")' "$response_file")"
  line="Nightly cycle status=$status phase=$phase${detail:+ $detail}"
  if [[ "$line" != "$last_line" ]]; then
    echo "$line"
    last_line="$line"
  fi

  case "$status" in
    completed)
      jq -r '.unpublishedFiles // [] | .[] | "::warning::Feed \(.fileKey) was not published (\(.result))"' "$response_file"
      echo "Durable nightly cycle completed successfully."
      exit 0
      ;;
    running)
      sleep 1
      ;;
    idle)
      sleep 10
      ;;
    *)
      echo "Unexpected cycle status: $status" >&2
      jq . "$response_file" >&2
      exit 1
      ;;
  esac
done

echo "::error::Nightly cycle exceeded its ${watchdog_seconds}s watchdog" >&2
jq . "$response_file" >&2 || true
exit 1
