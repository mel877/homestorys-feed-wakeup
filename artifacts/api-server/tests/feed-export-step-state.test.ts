import { describe, expect, it } from "vitest";
import {
  claimStep,
  completeStep,
  failStep,
  isClaimable,
  type FeedExportStepState,
} from "../src/jobs/feed-export-step-state";

const now = new Date("2026-08-29T16:00:00.000Z");

function step(overrides: Partial<FeedExportStepState> = {}): FeedExportStepState {
  return {
    status: "pending",
    attempts: 0,
    availableAt: null,
    leaseExpiresAt: null,
    leaseOwner: null,
    ...overrides,
  };
}

describe("feed export step state", () => {
  it("claims a pending step and establishes a lease", () => {
    const claimed = claimStep(step(), "worker-a", now, 30_000);

    expect(claimed).toMatchObject({
      status: "running",
      attempts: 1,
      leaseOwner: "worker-a",
    });
    expect(claimed.leaseExpiresAt?.toISOString()).toBe("2026-08-29T16:00:30.000Z");
  });

  it("can reclaim an expired running step but not a live lease", () => {
    expect(
      isClaimable(
        step({
          status: "running",
          leaseOwner: "old-worker",
          leaseExpiresAt: new Date("2026-08-29T15:59:59.000Z"),
        }),
        now,
      ),
    ).toBe(true);

    expect(
      isClaimable(
        step({
          status: "running",
          leaseOwner: "live-worker",
          leaseExpiresAt: new Date("2026-08-29T16:00:01.000Z"),
        }),
        now,
      ),
    ).toBe(false);
  });

  it("completes a step and clears its lease", () => {
    const completed = completeStep(
      step({
        status: "running",
        attempts: 2,
        leaseOwner: "worker-a",
        leaseExpiresAt: new Date("2026-08-29T16:00:30.000Z"),
      }),
      "worker-a",
      now,
    );

    expect(completed).toMatchObject({
      status: "completed",
      attempts: 2,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(completed.completedAt?.toISOString()).toBe("2026-08-29T16:00:00.000Z");
  });

  it("schedules retry with bounded exponential backoff", () => {
    const failed = failStep(
      step({
        status: "running",
        attempts: 2,
        leaseOwner: "worker-a",
        leaseExpiresAt: new Date("2026-08-29T16:00:30.000Z"),
      }),
      "worker-a",
      now,
      "temporary storage failure",
      5,
    );

    expect(failed).toMatchObject({
      status: "pending",
      attempts: 2,
      lastError: "temporary storage failure",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(failed.availableAt?.toISOString()).toBe("2026-08-29T16:01:00.000Z");
  });

  it("marks a step permanently failed after the retry limit", () => {
    const failed = failStep(
      step({
        status: "running",
        attempts: 5,
        leaseOwner: "worker-a",
        leaseExpiresAt: new Date("2026-08-29T16:00:30.000Z"),
      }),
      "worker-a",
      now,
      "permanent validation failure",
      5,
    );

    expect(failed).toMatchObject({
      status: "failed",
      attempts: 5,
      lastError: "permanent validation failure",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(failed.availableAt).toBeNull();
  });
});