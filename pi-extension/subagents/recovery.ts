export const MIN_RECOVERY_DELAY_MS = 10_000;
export const DEFAULT_RECOVERY_DELAYS = [30_000, 60_000, 90_000] as const;

export type RecoveryDelays = readonly [number, number, number];
export type RecoveryStage = "waiting" | "nudged" | "escalated" | "killed";
export type RecoveryAction = "nudge" | "escalate" | "kill" | null;

export interface RecoveryState {
  stage: RecoveryStage;
  stageSince: number;
}

export interface RecoveryAdvance {
  state: RecoveryState | undefined;
  action: RecoveryAction;
}

function defaultRecoveryDelays(): RecoveryDelays {
  return [...DEFAULT_RECOVERY_DELAYS];
}

export const DEFAULT_ACTIVE_TOOL_STALL_MS = 600_000;

/** Parse PI_SUBAGENT_ACTIVE_TOOL_STALL_MS without reading process.env; 0 disables. */
export function parseActiveToolStallMs(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_ACTIVE_TOOL_STALL_MS;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 0) return DEFAULT_ACTIVE_TOOL_STALL_MS;
  return value;
}

/** Parse PI_SUBAGENT_RECOVERY_DELAYS_MS without reading process.env. */
export function parseRecoveryDelays(raw: string | undefined): RecoveryDelays {
  const parts = raw?.split(",").map((part) => part.trim());
  if (!parts || parts.length !== 3 || parts.some((part) => !part)) {
    return defaultRecoveryDelays();
  }

  const values = parts.map(Number);
  if (values.some((value) => !Number.isSafeInteger(value))) {
    return defaultRecoveryDelays();
  }

  return values.map((value) => Math.max(MIN_RECOVERY_DELAY_MS, value)) as RecoveryDelays;
}

/** Advance one stalled-child recovery tick using the caller's clock. */
export function advanceRecoveryLadder(
  state: RecoveryState | undefined,
  input: { now: number; stalled: boolean; exempt: boolean; delays: RecoveryDelays },
): RecoveryAdvance {
  if (state?.stage === "killed") return { state, action: null };
  if (!input.stalled || input.exempt) return { state: undefined, action: null };
  if (!state) return { state: { stage: "waiting", stageSince: input.now }, action: null };

  const elapsed = Math.max(0, input.now - state.stageSince);
  if (state.stage === "waiting" && elapsed >= input.delays[0]) {
    return { state: { stage: "nudged", stageSince: input.now }, action: "nudge" };
  }
  if (state.stage === "nudged" && elapsed >= input.delays[1]) {
    return { state: { stage: "escalated", stageSince: input.now }, action: "escalate" };
  }
  if (state.stage === "escalated" && elapsed >= input.delays[2]) {
    return { state: { stage: "killed", stageSince: input.now }, action: "kill" };
  }
  return { state, action: null };
}

export function formatRecoveryKillError(elapsedMs: number): string {
  return `Subagent recovery-kill after ${Math.floor(Math.max(0, elapsedMs) / 1000)}s.`;
}
