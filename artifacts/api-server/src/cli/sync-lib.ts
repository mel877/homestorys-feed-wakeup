/**
 * Shared helper for sync CLI commands.
 *
 * Calls the internal sync API and polls for completion, printing progress
 * to stdout. Exits 0 on success, 1 on failure.
 */

type SyncType = "full" | "inventory" | "prices";

const BASE_URL =
  process.env["APP_BASE_URL"] ?? `http://localhost:${process.env["PORT"] ?? "3000"}`;

function getSecret(): string {
  const secret = process.env["INTERNAL_API_SECRET"];
  if (!secret) {
    throw new Error(
      "INTERNAL_API_SECRET is not set. " +
        "Set this environment variable to authenticate with the internal API.",
    );
  }
  return secret;
}

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${getSecret()}`,
  };
}

export async function triggerSyncJob(type: SyncType): Promise<void> {
  console.log(`\n🚀 Triggering ${type} sync via internal API...`);
  console.log(`   API base: ${BASE_URL}`);

  // Trigger the job
  const triggerRes = await fetch(`${BASE_URL}/api/internal/sync/${type}`, {
    method: "POST",
    headers: headers(),
  });

  if (!triggerRes.ok) {
    const text = await triggerRes.text().catch(() => "");
    throw new Error(
      `API returned ${triggerRes.status}: ${text}. ` +
        "Check that the server is running and INTERNAL_API_SECRET is correct.",
    );
  }

  const { status, message } = (await triggerRes.json()) as {
    status: string;
    message: string;
  };

  console.log(`   ✔ ${message} (status: ${status})`);
  console.log("\n   Sync is running in the background.");
  console.log(
    "   Poll GET /api/internal/runs for progress (requires INTERNAL_API_SECRET).",
  );
  console.log(
    "   Or watch the server logs for real-time updates.\n",
  );
}

/**
 * Poll the runs endpoint until the most recent run of a given type completes.
 * Used for testing / scripted waits; not called by the standard CLI scripts.
 */
export async function waitForRun(
  type: SyncType,
  timeoutMs = 10 * 60 * 1_000,
): Promise<{ status: string; runId: string }> {
  const deadline = Date.now() + timeoutMs;
  const POLL_INTERVAL_MS = 5_000;

  while (Date.now() < deadline) {
    const res = await fetch(`${BASE_URL}/api/internal/runs?limit=5`, {
      headers: headers(),
    });
    if (!res.ok) throw new Error(`Runs endpoint returned ${res.status}`);

    const { runs } = (await res.json()) as {
      runs: Array<{ id: string; runType: string; status: string }>;
    };

    const run = runs.find((r) => r.runType === type);
    if (run && run.status !== "running") {
      return { status: run.status, runId: run.id };
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(`Timed out waiting for ${type} sync to complete`);
}
