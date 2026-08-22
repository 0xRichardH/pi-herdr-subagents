import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

export interface TimeLimitConfig {
  timeLimitSeconds?: number;
  idleTimeoutSeconds?: number;
  timeoutWarnThreshold?: number;
}

export type TimeLimitAction = "none" | "warn" | "hard-stop";

export const REPORT_ONLY_WRAPUP_DIRECTIVE =
  "Your time limit is nearly exhausted. Do not continue implementation or use tools. " +
  "Provide a concise final partial report with completed work, remaining work, and blockers.";

export interface WrapupFileOperations {
  exists(file: string): boolean;
  read(file: string): string;
  write(file: string, content: string): void;
  remove(file: string): void;
}

const DEFAULT_WRAPUP_FILE_OPERATIONS: WrapupFileOperations = {
  exists: existsSync,
  read: (file) => readFileSync(file, "utf8"),
  write: (file, content) => writeFileSync(file, content, "utf8"),
  remove: (file) => rmSync(file, { force: true }),
};

export function parsePositiveIntegerSeconds(value: string | undefined): number | undefined {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

export function parseTimeoutWarnThreshold(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const threshold = Number(value);
  return Number.isFinite(threshold) && threshold > 0 && threshold < 1 ? threshold : undefined;
}

function deadlineAt(start: number, seconds: number | undefined): number | undefined {
  if (!Number.isFinite(start) || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const deadline = start + seconds * 1_000;
  return Number.isFinite(deadline) ? deadline : undefined;
}

function earlierDeadline(...deadlines: Array<number | undefined>): number | undefined {
  const valid = deadlines.filter((deadline): deadline is number => deadline != null);
  return valid.length > 0 ? Math.min(...valid) : undefined;
}

/** The earliest hard deadline; idle limits require a child activity timestamp. */
export function getTimeLimitDeadlineAt(
  startTime: number,
  lastActivityAt: number | undefined,
  config: TimeLimitConfig,
): number | undefined {
  return earlierDeadline(
    deadlineAt(startTime, config.timeLimitSeconds),
    Number.isFinite(lastActivityAt) ? deadlineAt(lastActivityAt!, config.idleTimeoutSeconds) : undefined,
  );
}

function getWarnDeadlineAt(
  startTime: number,
  lastActivityAt: number | undefined,
  config: TimeLimitConfig,
): number | undefined {
  const threshold = config.timeoutWarnThreshold;
  if (!Number.isFinite(threshold) || threshold! <= 0 || threshold! >= 1) return undefined;
  return earlierDeadline(
    deadlineAt(startTime, config.timeLimitSeconds == null ? undefined : config.timeLimitSeconds * threshold!),
    Number.isFinite(lastActivityAt)
      ? deadlineAt(lastActivityAt!, config.idleTimeoutSeconds == null ? undefined : config.idleTimeoutSeconds * threshold!)
      : undefined,
  );
}

/** Evaluate a single tick using only caller-supplied time and state. */
export function evalTimeLimit(
  now: number,
  startTime: number,
  lastActivityAt: number | undefined,
  config: TimeLimitConfig,
  warned = false,
): TimeLimitAction {
  const hardDeadline = getTimeLimitDeadlineAt(startTime, lastActivityAt, config);
  if (hardDeadline != null && now >= hardDeadline) return "hard-stop";
  if (warned) return "none";
  const warnDeadline = getWarnDeadlineAt(startTime, lastActivityAt, config);
  return warnDeadline != null && now >= warnDeadline ? "warn" : "none";
}

export function wrapupDirectiveFile(sessionFile: string): string {
  return `${sessionFile}.wrapup`;
}

export function writeWrapupDirective(
  sessionFile: string,
  operations: WrapupFileOperations = DEFAULT_WRAPUP_FILE_OPERATIONS,
): void {
  operations.write(wrapupDirectiveFile(sessionFile), REPORT_ONLY_WRAPUP_DIRECTIVE);
}

/** Consume the one-shot parent directive before starting the report-only turn. */
export function consumeWrapupDirective(
  sessionFile: string | undefined,
  operations: WrapupFileOperations = DEFAULT_WRAPUP_FILE_OPERATIONS,
): string | null {
  if (!sessionFile) return null;
  const file = wrapupDirectiveFile(sessionFile);
  if (!operations.exists(file)) return null;
  try {
    const directive = operations.read(file).trim();
    operations.remove(file);
    return directive || null;
  } catch {
    return null;
  }
}

export function cleanupWrapupDirective(
  sessionFile: string | undefined,
  operations: Pick<WrapupFileOperations, "remove"> = DEFAULT_WRAPUP_FILE_OPERATIONS,
): void {
  if (!sessionFile) return;
  try {
    operations.remove(wrapupDirectiveFile(sessionFile));
  } catch {}
}

export function formatTimeLimitError(elapsedMs: number): string {
  return `Subagent timed out after ${Math.floor(Math.max(0, elapsedMs) / 1_000)}s.`;
}
