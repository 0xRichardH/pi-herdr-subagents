/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";
import { createSubagentActivityRecorder } from "./activity.ts";
import { consumeWrapupDirective } from "./time-limits.ts";

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
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
  return stopReason !== "aborted";
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

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

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
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

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
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let disarmed = false;
  let oneShotReArm = false;
  let warnedOperatorTakeover = false;
  let agentStarted = false;
  let latestAgentMessages: any[] | undefined;
  let wrapupInProgress = false;

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
      || (wrapupInProgress && stopReason !== "aborted");
    if (autoExitShouldFire && oneShotReArm) {
      // Consume the one-shot re-arm: after this exit auto-exit is disarmed
      // again until the operator runs /auto-exit once more.
      oneShotReArm = false;
    }

    if (shouldExit) {
      // Surface stopReason: "error" turns (auto-retry exhausted, provider
      // overload, etc.) to the parent via the .exit sidecar so the watcher
      // can report a clear failure with the underlying error message.
      if (sessionFile) {
        try {
          writeFileSync(
            `${sessionFile}.exit`,
            JSON.stringify(buildCompletionSidecar(latestAgentMessages, wrapupInProgress)),
          );
        } catch {
          // Best effort — the watcher can still detect the terminal sentinel
          // after shutdown if the completion sidecar cannot be written.
        }
      }

      recorder.agentEndDone();
      ctx.shutdown();
      return;
    }
  });

  pi.on("turn_start", (event) => {
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
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Ctrl+J
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

  pi.registerShortcut("ctrl+j", {
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
      const exitData = {
        type: "ping" as const,
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
      };
      writeFileSync(`${sessionFile}.exit`, JSON.stringify(exitData));

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
        writeFileSync(
          `${sessionFile}.exit`,
          JSON.stringify({ type: "done", ...(wrapupInProgress ? { wrapup: true } : {}) }),
        );
      }
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}
