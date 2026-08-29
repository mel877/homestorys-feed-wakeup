export type FeedExportStepStatus = "pending" | "running" | "completed" | "failed";

export interface FeedExportStepState {
  status: FeedExportStepStatus;
  attempts: number;
  availableAt: Date | null;
  leaseExpiresAt: Date | null;
  leaseOwner: string | null;
  completedAt?: Date | null;
  lastError?: string | null;
}

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 60 * 60 * 1_000;

export function isClaimable(step: FeedExportStepState, now: Date): boolean {
  if (step.status === "pending") {
    return step.availableAt === null || step.availableAt.getTime() <= now.getTime();
  }
  return (
    step.status === "running" &&
    step.leaseExpiresAt !== null &&
    step.leaseExpiresAt.getTime() <= now.getTime()
  );
}

export function claimStep(
  step: FeedExportStepState,
  workerId: string,
  now: Date,
  leaseMs: number,
): FeedExportStepState {
  if (!isClaimable(step, now)) {
    throw new Error("Feed export step is not claimable");
  }
  return {
    ...step,
    status: "running",
    attempts: step.attempts + 1,
    availableAt: null,
    leaseOwner: workerId,
    leaseExpiresAt: new Date(now.getTime() + leaseMs),
    lastError: null,
  };
}

export function completeStep(
  step: FeedExportStepState,
  workerId: string,
  now: Date,
): FeedExportStepState {
  assertLeaseOwner(step, workerId);
  return {
    ...step,
    status: "completed",
    leaseOwner: null,
    leaseExpiresAt: null,
    availableAt: null,
    completedAt: now,
    lastError: null,
  };
}

export function failStep(
  step: FeedExportStepState,
  workerId: string,
  now: Date,
  error: string,
  maxAttempts: number,
): FeedExportStepState {
  assertLeaseOwner(step, workerId);
  const exhausted = step.attempts >= maxAttempts;
  const backoffMs = Math.min(
    RETRY_BASE_MS * Math.pow(2, Math.max(0, step.attempts - 1)),
    RETRY_MAX_MS,
  );
  return {
    ...step,
    status: exhausted ? "failed" : "pending",
    availableAt: exhausted ? null : new Date(now.getTime() + backoffMs),
    leaseOwner: null,
    leaseExpiresAt: null,
    completedAt: null,
    lastError: error,
  };
}

function assertLeaseOwner(step: FeedExportStepState, workerId: string): void {
  if (step.status !== "running" || step.leaseOwner !== workerId) {
    throw new Error("Feed export step lease is not owned by this worker");
  }
}