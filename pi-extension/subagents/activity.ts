import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type SubagentActivityPhase = "starting" | "active" | "waiting" | "done";

export interface SubagentProcessIdentity {
  pid: number;
  startTime: number;
}

export type ProcessStatReadResult =
  | { kind: "present"; identity: SubagentProcessIdentity; state: string }
  | { kind: "missing" }
  | { kind: "unknown"; error?: string };
export type SubagentActivityScope = "agent" | "turn" | "provider" | "streaming" | "tool";

export type SubagentActivityEvent =
  | "session_start"
  | "input"
  | "before_agent_start"
  | "agent_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "before_provider_request"
  | "after_provider_response"
  | "message_update"
  | "tool_execution_start"
  | "tool_call"
  | "tool_execution_update"
  | "tool_result"
  | "tool_execution_end"
  | "caller_ping"
  | "subagent_done"
  | "session_shutdown";

export interface SubagentActivityState {
  version: 1;
  runningChildId: string;
  createdAt: number;
  updatedAt: number;
  sequence: number;
  latestEvent: SubagentActivityEvent;
  phase: SubagentActivityPhase;
  agentActive: boolean;
  turnActive: boolean;
  providerActive: boolean;
  toolActive: boolean;
  activeScope?: SubagentActivityScope;
  activeSince?: number;
  waitingSince?: number;
  turnIndex?: number;
  messageEventType?: string;
  toolCallId?: string;
  toolName?: string;
  toolStartedAt?: number;
  toolEndedAt?: number;
  /** Exact child process identity for crash detection. */
  workerPid?: number;
  workerStartTime?: number;
}

export type ActivityReadResult =
  | { ok: true; activity: SubagentActivityState }
  | { ok: false; reason: "missing" | "invalid" | "wrong-id"; error?: string };

export type SubagentShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

export interface SubagentActivityRecorder {
  sessionStart(): void;
  input(): void;
  beforeAgentStart(): void;
  agentStart(): void;
  agentEndWaiting(): void;
  agentEndDone(): void;
  turnStart(turnIndex?: number): void;
  turnEnd(turnIndex?: number): void;
  beforeProviderRequest(): void;
  afterProviderResponse(): void;
  messageUpdate(messageEventType?: string): void;
  toolExecutionStart(toolCallId?: string, toolName?: string): void;
  toolCall(toolCallId?: string, toolName?: string): void;
  toolExecutionUpdate(toolCallId?: string, toolName?: string): void;
  toolResult(toolCallId?: string, toolName?: string): void;
  toolExecutionEnd(toolCallId?: string, toolName?: string): void;
  callerPing(): void;
  subagentDone(): void;
  sessionShutdown(reason: SubagentShutdownReason): void;
  /**
   * Last known lifecycle phase, for stamping truthful exit sidecars. The
   * noop recorder (no activity file configured) reports undefined so the
   * sidecar carries no fabricated phase.
   */
  currentPhase(): SubagentActivityPhase | undefined;
}

const ACTIVITY_UPDATE_THROTTLE_MS = 500;
const MAX_WRITE_FAILURES = 3;
const KNOWN_PHASES = new Set<SubagentActivityPhase>(["starting", "active", "waiting", "done"]);
const KNOWN_SCOPES = new Set<SubagentActivityScope>(["agent", "turn", "provider", "streaming", "tool"]);
const KNOWN_EVENTS = new Set<SubagentActivityEvent>([
  "session_start",
  "input",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "before_provider_request",
  "after_provider_response",
  "message_update",
  "tool_execution_start",
  "tool_call",
  "tool_execution_update",
  "tool_result",
  "tool_execution_end",
  "caller_ping",
  "subagent_done",
  "session_shutdown",
]);
const MAX_ACTIVITY_STRING_LENGTH = 200;
const KNOWN_PROCESS_STATES = new Set(["R", "S", "D", "T", "t", "Z", "X", "x", "K", "W", "P", "I"]);

export function getSubagentActivityFile(artifactDir: string, runningChildId: string): string {
  return join(artifactDir, "subagent-activity", `${runningChildId}.json`);
}

export function resetSubagentActivityFile(activityFile: string): void {
  try {
    unlinkSync(activityFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function unknownProcessRead(error?: unknown): ProcessStatReadResult {
  return {
    kind: "unknown",
    ...(error == null ? {} : { error: error instanceof Error ? error.message : String(error) }),
  };
}

export function parseProcStat(value: string, expectedPid: number): ProcessStatReadResult {
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0) return unknownProcessRead("invalid process id");

  const openParen = value.indexOf("(");
  const closeParen = value.lastIndexOf(")");
  if (openParen <= 0 || closeParen <= openParen) return unknownProcessRead("malformed process stat");

  const parsedPid = Number(value.slice(0, openParen).trim());
  if (!Number.isSafeInteger(parsedPid) || parsedPid !== expectedPid) {
    return unknownProcessRead("process id mismatch");
  }

  const fields = value.slice(closeParen + 1).trim().split(/\s+/);
  const state = fields[0];
  const startTime = Number(fields[19]);
  if (
    typeof state !== "string" || !KNOWN_PROCESS_STATES.has(state) ||
    !Number.isSafeInteger(startTime) || startTime <= 0
  ) {
    return unknownProcessRead("malformed process stat fields");
  }

  return { kind: "present", identity: { pid: parsedPid, startTime }, state };
}

export function readProcessStat(pid: number): ProcessStatReadResult {
  if (process.platform !== "linux") return unknownProcessRead("process stat is unavailable");

  try {
    statSync("/proc");
  } catch (error) {
    return unknownProcessRead(error);
  }

  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"), pid);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ESRCH") return { kind: "missing" };
    return unknownProcessRead(error);
  }
}

export function readCurrentProcessIdentity(): SubagentProcessIdentity | undefined {
  const result = readProcessStat(process.pid);
  return result.kind === "present" ? result.identity : undefined;
}

function requireObject(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function validateFiniteNumber(object: Record<string, unknown>, fieldName: string): string | null {
  return Number.isFinite(object[fieldName]) ? null : `${fieldName} must be finite`;
}

function validateOptionalFiniteNumber(object: Record<string, unknown>, fieldName: string): string | null {
  const value = object[fieldName];
  return value == null || Number.isFinite(value) ? null : `${fieldName} must be finite when present`;
}

function validateInteger(object: Record<string, unknown>, fieldName: string): string | null {
  return Number.isInteger(object[fieldName]) ? null : `${fieldName} must be an integer`;
}

function validateOptionalInteger(object: Record<string, unknown>, fieldName: string): string | null {
  const value = object[fieldName];
  return value == null || Number.isInteger(value) ? null : `${fieldName} must be an integer when present`;
}

function validateOptionalPositiveInteger(object: Record<string, unknown>, fieldName: string): string | null {
  const value = object[fieldName];
  return value == null || (Number.isSafeInteger(value) && value > 0)
    ? null
    : `${fieldName} must be a positive safe integer when present`;
}

function validateBoolean(object: Record<string, unknown>, fieldName: string): string | null {
  return typeof object[fieldName] === "boolean" ? null : `${fieldName} must be a boolean`;
}

function validateOptionalActivityString(object: Record<string, unknown>, fieldName: string): string | null {
  const value = object[fieldName];
  if (value == null) return null;
  if (typeof value !== "string") return `${fieldName} must be a string when present`;
  if (/\r|\n/.test(value)) return `${fieldName} must not contain newlines`;
  return value.length <= MAX_ACTIVITY_STRING_LENGTH ? null : `${fieldName} is too long`;
}

function invalidActivity(error: string): ActivityReadResult {
  return { ok: false, reason: "invalid", error };
}

function validateActivity(value: unknown, expectedRunningChildId: string): ActivityReadResult {
  const object = requireObject(value);
  if (!object) return invalidActivity("activity must be an object");
  if (object.version !== 1) return invalidActivity("unsupported activity version");
  if (typeof object.runningChildId !== "string") return invalidActivity("runningChildId must be a string");
  if (object.runningChildId !== expectedRunningChildId) return { ok: false, reason: "wrong-id" };
  if (typeof object.latestEvent !== "string" || !KNOWN_EVENTS.has(object.latestEvent as SubagentActivityEvent)) {
    return invalidActivity("unknown latestEvent");
  }
  if (typeof object.phase !== "string" || !KNOWN_PHASES.has(object.phase as SubagentActivityPhase)) {
    return invalidActivity("unknown activity phase");
  }
  if (
    object.activeScope != null &&
    (typeof object.activeScope !== "string" || !KNOWN_SCOPES.has(object.activeScope as SubagentActivityScope))
  ) {
    return invalidActivity("unknown activeScope");
  }

  const workerPidProvided = object.workerPid !== undefined;
  const workerStartTimeProvided = object.workerStartTime !== undefined;
  if (workerPidProvided !== workerStartTimeProvided) {
    return invalidActivity("worker identity must include workerPid and workerStartTime together");
  }

  const validationError = [
    validateFiniteNumber(object, "createdAt"),
    validateFiniteNumber(object, "updatedAt"),
    validateInteger(object, "sequence"),
    validateBoolean(object, "agentActive"),
    validateBoolean(object, "turnActive"),
    validateBoolean(object, "providerActive"),
    validateBoolean(object, "toolActive"),
    validateOptionalFiniteNumber(object, "activeSince"),
    validateOptionalFiniteNumber(object, "waitingSince"),
    validateOptionalInteger(object, "turnIndex"),
    validateOptionalFiniteNumber(object, "toolStartedAt"),
    validateOptionalFiniteNumber(object, "toolEndedAt"),
    validateOptionalPositiveInteger(object, "workerPid"),
    validateOptionalPositiveInteger(object, "workerStartTime"),
    validateOptionalActivityString(object, "messageEventType"),
    validateOptionalActivityString(object, "toolCallId"),
    validateOptionalActivityString(object, "toolName"),
  ].find((error) => error != null);
  if (validationError) return invalidActivity(validationError);

  // SAFETY: every field was validated above against the SubagentActivityState
  // schema; TypeScript cannot narrow the dynamic Record<string, unknown>.
  return { ok: true, activity: object as unknown as SubagentActivityState };
}

export function readSubagentActivityFile(
  activityFile: string,
  expectedRunningChildId: string,
): ActivityReadResult {
  if (!existsSync(activityFile)) return { ok: false, reason: "missing" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(activityFile, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "invalid", error: message };
  }

  return validateActivity(parsed, expectedRunningChildId);
}

export function writeSubagentActivityFile(activityFile: string, activity: SubagentActivityState): void {
  const dir = dirname(activityFile);
  mkdirSync(dir, { recursive: true });
  const tempFile = join(dir, `${activity.runningChildId}.json.${process.pid}.${activity.sequence}.tmp`);

  try {
    writeFileSync(tempFile, `${JSON.stringify(activity)}\n`, "utf8");
    renameSync(tempFile, activityFile);
  } catch (error) {
    try {
      unlinkSync(tempFile);
    } catch (cleanupError) {
      // Temp cleanup is best effort; preserve the original write/rename failure
      void cleanupError;
    }
    throw error;
  }
}

function createNoopRecorder(): SubagentActivityRecorder {
  return {
    sessionStart() {},
    input() {},
    beforeAgentStart() {},
    agentStart() {},
    agentEndWaiting() {},
    agentEndDone() {},
    turnStart() {},
    turnEnd() {},
    beforeProviderRequest() {},
    afterProviderResponse() {},
    messageUpdate() {},
    toolExecutionStart() {},
    toolCall() {},
    toolExecutionUpdate() {},
    toolResult() {},
    toolExecutionEnd() {},
    callerPing() {},
    subagentDone() {},
    sessionShutdown() {},
    currentPhase() { return undefined; },
  };
}

function clearActiveState(activity: SubagentActivityState): void {
  activity.agentActive = false;
  activity.turnActive = false;
  activity.providerActive = false;
  activity.toolActive = false;
  delete activity.activeScope;
  delete activity.activeSince;
}

function refreshActiveScope(activity: SubagentActivityState): void {
  if (activity.toolActive) {
    activity.phase = "active";
    activity.activeScope = "tool";
    return;
  }
  if (activity.providerActive) {
    activity.phase = "active";
    activity.activeScope = "provider";
    return;
  }
  if (activity.turnActive) {
    activity.phase = "active";
    activity.activeScope = "turn";
    return;
  }
  if (activity.agentActive) {
    activity.phase = "active";
    activity.activeScope = "agent";
    return;
  }
  delete activity.activeScope;
  delete activity.activeSince;
}

function markActive(
  activity: SubagentActivityState,
  scope: SubagentActivityScope,
  now: number,
  resetActiveSince = false,
): void {
  activity.phase = "active";
  activity.activeScope = scope;
  if (activity.activeSince == null || resetActiveSince) activity.activeSince = now;
  delete activity.waitingSince;
}

export function createSubagentActivityRecorder(params: {
  runningChildId?: string;
  activityFile?: string;
  now?: () => number;
}): SubagentActivityRecorder {
  const runningChildId = params.runningChildId?.trim();
  const activityFile = params.activityFile?.trim();
  if (!runningChildId || !activityFile) return createNoopRecorder();

  const now = params.now ?? (() => Date.now());
  const createdAt = now();
  const workerIdentity = readCurrentProcessIdentity();
  const activity: SubagentActivityState = {
    version: 1,
    runningChildId,
    createdAt,
    updatedAt: createdAt,
    sequence: 0,
    latestEvent: "session_start",
    phase: "starting",
    agentActive: false,
    turnActive: false,
    providerActive: false,
    toolActive: false,
    ...(workerIdentity ? {
      workerPid: workerIdentity.pid,
      workerStartTime: workerIdentity.startTime,
    } : {}),
  };

  let disabled = false;
  let failureCount = 0;
  let lastFlushAt = 0;
  let pendingFlush: ReturnType<typeof setTimeout> | null = null;

  function clearPendingFlush(): void {
    if (!pendingFlush) return;
    clearTimeout(pendingFlush);
    pendingFlush = null;
  }

  function disable(): void {
    disabled = true;
    clearPendingFlush();
  }

  function flushNow(): void {
    if (disabled) return;
    try {
      writeSubagentActivityFile(activityFile, activity);
      lastFlushAt = now();
      failureCount = 0;
    } catch {
      failureCount += 1;
      if (failureCount >= MAX_WRITE_FAILURES) disable();
    }
  }

  function scheduleFlush(): void {
    if (disabled || pendingFlush) return;

    const remainingMs = Math.max(0, ACTIVITY_UPDATE_THROTTLE_MS - (now() - lastFlushAt));
    if (remainingMs === 0) {
      flushNow();
      return;
    }

    pendingFlush = setTimeout(() => {
      pendingFlush = null;
      flushNow();
    }, remainingMs);
  }

  function record(
    latestEvent: SubagentActivityEvent,
    update: (current: SubagentActivityState, now: number) => void,
    flush: "immediate" | "throttled",
  ): void {
    if (disabled) return;
    if (flush === "immediate") clearPendingFlush();

    const observedAt = now();
    activity.latestEvent = latestEvent;
    activity.updatedAt = observedAt;
    activity.sequence += 1;
    update(activity, observedAt);

    if (flush === "immediate") flushNow();
    else scheduleFlush();
  }

  function markDone(latestEvent: SubagentActivityEvent): void {
    record(latestEvent, (current) => {
      current.phase = "done";
      clearActiveState(current);
      delete current.waitingSince;
    }, "immediate");
    disable();
  }

  return {
    sessionStart() {
      record("session_start", (current) => {
        current.phase = "starting";
        clearActiveState(current);
        delete current.waitingSince;
      }, "immediate");
    },
    input() {
      record("input", () => {}, "immediate");
    },
    beforeAgentStart() {
      record("before_agent_start", (current, observedAt) => {
        current.agentActive = true;
        markActive(current, "agent", observedAt);
      }, "immediate");
    },
    agentStart() {
      record("agent_start", (current, observedAt) => {
        current.agentActive = true;
        markActive(current, "agent", observedAt);
      }, "immediate");
    },
    agentEndWaiting() {
      record("agent_end", (current, observedAt) => {
        clearActiveState(current);
        current.phase = "waiting";
        current.waitingSince = observedAt;
      }, "immediate");
    },
    agentEndDone() {
      markDone("agent_end");
    },
    turnStart(turnIndex) {
      record("turn_start", (current, observedAt) => {
        current.agentActive = true;
        current.turnActive = true;
        if (turnIndex != null) current.turnIndex = turnIndex;
        markActive(current, current.toolActive || current.providerActive ? current.activeScope ?? "turn" : "turn", observedAt);
      }, "immediate");
    },
    turnEnd(turnIndex) {
      record("turn_end", (current) => {
        current.turnActive = false;
        current.providerActive = false;
        current.toolActive = false;
        if (turnIndex != null) current.turnIndex = turnIndex;
        refreshActiveScope(current);
      }, "immediate");
    },
    beforeProviderRequest() {
      record("before_provider_request", (current, observedAt) => {
        current.providerActive = true;
        markActive(current, "provider", observedAt, true);
      }, "immediate");
    },
    afterProviderResponse() {
      record("after_provider_response", (current) => {
        current.providerActive = false;
        refreshActiveScope(current);
      }, "immediate");
    },
    messageUpdate(messageEventType) {
      record("message_update", (current, observedAt) => {
        current.agentActive = true;
        current.turnActive = true;
        current.messageEventType = messageEventType;
        if (!current.toolActive) markActive(current, "streaming", observedAt);
      }, "throttled");
    },
    toolExecutionStart(toolCallId, toolName) {
      record("tool_execution_start", (current, observedAt) => {
        current.toolActive = true;
        current.toolCallId = toolCallId;
        current.toolName = toolName;
        current.toolStartedAt = observedAt;
        markActive(current, "tool", observedAt, true);
      }, "immediate");
    },
    toolCall(toolCallId, toolName) {
      record("tool_call", (current, observedAt) => {
        current.toolActive = true;
        current.toolCallId = toolCallId ?? current.toolCallId;
        current.toolName = toolName ?? current.toolName;
        markActive(current, "tool", observedAt);
      }, "immediate");
    },
    toolExecutionUpdate(toolCallId, toolName) {
      record("tool_execution_update", (current, observedAt) => {
        current.toolActive = true;
        current.toolCallId = toolCallId ?? current.toolCallId;
        current.toolName = toolName ?? current.toolName;
        markActive(current, "tool", observedAt);
      }, "throttled");
    },
    toolResult(toolCallId, toolName) {
      record("tool_result", (current) => {
        current.toolCallId = toolCallId ?? current.toolCallId;
        current.toolName = toolName ?? current.toolName;
        refreshActiveScope(current);
      }, "immediate");
    },
    toolExecutionEnd(toolCallId, toolName) {
      record("tool_execution_end", (current, observedAt) => {
        current.toolActive = false;
        current.toolCallId = toolCallId ?? current.toolCallId;
        current.toolName = toolName ?? current.toolName;
        current.toolEndedAt = observedAt;
        refreshActiveScope(current);
      }, "immediate");
    },
    callerPing() {
      markDone("caller_ping");
    },
    subagentDone() {
      markDone("subagent_done");
    },
    sessionShutdown(reason) {
      if (reason === "quit") markDone("session_shutdown");
      else disable();
    },
    currentPhase() {
      return activity.phase;
    },
  };
}
