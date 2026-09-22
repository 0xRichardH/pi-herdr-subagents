import { existsSync, readFileSync, rmSync } from "node:fs";
import {
  readProcessStat,
  type ActivityReadResult,
  type ProcessStatReadResult,
  type SubagentProcessIdentity,
} from "./activity.ts";
import { MISSING_PANE_DEBOUNCE_MS, MISSING_PANE_ERROR } from "./lifecycle.ts";

const ABORT_MESSAGE = "Aborted while waiting for subagent to finish";
const TERMINAL_SENTINEL = /__SUBAGENT_DONE_(\d+)__/;
export const WORKER_PROCESS_DIED_ERROR = "subagent worker process died (no exit sidecar)";
export const WORKER_EXIT_STATUS_137_ERROR =
  "subagent worker process terminated with observed exit status 137 (no exit sidecar)";

type WorkerProcessProbeResult = "alive" | "dead" | "unknown";

function validProcessIdentity(identity: SubagentProcessIdentity): boolean {
  return Number.isSafeInteger(identity.pid) && identity.pid > 0 &&
    Number.isSafeInteger(identity.startTime) && identity.startTime > 0;
}

export function probeWorkerProcess(
  identity: SubagentProcessIdentity,
  readStat: (pid: number) => ProcessStatReadResult = readProcessStat,
): WorkerProcessProbeResult {
  if (!validProcessIdentity(identity)) return "unknown";

  let observed: ProcessStatReadResult;
  try {
    observed = readStat(identity.pid);
  } catch {
    return "unknown";
  }
  if (observed.kind === "missing") return "dead";
  if (observed.kind !== "present") return "unknown";
  if (
    observed.identity.pid !== identity.pid ||
    observed.identity.startTime !== identity.startTime
  ) {
    return "dead";
  }
  return observed.state === "Z" || observed.state === "X" || observed.state === "x"
    ? "dead"
    : "alive";
}

export function isProcessAliveInProc(pid: number): boolean {
  const result = readProcessStat(pid);
  return result.kind === "present" && result.state !== "Z" && result.state !== "X" && result.state !== "x";
}

function activityWorkerIdentity(read: ActivityReadResult): SubagentProcessIdentity | undefined {
  if (!read.ok) return undefined;
  const identity = {
    pid: read.activity.workerPid,
    startTime: read.activity.workerStartTime,
  };
  return identity.pid != null && identity.startTime != null && validProcessIdentity(identity)
    ? identity
    : undefined;
}

/** Compatibility for pre-F-209 callers; live Pi launches use activity identity. */
function legacyWorkerProcessDied(
  inspection: import("./lifecycle.ts").PaneInspection,
  processExists: (pid: number) => boolean,
): boolean {
  if (inspection.kind !== "present") return false;
  const workerId = inspection.workerPgid ?? inspection.workerPid;
  if (workerId == null) return false;
  try {
    return !processExists(workerId);
  } catch {
    return false;
  }
}

function terminalCompletion(exitCode: number): CompletionResult {
  if (exitCode === 137) {
    return {
      reason: "error",
      exitCode,
      preservePane: true,
      errorMessage: WORKER_EXIT_STATUS_137_ERROR,
    };
  }
  return { reason: "sentinel", exitCode };
}

export interface CompletionResult {
  reason: "done" | "ping" | "sentinel" | "error";
  exitCode: number;
  /** The child completed its one-shot report-only continuation after a time warning. */
  wrapup?: boolean;
  /** Keep the live pane available for inspection after a hard worker exit. */
  preservePane?: boolean;
  ping?: { name: string; message: string };
  errorMessage?: string;
}

export interface CompletionOptions {
  intervalMs: number;
  readTerminalTail: () => Promise<string>;
  inspectPane?: () => Promise<import("./lifecycle.ts").PaneInspection>;
  /** Current-launch identity from the worker-written activity snapshot. */
  readWorkerActivity?: () => ActivityReadResult;
  /** Expected writer of the exit sidecar; mismatched stamped payloads are ignored. */
  expectedSidecarWriter?: SidecarWriterIdentity;
  /** Reports alive/dead/unknown; unknown never becomes a failure. */
  probeWorkerProcess?: (identity: SubagentProcessIdentity) => WorkerProcessProbeResult;
  /** @deprecated Pre-F-209 injection retained for existing callers/tests. */
  processExists?: (pid: number) => boolean;
  onWorkerActivity?: (read: ActivityReadResult, observedAt: number) => void;
  /** Bounded artifact grace after explicit pane disappearance. Default: 500ms. */
  paneDisappearanceGraceMs?: number;
  onPaneInspection?: (
    inspection: import("./lifecycle.ts").PaneInspection,
    observedAt: number,
  ) => void;
  sessionFile?: string;
  sentinelFile?: string;
  onTick?: (elapsedSeconds: number) => void;
}

export interface SidecarWriterIdentity {
  pid?: number;
  startTime?: number;
  /** Run identity (PI_SUBAGENT_ID) — the strongest discriminator. */
  runId?: string;
}

/**
 * Identity guard for foreign crash-sidecar writes (TASK-327 defense in
 * depth, extended by TASK-330 with run identity). A crash payload stamped
 * with a run/worker identity that does not match the lane the watcher is
 * tracking is ignored, so a stray process inheriting PI_SUBAGENT_SESSION —
 * or a second pi on the same session file — can never publish a failure for
 * a real lane. Unstamped payloads (done, ping, provider errors, and crash
 * writes from a platform where /proc identity is unavailable) pass through
 * unchanged so every legitimate path keeps working (accept-when-unknown).
 */
export function isForeignSidecarIdentity(
  payload: { runId?: unknown; workerPid?: unknown; workerStartTime?: unknown },
  expected: SidecarWriterIdentity | undefined,
): boolean {
  if (!expected) return false;
  const payloadHasIdentity =
    payload.runId != null || payload.workerPid != null || payload.workerStartTime != null;
  if (!payloadHasIdentity) return false;
  // Prefer the run id when both sides know it: it survives pid recycling and
  // is exactly what distinguishes two runs on one shared session file.
  if (payload.runId != null && expected.runId != null) {
    return payload.runId !== expected.runId;
  }
  if (
    payload.workerPid != null && payload.workerStartTime != null &&
    expected.pid != null && expected.startTime != null
  ) {
    return payload.workerPid !== expected.pid || payload.workerStartTime !== expected.startTime;
  }
  // Identity present but not comparable: never reject on a guess.
  return false;
}

export function interpretExitSidecar(data: unknown): CompletionResult {
  const payload = data as {
    type?: unknown;
    name?: unknown;
    message?: unknown;
    errorMessage?: unknown;
    wrapup?: unknown;
  };

  if (payload?.type === "ping") {
    return {
      reason: "ping",
      exitCode: 0,
      ping: {
        name: typeof payload.name === "string" ? payload.name : "subagent",
        message: typeof payload.message === "string" ? payload.message : "",
      },
    };
  }

  if (payload?.type === "error") {
    const errorMessage =
      typeof payload.errorMessage === "string" && payload.errorMessage.trim()
        ? payload.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }

  if (payload?.type === "done") {
    return { reason: "done", exitCode: 0, ...(payload.wrapup === true ? { wrapup: true } : {}) };
  }

  return {
    reason: "error",
    exitCode: 1,
    errorMessage: "Invalid subagent completion sidecar: unsupported payload type.",
  };
}

function consumeExitSidecar(
  sessionFile: string | undefined,
  expectedWriter?: SidecarWriterIdentity,
): CompletionResult | null {
  if (!sessionFile) return null;

  const exitFile = `${sessionFile}.exit`;
  if (!existsSync(exitFile)) return null;

  try {
    const payload = JSON.parse(readFileSync(exitFile, "utf8")) as {
      type?: unknown;
      stopReason?: unknown;
      runId?: unknown;
      workerPid?: unknown;
      workerStartTime?: unknown;
    };
    if (isForeignSidecarIdentity(payload, expectedWriter)) {
      // A foreign process (e.g. an in-test extension instantiation that
      // inherited PI_SUBAGENT_SESSION) wrote this sidecar. Delete it so it
      // cannot sit around and poison a later read, then keep waiting for
      // the real lane's own completion evidence.
      rmSync(exitFile, { force: true });
      return null;
    }
    const result = interpretExitSidecar(payload);
    rmSync(exitFile, { force: true });
    return payload.type === "error" && payload.stopReason !== "error"
      ? { ...result, preservePane: true }
      : result;
  } catch {
    // The child may still be writing the file. Retry on the next polling cycle.
    return null;
  }
}

function terminalExitCode(screen: string): number | null {
  const match = screen.match(TERMINAL_SENTINEL);
  return match ? Number.parseInt(match[1], 10) : null;
}

function completionArtifact(options: CompletionOptions): CompletionResult | null {
  const sidecar = consumeExitSidecar(options.sessionFile, options.expectedSidecarWriter);
  if (sidecar) return sidecar;
  if (options.sentinelFile && existsSync(options.sentinelFile)) {
    return { reason: "sentinel", exitCode: 0 };
  }
  return null;
}

async function waitForDisappearanceArtifacts(
  signal: AbortSignal,
  options: CompletionOptions,
): Promise<CompletionResult | null> {
  const immediate = completionArtifact(options);
  if (immediate) return immediate;

  const graceMs = Math.max(0, options.paneDisappearanceGraceMs ?? 500);
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await abortableDelay(Math.min(25, remaining), signal);
    const result = completionArtifact(options);
    if (result) return result;
  }
  return null;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error(ABORT_MESSAGE));

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error(ABORT_MESSAGE));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForCompletion(
  signal: AbortSignal,
  options: CompletionOptions,
): Promise<CompletionResult> {
  const startedAt = Date.now();
  let missingPaneDetectedAt: number | undefined;
  let knownWorkerIdentity: SubagentProcessIdentity | undefined;
  let knownSidecarIdentity: SidecarWriterIdentity | undefined;

  for (;;) {
    if (signal.aborted) throw new Error(ABORT_MESSAGE);

    const sidecarResult = consumeExitSidecar(options.sessionFile, options.expectedSidecarWriter ?? knownSidecarIdentity);
    if (sidecarResult) return sidecarResult;

    if (options.sentinelFile && existsSync(options.sentinelFile)) {
      return { reason: "sentinel", exitCode: 0 };
    }

    try {
      const exitCode = terminalExitCode(await options.readTerminalTail());
      if (exitCode !== null) return terminalCompletion(exitCode);
    } catch {
      // Terminal reads are only sentinel/output probes; Herdr status is polled
      // independently below, even when terminal reads succeed.
    }

    // Read the worker-authored snapshot before inspecting Herdr. This closes
    // the startup gap where Pi can publish activity and die before Herdr's
    // first foreground-process observation.
    if (options.readWorkerActivity) {
      let read: ActivityReadResult | undefined;
      try {
        read = options.readWorkerActivity();
      } catch {
        // Activity is optional; an unavailable or malformed read is unknown.
      }
      if (read) {
        const candidate = activityWorkerIdentity(read);
        if (candidate && !knownWorkerIdentity) knownWorkerIdentity = candidate;
        if (read.ok) {
          knownSidecarIdentity = {
            ...(read.activity.workerPid != null ? { pid: read.activity.workerPid } : {}),
            ...(read.activity.workerStartTime != null
              ? { startTime: read.activity.workerStartTime }
              : {}),
            runId: read.activity.runningChildId,
          };
        }
        try {
          options.onWorkerActivity?.(read, Date.now());
        } catch {
          // Status enrichment must never prevent completion detection.
        }
      }
    }

    if (options.inspectPane) {
      let inspection: import("./lifecycle.ts").PaneInspection;
      try {
        inspection = await options.inspectPane();
      } catch {
        inspection = { kind: "unavailable", error: "inspectPane threw" };
      }
      const observedAt = Date.now();
      options.onPaneInspection?.(inspection, observedAt);
      if (inspection.kind === "present" && knownWorkerIdentity) {
        let probeResult: WorkerProcessProbeResult = "unknown";
        try {
          probeResult = options.probeWorkerProcess?.(knownWorkerIdentity) ??
            probeWorkerProcess(knownWorkerIdentity);
        } catch {
          // A permission/read/parse failure is unknown, never worker death.
        }
        if (probeResult === "dead") {
          return {
            reason: "error",
            exitCode: 1,
            preservePane: true,
            errorMessage: WORKER_PROCESS_DIED_ERROR,
          };
        }
      } else if (
        inspection.kind === "present" &&
        !options.readWorkerActivity &&
        options.processExists &&
        legacyWorkerProcessDied(inspection, options.processExists)
      ) {
        return {
          reason: "error",
          exitCode: 1,
          preservePane: true,
          errorMessage: WORKER_PROCESS_DIED_ERROR,
        };
      }
      if (inspection.kind === "missing") {
        // A single pane_not_found can race Herdr's pane publication/update.
        // Require the miss to persist briefly before declaring evidence lost.
        missingPaneDetectedAt ??= observedAt;
        const racedCompletion = completionArtifact(options);
        if (racedCompletion) return racedCompletion;
        if (observedAt - missingPaneDetectedAt < MISSING_PANE_DEBOUNCE_MS) {
          options.onTick?.(Math.floor((Date.now() - startedAt) / 1000));
          await abortableDelay(options.intervalMs, signal);
          continue;
        }

        // Pane closure and atomic artifact publication are separate operations.
        // Allow a short bounded grace window before declaring evidence lost.
        const delayedCompletion = await waitForDisappearanceArtifacts(signal, options);
        if (delayedCompletion) return delayedCompletion;
        return {
          reason: "error",
          exitCode: 1,
          errorMessage: MISSING_PANE_ERROR,
        };
      }
      missingPaneDetectedAt = undefined;
    } else if (knownWorkerIdentity) {
      let probeResult: WorkerProcessProbeResult = "unknown";
      try {
        probeResult = options.probeWorkerProcess?.(knownWorkerIdentity) ??
          probeWorkerProcess(knownWorkerIdentity);
      } catch {
        // A permission/read/parse failure is unknown, never worker death.
      }
      if (probeResult === "dead") {
        return {
          reason: "error",
          exitCode: 1,
          preservePane: true,
          errorMessage: WORKER_PROCESS_DIED_ERROR,
        };
      }
    }

    options.onTick?.(Math.floor((Date.now() - startedAt) / 1000));
    await abortableDelay(options.intervalMs, signal);
  }
}
