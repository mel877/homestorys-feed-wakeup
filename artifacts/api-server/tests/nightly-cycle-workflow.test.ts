import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../../../.github/workflows/feed-pump.yml", import.meta.url),
  "utf8",
);
const scheduler = readFileSync(
  new URL("../src/jobs/scheduler.ts", import.meta.url),
  "utf8",
);
const runnerPath = new URL(
  "../../../.github/scripts/run-nightly-cycle.sh",
  import.meta.url,
);
const runner = readFileSync(runnerPath, "utf8");

function runWorkflowRunner(responses: Array<{ code: number; body: string }>) {
  const binDir = mkdtempSync(join(tmpdir(), "nightly-cycle-bin-"));
  const stateFile = join(binDir, "curl-state");
  const responsesFile = join(binDir, "responses");
  writeFileSync(
    responsesFile,
    responses.map((response) => `${response.code}\t${response.body}`).join("\n"),
  );
  writeFileSync(
    join(binDir, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
count=0
[[ -f "$FAKE_CURL_STATE" ]] && count="$(cat "$FAKE_CURL_STATE")"
count=$((count + 1))
echo "$count" > "$FAKE_CURL_STATE"
line="$(sed -n "\${count}p" "$FAKE_CURL_RESPONSES")"
code="\${line%%$'\\t'*}"
body="\${line#*$'\\t'}"
output_file=""
while (($#)); do
  if [[ "$1" == "--output" ]]; then
    output_file="$2"
    shift 2
  else
    shift
  fi
done
printf '%s' "$body" > "$output_file"
printf '%s' "$code"
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(binDir, "sleep"),
    "#!/usr/bin/env bash\nexit 0\n",
    { mode: 0o755 },
  );

  const result = spawnSync("bash", [runnerPath.pathname], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      NIGHTLY_CYCLE_URL: "https://example.test/nightly-cycle",
      INTERNAL_API_SECRET: "test-secret",
      REQUESTED_CYCLE_KEY: "2026-08-30",
      FAKE_CURL_STATE: stateFile,
      FAKE_CURL_RESPONSES: responsesFile,
    },
  });
  const calls = Number(readFileSync(stateFile, "utf8"));
  return { ...result, calls };
}

describe("nightly GitHub workflow", () => {
  it("runs once at 02:00 UTC with explicit non-overlapping concurrency", () => {
    expect(workflow).toContain('cron: "0 2 * * *"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("group: durable-nightly-feed-cycle");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("timeout-minutes: 180");
    expect(workflow).not.toContain("*/30");
  });

  it("advances one protected endpoint sequentially until completion or failure", () => {
    expect(workflow).toContain(".github/scripts/run-nightly-cycle.sh");
    expect(workflow).toContain("NIGHTLY_CYCLE_URL");
    expect(runner).toContain("Authorization: Bearer $INTERNAL_API_SECRET");
    expect(workflow).not.toContain("&\n");
  });

  it("retries an HTML 504 response without sending it to jq", () => {
    const result = runWorkflowRunner([
      { code: 504, body: "<html>Gateway timeout</html>" },
      { code: 200, body: '{"status":"completed","phase":"feeds"}' },
    ]);

    expect(result.status).toBe(0);
    expect(result.calls).toBe(2);
    expect(result.stdout).toContain("Transient HTTP 504");
    expect(result.stdout).toContain("Nightly cycle status=completed phase=feeds");
    expect(result.stderr).not.toContain("parse error");
  });

  it("parses a successful JSON response and finishes normally", () => {
    const result = runWorkflowRunner([
      { code: 200, body: '{"status":"completed","phase":"feeds"}' },
    ]);

    expect(result.status).toBe(0);
    expect(result.calls).toBe(1);
    expect(result.stdout).toContain("Nightly cycle status=completed phase=feeds");
  });

  it("leaves no competing scheduled Shopify batch or direct export", () => {
    expect(scheduler).not.toContain('name: "full-sync"');
    expect(scheduler).not.toContain('name: "inventory-sync"');
    expect(scheduler).not.toContain('name: "price-sync"');
    expect(scheduler).not.toContain('name: "google-export"');
  });
});