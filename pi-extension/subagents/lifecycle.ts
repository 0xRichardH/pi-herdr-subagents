import type { ActivityReadResult, SubagentActivityScope } from "./activity.ts";
import type { CompletionResult } from "./completion.ts";

export type ProcessState =
  | { kind: "starting"; startedAt: number }
  | { kind: "running"; startedAt: number; confirmedAt: number }
  | { kind: "finalizing"; startedAt: number; detectedAt: number; completion: CompletionResult }
  | { kind: "completed"; startedAt: number; detectedAt: number; completedAt: number; completion: CompletionResult }
  | { kind: "failed"; startedAt: number; detectedAt: number; completedAt: number; error: string; exitCode?: number };

export type TurnState =
  | { kind: "unknown" }
  | { kind: "starting"; observedAt: number }
  | { kind: "active"; startedAt: number; scope: SubagentActivityScope; label?: string }
  | { kind: "waiting"; startedAt: number }
  | { kind: "interrupted"; requestedAt: number; previousActivitySequence: number | null };

export type ActivityHealth =
  | { kind: "unseen" }
  | { kind: "healthy"; observedAt: number }
  | { kind: "problem"; reason: "missing" | "invalid" | "wrong-id"; since: number; error?: string };

export type PaneObservation =
  | { kind: "unknown" }
  | { kind: "present"; observedAt: number }
  | { kind: "read-error"; firstFailedAt: number; lastFailedAt: number; consecutiveFailures: number; error?: string }
  | { kind: "missing"; detectedAt: number; error?: string };

export type CompletionDelivery = "pending" | "delivered" | "suppressed";

export interface SubagentLifecycle {
  process: ProcessState;
  turn: TurnState;
  activityHealth: ActivityHealth;
  pane: PaneObservation;
  lastActivitySequence: number | null;
  delivery: CompletionDelivery;
}

export interface LifecycleProjection {
  kind: "starting" | "running" | "active" | "waiting" | "interrupted" | "stalled" | "finalizing" | "completed" | "failed";
  label?: string;
  runtimeEndedAt?: number;
  stateDurationSince?: number;
}

export function createLifecycle(startedAt: number): SubagentLifecycle {
  return {
    process: { kind: "starting", startedAt },
    turn: { kind: "unknown" },
    activityHealth: { kind: "unseen" },
    pane: { kind: "unknown" },
    lastActivitySequence: null,
    delivery: "pending",
  };
}

function isTerminal(process: ProcessState): boolean {
  return process.kind === "completed" || process.kind === "failed";
}

function startedAt(process: ProcessState): number {
  return process.startedAt;
}

export function observeActivity(
  lifecycle: SubagentLifecycle,
  read: ActivityReadResult,
  observedAt: number,
): SubagentLifecycle {
  if (lifecycle.process.kind === "finalizing" || isTerminal(lifecycle.process)) return lifecycle;

  if (!read.ok) {
    const since = lifecycle.activityHealth.kind === "problem"
      ? lifecycle.activityHealth.since
      : observedAt;
    return {
      ...lifecycle,
      activityHealth: { kind: "problem", reason: read.reason, since, ...(read.error ? { error: read.error } : {}) },
    };
  }

  const activity = read.activity;
  if (lifecycle.lastActivitySequence != null && activity.sequence < lifecycle.lastActivitySequence) return lifecycle;
  if (lifecycle.turn.kind === "interrupted") {
    const staleInterruptSnapshot = activity.updatedAt < lifecycle.turn.requestedAt ||
      (activity.updatedAt === lifecycle.turn.requestedAt &&
        lifecycle.turn.previousActivitySequence != null &&
        activity.sequence <= lifecycle.turn.previousActivitySequence);
    if (staleInterruptSnapshot) return lifecycle;
  }

  let turn: TurnState;
  if (activity.phase === "active") {
    turn = {
      kind: "active",
      startedAt: activity.activeSince ?? activity.updatedAt,
      scope: activity.activeScope ?? "agent",
      ...(activity.activeScope === "tool" && activity.toolName ? { label: activity.toolName } : {}),
    };
  } else if (activity.phase === "waiting") {
    turn = { kind: "waiting", startedAt: activity.waitingSince ?? activity.updatedAt };
  } else if (activity.phase === "done") {
    turn = { kind: "waiting", startedAt: activity.updatedAt };
  } else {
    turn = { kind: "starting", observedAt: activity.updatedAt };
  }

  const process: ProcessState = lifecycle.process.kind === "starting"
    ? { kind: "running", startedAt: lifecycle.process.startedAt, confirmedAt: observedAt }
    : lifecycle.process;

  return {
    ...lifecycle,
    process,
    turn,
    activityHealth: { kind: "healthy", observedAt },
    pane: { kind: "present", observedAt },
    lastActivitySequence: activity.sequence,
  };
}

export function markProcessRunning(
  lifecycle: SubagentLifecycle,
  confirmedAt: number,
): SubagentLifecycle {
  if (lifecycle.process.kind !== "starting") return lifecycle;
  return {
    ...lifecycle,
    process: { kind: "running", startedAt: lifecycle.process.startedAt, confirmedAt },
  };
}

export function markInterruptRequested(
  lifecycle: SubagentLifecycle,
  requestedAt: number,
): SubagentLifecycle {
  if (lifecycle.process.kind === "finalizing" || isTerminal(lifecycle.process)) return lifecycle;
  return {
    ...lifecycle,
    turn: {
      kind: "interrupted",
      requestedAt,
      previousActivitySequence: lifecycle.lastActivitySequence,
    },
  };
}

export function markCompletionDetected(
  lifecycle: SubagentLifecycle,
  completion: CompletionResult,
  detectedAt: number,
): SubagentLifecycle {
  if (lifecycle.process.kind === "finalizing" || isTerminal(lifecycle.process)) return lifecycle;
  return {
    ...lifecycle,
    process: {
      kind: "finalizing",
      startedAt: startedAt(lifecycle.process),
      detectedAt: Math.max(startedAt(lifecycle.process), detectedAt),
      completion,
    },
  };
}

export function markCompleted(lifecycle: SubagentLifecycle, completedAt: number): SubagentLifecycle {
  if (isTerminal(lifecycle.process)) return lifecycle;
  if (lifecycle.process.kind !== "finalizing") return lifecycle;
  return {
    ...lifecycle,
    process: {
      kind: "completed",
      startedAt: lifecycle.process.startedAt,
      detectedAt: lifecycle.process.detectedAt,
      completedAt: Math.max(lifecycle.process.detectedAt, completedAt),
      completion: lifecycle.process.completion,
    },
  };
}

export function markFailed(
  lifecycle: SubagentLifecycle,
  error: string,
  detectedAt: number,
  exitCode?: number,
): SubagentLifecycle {
  if (isTerminal(lifecycle.process)) return lifecycle;
  const start = startedAt(lifecycle.process);
  const detected = lifecycle.process.kind === "finalizing"
    ? lifecycle.process.detectedAt
    : Math.max(start, detectedAt);
  return {
    ...lifecycle,
    process: {
      kind: "failed",
      startedAt: start,
      detectedAt: detected,
      completedAt: Math.max(detected, detectedAt),
      error,
      ...(exitCode == null ? {} : { exitCode }),
    },
  };
}

export function markDelivery(lifecycle: SubagentLifecycle, delivery: CompletionDelivery): SubagentLifecycle {
  if (lifecycle.delivery !== "pending") return lifecycle;
  return { ...lifecycle, delivery };
}

export function projectLifecycle(lifecycle: SubagentLifecycle, now: number): LifecycleProjection {
  const process = lifecycle.process;
  if (process.kind === "finalizing") return { kind: "finalizing", runtimeEndedAt: process.detectedAt };
  if (process.kind === "completed") return { kind: "completed", runtimeEndedAt: process.completedAt };
  if (process.kind === "failed") return { kind: "failed", label: process.error, runtimeEndedAt: process.completedAt };

  if (lifecycle.activityHealth.kind === "problem" && now - lifecycle.activityHealth.since >= 60_000) {
    return { kind: "stalled", stateDurationSince: lifecycle.activityHealth.since };
  }

  const turn = lifecycle.turn;
  if (turn.kind === "active") return { kind: "active", label: turn.label ?? turn.scope, stateDurationSince: turn.startedAt };
  if (turn.kind === "waiting") return { kind: "waiting", stateDurationSince: turn.startedAt };
  if (turn.kind === "interrupted") return { kind: "interrupted", stateDurationSince: turn.requestedAt };
  // Process confirmed running without turn detail (Claude, or pre-activity Pi).
  if (process.kind === "running") return { kind: "running" };
  return { kind: "starting" };
}

export type LifecycleTransition = "stalled" | "recovered" | null;

export function lifecycleTransition(
  previous: LifecycleProjection["kind"] | undefined,
  next: LifecycleProjection["kind"],
): LifecycleTransition {
  if (previous !== "stalled" && next === "stalled") return "stalled";
  if (previous === "stalled" && (next === "active" || next === "waiting" || next === "running")) {
    return "recovered";
  }
  return null;
}

export function formatLifecycleTransitionLine(
  name: string,
  projection: LifecycleProjection,
  transition: Exclude<LifecycleTransition, null>,
  now: number,
  startedAt: number,
  formatElapsed: (ms: number) => string,
): string {
  const runtime = formatElapsed(Math.max(0, now - startedAt));
  const duration = projection.stateDurationSince == null
    ? ""
    : ` ${formatElapsed(now - projection.stateDurationSince)}`;
  if (transition === "stalled") {
    return `${name} running ${runtime}, stalled${duration}.`;
  }
  if (projection.kind === "waiting") {
    return `${name} running ${runtime}, recovered; waiting${duration}.`;
  }
  if (projection.kind === "active") {
    const detail = projection.label ? ` (${projection.label}${duration})` : duration;
    return `${name} running ${runtime}, recovered; active${detail}.`;
  }
  return `${name} running ${runtime}, recovered; running.`;
}
