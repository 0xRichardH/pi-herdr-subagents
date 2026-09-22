/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Alt+J)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSubagentActivityRecorder, readCurrentProcessIdentity } from "./activity.ts";
import { consumeWrapupDirective } from "./time-limits.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function isSubagentSessionHost(sessionFile: string, argv: readonly string[]): boolean {
  if (!sessionFile) return false;
  const flagIndex = argv.indexOf("--session");
  if (flagIndex < 0 || flagIndex + 1 >= argv.length) return false;
  return argv[flagIndex + 1] === sessionFile;
}

export function shouldRegisterCrashHooks(
  sessionFile: string | undefined,
  argv: readonly string[] = process.argv,
): boolean {
  return typeof sessionFile === "string" && sessionFile.length > 0 &&
    isSubagentSessionHost(sessionFile, argv);
}

/**
 * Run identity stamped on EVERY exit-sidecar payload so a watcher can drop a
 * payload written by a different run that happens to share the session file
 * (the resume-while-running conflation in TASK-330). Fields are omitted when
 * the child genuinely cannot know them, which keeps unstamped legacy payloads
 * accepted by the parent (accept-when-unknown).
 */
export interface ExitSidecarRunIdentity {
  runId?: string;
  workerPid?: number;
  workerStartTime?: number;
}

/** Terminal metadata carried alongside the run identity. */
export interface ExitSidecarMeta {
  exitCode?: number;
  signal?: string;
  lastPhase?: string;
  message?: string;
}

/**
 * Merge the run identity and terminal metadata into an exit-sidecar payload.
 * Pure so both the completion paths and the crash hooks share one shape.
 */
export function stampExitSidecar(
  base: Record<string, unknown>,
  identity: ExitSidecarRunIdentity,
  meta: ExitSidecarMeta,
): Record<string, unknown> {
  return {
    ...base,
    ...(identity.runId ? { runId: identity.runId } : {}),
    ...(identity.workerPid != null && identity.workerStartTime != null
      ? { workerPid: identity.workerPid, workerStartTime: identity.workerStartTime }
      : {}),
    ...(meta.exitCode != null ? { exitCode: meta.exitCode } : {}),
    ...(meta.signal ? { signal: meta.signal } : {}),
    ...(meta.lastPhase ? { lastPhase: meta.lastPhase } : {}),
    ...(meta.message ? { message: meta.message } : {}),
  };
}

/**
 * Truthful crash sidecar. The message is the observed terminal cause (exit
 * code or uncaught-exception text) — never a constant that masks it.
 */
export function buildCrashSidecar(
  identity: ExitSidecarRunIdentity,
  meta: ExitSidecarMeta & { message: string },
): Record<string, unknown> {
  return stampExitSidecar({ type: "error", errorMessage: meta.message }, identity, meta);
}

function isTerminalAutoExitStopReason(stopReason: string | undefined): boolean {
  return stopReason === "stop" || stopReason === "error";
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // A tool-use response is an intermediate turn boundary. Keep the child
  // alive so Pi can deliver the next assistant response or a tool failure.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return isTerminalAutoExitStopReason(msg.stopReason);
      }
    }
  }

  return false;
}

export interface AutoExitDecisionState {
  /** Sticky: set when the operator typed into the session or Escape-aborted a run. */
  disarmed: boolean;
  /** Set by /auto-exit: allows exactly one more settled completion to exit. */
  oneShotReArm: boolean;
}

/**
 * Pure auto-exit decision for a settled agent turn.
 *
 * - Armed and untouched: exits on terminal stops and errors exactly as
 *   v0.2.0 did; Escape-aborted runs keep the session open.
 * - Disarmed (operator takeover): never exits, whatever the stop reason.
 * - One-shot re-arm (/auto-exit): behaves like armed for a single further
 *   completion; the caller consumes the flag once that exit happens.
 */
export function resolveAutoExit(
  state: AutoExitDecisionState,
  stopReason: string | undefined,
): boolean {
  if (state.disarmed && !state.oneShotReArm) return false;
  return isTerminalAutoExitStopReason(stopReason);
}

/** Fallback recovery state derived from the agent-fallback-chain session contract. */
export type FallbackRecoveryState = "none" | "pending" | "exhausted";

export type FallbackExitDecision = "exit" | "defer" | "grace";

/**
 * Derive fallback recovery state from session entries.
 *
 * Contract owned by the live agent-fallback-chain extension: it appends
 * `agent-fallback` / `agent-fallback-deferred` once a recovery continuation is
 * queued, and `agent-fallback-terminal` once recovery is exhausted. Only
 * entries appended AFTER the last assistant message belong to the attempt that
 * just settled; once a recovered turn produces a new assistant message, its
 * fallback entry is superseded.
 */
export function deriveFallbackRecovery(
  entries: Array<{ type?: string; customType?: string; message?: { role?: string } }> | undefined,
): FallbackRecoveryState {
  if (!entries || entries.length === 0) return "none";
  let lastAssistant = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry: any = entries[i];
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant === -1) return "none";
  for (let i = entries.length - 1; i > lastAssistant; i--) {
    const entry: any = entries[i];
    if (entry?.type !== "custom") continue;
    if (entry.customType === "agent-fallback-terminal") return "exhausted";
    if (entry.customType === "agent-fallback" || entry.customType === "agent-fallback-deferred") {
      return "pending";
    }
  }
  return "none";
}

/**
 * Pure fallback-aware decision for an `error` stop reason (B12).
 *
 * - "pending": a recovery continuation is queued -> defer the exit and let the
 *   recovered turn run (the caller keeps it bounded).
 * - "exhausted": the chain already gave up -> exit with the original error.
 * - "none": grace only when the failure is failover-eligible AND the profile
 *   declares a fallback chain, covering the async setModel race; otherwise
 *   exit exactly as before.
 */
export function resolveFallbackAwareExit(params: {
  recovery: FallbackRecoveryState;
  failoverEligible: boolean;
  hasDeclaredFallback: boolean;
}): FallbackExitDecision {
  if (params.recovery === "pending") return "defer";
  if (params.recovery === "exhausted") return "exit";
  return params.failoverEligible && params.hasDeclaredFallback ? "grace" : "exit";
}

// Failover-eligibility mirrors the live agent-fallback-chain classifier
// (~/.pi/agent/extensions/agent-fallback-chain.ts). Kept in sync by contract:
// a drift only changes whether the bounded grace runs, never whether recovery
// succeeds, because a non-eligible error gets an `agent-fallback-terminal`
// entry from that extension and exits on the next guard tick.
const FALLBACK_LIMIT_ERROR_RE =
  /\b429\b|rate[ _-]?limit|too many requests|quota|usage[ _-]?limit|usage_limit_reached|usage_not_included|insufficient_quota|out of budget|available balance|billing hard limit|monthly usage limit|freeusagelimiterror|gousagelimiterror/i;
const FALLBACK_TRANSPORT_ERROR_RE =
  /upstream request failed|bad gateway|service unavailable|internal server error|gateway time-?out|connection (?:error|reset|refused|closed)|socket hang ?up|fetch failed|network error|temporarily unavailable|\b(?:404|500|502|503|504)\b|<!doctype html|<html\b/i;
const FALLBACK_REASONING_STATE_RE =
  /encrypted_content|was not issued to this caller|thinking_?signature|reasoning (?:content |state )?(?:is )?not (?:issued|found|present)|invalid_request_error.*reasoning/i;

export function isFailoverEligibleError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  if (FALLBACK_REASONING_STATE_RE.test(errorMessage)) return false;
  return FALLBACK_LIMIT_ERROR_RE.test(errorMessage) || FALLBACK_TRANSPORT_ERROR_RE.test(errorMessage);
}

/**
 * Mirrors `profileHasFallbackDeclaration` from the live agent-profile-runtime
 * helper: the effective profile is the first existing project-local/global
 * candidate; a `fallbacks:` key anywhere in it declares a chain.
 */
export function agentDeclaresFallbackChain(cwd: string): boolean {
  const name = process.env.PI_SUBAGENT_AGENT?.trim() || process.env.SULA_DESKTOP_AGENT?.trim();
  if (!name) return false;
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const candidates = [
    join(cwd, ".pi", "agents", `${name}.md`),
    join(agentDir, "agents", `${name}.md`),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      return false;
    }
    if (/^fallbacks[ \t]*:/m.test(content)) return true;
    if (/^---\r?\n[\s\S]*?\r?\n---/.test(content)) return false;
  }
  return false;
}

const DEFAULT_FALLBACK_GUARD_MS = 5000;
const FALLBACK_GUARD_POLL_MS = 200;

function fallbackGuardMs(): number {
  const raw = Number(process.env.PI_SUBAGENT_FALLBACK_GUARD_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_FALLBACK_GUARD_MS;
  return Math.min(raw, 10_000);
}

function uncaughtExceptionMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Subagent exited after an uncaught exception.";
}

function latestAssistantStopReason(messages: any[] | undefined): string | undefined {
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") return msg.stopReason as string | undefined;
    }
  }
  return undefined;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function buildCompletionSidecar(messages: any[] | undefined, wrapup = false):
  | { type: "done"; wrapup?: true }
  | { type: "error"; errorMessage: string; stopReason: "error" } {
  const errorInfo = findLatestAssistantError(messages);
  return errorInfo ? { type: "error", ...errorInfo } : { type: "done", ...(wrapup ? { wrapup: true } : {}) };
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export interface SubagentDoneTestHooks {
  registerCrashHooks: (argv?: readonly string[]) => void;
  unregisterCrashHooks: () => void;
}

export default function (
  pi: ExtensionAPI,
  testHooks?: { onReady?: (hooks: SubagentDoneTestHooks) => void },
) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const resumedAutoExitRearm = autoExit && process.env.PI_SUBAGENT_AUTO_EXIT_REARM === "1";
  let resumeInputPending = autoExit && process.env.PI_SUBAGENT_RESUME_INPUT === "1";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });
  const runId = process.env.PI_SUBAGENT_ID?.trim() || undefined;
  const processIdentity = readCurrentProcessIdentity();

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Alt+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Alt+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  // A delegated resume is a fresh autonomous run even when the JSONL's last
  // turn was operator-aborted. Re-arm it explicitly, rather than deriving
  // state from historical session contents.
  let disarmed = resumedAutoExitRearm;
  let oneShotReArm = resumedAutoExitRearm;
  let warnedOperatorTakeover = false;
  let agentStarted = false;
  let latestAgentMessages: any[] | undefined;
  let wrapupInProgress = false;
  let exitSidecarWritten = false;
  let processExitHandler: ((code: number) => void) | undefined;
  let uncaughtExceptionHandler: ((error: Error) => void) | undefined;

  function writeExitSidecar(
    data: Record<string, unknown>,
    targetSessionFile = process.env.PI_SUBAGENT_SESSION,
  ): void {
    if (exitSidecarWritten) return;
    if (!targetSessionFile) return;
    writeFileSync(`${targetSessionFile}.exit`, JSON.stringify(data));
    exitSidecarWritten = true;
  }

  /** Stamp the current run identity + last known phase onto a payload. */
  function stampedSidecar(
    base: Record<string, unknown>,
    meta: ExitSidecarMeta,
  ): Record<string, unknown> {
    return stampExitSidecar(
      base,
      {
        runId,
        workerPid: processIdentity?.pid,
        workerStartTime: processIdentity?.startTime,
      },
      { ...meta, lastPhase: meta.lastPhase ?? recorder.currentPhase() },
    );
  }

  function registerCrashHooks(argv: readonly string[] = process.argv): void {
    const targetSessionFile = process.env.PI_SUBAGENT_SESSION;
    if (!shouldRegisterCrashHooks(targetSessionFile, argv)) return;

    // The child's own process identity rides in the crash sidecar so the
    // parent can ignore foreign writes (a stale watcher for a recycled pid
    // would otherwise still reject a mismatched payload).
    const writerIdentity = readCurrentProcessIdentity();
    const crashIdentity: ExitSidecarRunIdentity = {
      runId,
      workerPid: writerIdentity?.pid,
      workerStartTime: writerIdentity?.startTime,
    };

    processExitHandler = (code: number) => {
      try {
        const exitCode = Number.isInteger(code) ? code : 1;
        writeExitSidecar(buildCrashSidecar(crashIdentity, {
          exitCode,
          lastPhase: recorder.currentPhase(),
          message: `Subagent process exited before completing (exit code ${exitCode}).`,
        }), targetSessionFile);
      } catch {
        // Process exit is already in progress; sidecar publication is best effort.
      }
    };
    uncaughtExceptionHandler = (error) => {
      try {
        writeExitSidecar(
          buildCrashSidecar(crashIdentity, {
            exitCode: 1,
            lastPhase: recorder.currentPhase(),
            message: uncaughtExceptionMessage(error),
          }),
          targetSessionFile,
        );
      } catch {
        // Pi's own uncaughtException handler still owns process termination.
      }
    };
    process.on("exit", processExitHandler);
    process.on("uncaughtException", uncaughtExceptionHandler);
  }

  function unregisterCrashHooks(): void {
    if (processExitHandler) process.off("exit", processExitHandler);
    if (uncaughtExceptionHandler) process.off("uncaughtException", uncaughtExceptionHandler);
    processExitHandler = undefined;
    uncaughtExceptionHandler = undefined;
  }

  let fallbackGuardTimer: ReturnType<typeof setTimeout> | undefined;

  function clearFallbackGuard(): void {
    if (fallbackGuardTimer) {
      clearTimeout(fallbackGuardTimer);
      fallbackGuardTimer = undefined;
    }
  }

  function sessionEntries(ctx: any): any[] | undefined {
    try {
      return ctx?.sessionManager?.getEntries?.();
    } catch {
      return undefined;
    }
  }

  function performExit(ctx: any): void {
    clearFallbackGuard();
    const targetSessionFile = process.env.PI_SUBAGENT_SESSION;
    if (targetSessionFile) {
      try {
        const completion = buildCompletionSidecar(latestAgentMessages, wrapupInProgress);
        writeExitSidecar(stampedSidecar(
          completion,
          completion.type === "error"
            ? { exitCode: 1, message: completion.errorMessage }
            : { exitCode: 0, message: "completed" },
        ));
      } catch {
        // Best effort — the watcher can still detect the terminal sentinel
        // after shutdown if the completion sidecar cannot be written.
      }
    }
    unregisterCrashHooks();
    recorder.agentEndDone();
    ctx.shutdown();
  }

  /**
   * Bounded guard for an error turn whose fallback recovery is queued
   * ("pending") or racing the async setModel ("none"). It never waits
   * unbounded: on the deadline it exits with the original provider error
   * exactly as before. `turn_start` cancels it once the recovered turn starts.
   */
  function armFallbackGuard(ctx: any): void {
    clearFallbackGuard();
    const deadline = Date.now() + fallbackGuardMs();
    const tick = () => {
      fallbackGuardTimer = undefined;
      const recovery = deriveFallbackRecovery(sessionEntries(ctx));
      if (recovery === "exhausted" || Date.now() >= deadline) {
        performExit(ctx);
        return;
      }
      fallbackGuardTimer = setTimeout(tick, FALLBACK_GUARD_POLL_MS);
    };
    fallbackGuardTimer = setTimeout(tick, FALLBACK_GUARD_POLL_MS);
  }

  registerCrashHooks();
  testHooks?.onReady?.({ registerCrashHooks, unregisterCrashHooks });

  // Operator takeover (typed input or an Escape abort) permanently disarms
  // auto-exit for this session. The warning is latched so it is emitted
  // exactly once no matter how often the operator interacts afterwards.
  function disarmAutoExit(cause: string, ctx: any): void {
    disarmed = true;
    if (!autoExit || warnedOperatorTakeover) return;
    warnedOperatorTakeover = true;
    ctx.ui.notify(
      `Auto-exit disabled (${cause}). You are driving this session now — ` +
        "/auto-exit closes it after its next completion.",
      "warning",
    );
  }

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
  });

  pi.on("input", (event, ctx) => {
    recorder.input();
    // The resume command's positional message is machine input, even though
    // Pi reports it as a normal input event. Consume that marker once so it
    // cannot disarm the newly re-armed autonomous run.
    if (resumeInputPending) {
      resumeInputPending = false;
      return;
    }
    // Extension-injected report directives are not operator takeover. This keeps
    // the report-only continuation compatible with sticky auto-exit disarming.
    if ((event as any).source === "extension") return;
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    disarmAutoExit("operator input", ctx);
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    recorder.agentStart();
  });

  pi.on("agent_end", (event) => {
    // agent_end is not terminal: Pi may compact and automatically retry after
    // this event. Keep the latest result, but do not publish completion or
    // shut down until agent_settled confirms no continuation will run.
    latestAgentMessages = (event as any).messages as any[] | undefined;
    recorder.agentEndWaiting();
  });

  pi.on("agent_settled", (_event, ctx) => {
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    const stopReason = latestAssistantStopReason(latestAgentMessages);

    // Time-limit wrap-up: an interrupt left the latest assistant turn aborted
    // and a .wrapup directive exists. Consume it once and inject a report-only
    // continuation. Checked BEFORE the Escape-disarm below so a machine-caused
    // time-limit interrupt is never mistaken for operator takeover.
    const directive = !wrapupInProgress && stopReason === "aborted"
      ? consumeWrapupDirective(sessionFile)
      : null;
    if (directive) {
      wrapupInProgress = true;
      // Extension-sourced turn: pi.sendUserMessage re-enters the "input"
      // event with source: "extension", which the input handler ignores, so
      // this continuation never flips the operator-takeover disarm latch.
      pi.sendUserMessage(directive);
      return;
    }

    // An Escape-triggered abort is operator takeover too: permanently disarm
    // (single warning above) and leave the session open for inspection.
    if (stopReason === "aborted") {
      disarmAutoExit("Escape", ctx);
    }

    // Exit when auto-exit says so, OR when a wrap-up continuation finished a
    // non-aborted turn: that partial report must reach the parent even if the
    // operator had disarmed auto-exit earlier. The one-shot re-arm is consumed
    // only when the auto-exit branch itself decided the exit (L-95 rule).
    const autoExitShouldFire = autoExit
      && resolveAutoExit({ disarmed, oneShotReArm }, stopReason);
    const shouldExit = autoExitShouldFire
      || (wrapupInProgress && isTerminalAutoExitStopReason(stopReason));

    // Fallback-aware one-shot exit (B12): an error turn may already have a
    // queued recovery continuation ("pending") or be racing the fallback
    // extension's async setModel ("none" with a declared chain). Defer/grace
    // instead of killing a recovered turn; the guard stays bounded and
    // re-evaluates before any exit, so a missed recovery still reports the
    // original provider error.
    if (shouldExit && stopReason === "error") {
      const decision = resolveFallbackAwareExit({
        recovery: deriveFallbackRecovery(sessionEntries(ctx)),
        failoverEligible: isFailoverEligibleError(
          findLatestAssistantError(latestAgentMessages)?.errorMessage,
        ),
        hasDeclaredFallback: agentDeclaresFallbackChain(ctx?.cwd ?? process.cwd()),
      });
      if (decision === "defer" || decision === "grace") {
        armFallbackGuard(ctx);
        return;
      }
    }

    if (shouldExit) {
      if (autoExitShouldFire && oneShotReArm) {
        // Consume the one-shot re-arm: after this exit auto-exit is disarmed
        // again until the operator runs /auto-exit once more.
        oneShotReArm = false;
      }
      // Surface stopReason: "error" turns (auto-retry exhausted, provider
      // overload, etc.) to the parent via the .exit sidecar so the watcher
      // can report a clear failure with the underlying error message.
      performExit(ctx);
      return;
    }
  });

  pi.on("turn_start", (event) => {
    // A recovered fallback turn actually started: cancel the bounded guard so
    // the normal lifecycle owns the session again.
    clearFallbackGuard();
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    clearFallbackGuard();
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Alt+J (ctrl-J is pi's built-in tui.input.newLine)
  // Re-arm auto-exit for exactly one completion after operator takeover.
  pi.registerCommand("auto-exit", {
    description: "Close this session automatically after its next completed turn",
    handler: async (_args, ctx) => {
      if (!autoExit) {
        ctx.ui.notify("Auto-exit is not enabled for this session.", "info");
        return;
      }
      if (!disarmed) {
        ctx.ui.notify("Auto-exit is already armed.", "info");
        return;
      }
      if (oneShotReArm) {
        ctx.ui.notify(
          "Auto-exit is already re-armed for the next completion.",
          "info",
        );
        return;
      }
      oneShotReArm = true;
      ctx.ui.notify(
        "Auto-exit re-armed: this session will close after its next completion.",
        "info",
      );
    },
  });

  pi.registerShortcut("alt+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent will be notified with your message and can resume this session with a response. " +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      recorder.callerPing();
      const exitData = stampedSidecar(
        {
          type: "ping" as const,
          name: process.env.PI_SUBAGENT_NAME ?? "subagent",
          message: params.message,
        },
        { exitCode: 0, message: params.message },
      );
      writeExitSidecar(exitData);
      unregisterCrashHooks();

      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Ping sent. Session will exit and parent will be notified." }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call this tool when you have completed your task. " +
      "It will close this session and return your results to the main session. " +
      "The final report must be written as text in the SAME assistant message as this tool call — " +
      "include the report text alongside the tool call. " +
      "Calling it without accompanying text returns no summary to the caller " +
      "(\"Sub-agent exited without output\"). " +
      "Profiles which cannot emit text alongside tool calls must pass the report via the `report` argument.",
    parameters: Type.Object({
      report: Type.Optional(
        Type.String({
          description:
            "Final report summary for the parent session. Use this when your profile cannot emit text alongside the tool call; otherwise prefer same-message text.",
          minLength: 1,
        }),
      ),
    }),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      recorder.subagentDone();
      if (sessionFile) {
        writeExitSidecar(stampedSidecar(
          { type: "done", ...(wrapupInProgress ? { wrapup: true } : {}) },
          { exitCode: 0, message: "completed" },
        ));
      }
      unregisterCrashHooks();
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}
