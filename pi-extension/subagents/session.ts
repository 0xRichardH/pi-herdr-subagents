import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string;
  [key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
}

export type SeededSubagentSessionMode = "lineage-only" | "fork";

function getForkContentLines(parentSessionFile: string): string[] {
  const raw = readFileSync(parentSessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());

  let truncateAt = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === "message" && entry.message?.role === "user") {
        truncateAt = i;
        break;
      }
    } catch {
      // ignore malformed lines
    }
  }

  return lines.slice(0, truncateAt).filter((line) => {
    try {
      return JSON.parse(line).type !== "session";
    } catch {
      return true;
    }
  });
}

export function seedSubagentSessionFile(params: {
  mode: SeededSubagentSessionMode;
  parentSessionFile: string;
  childSessionFile: string;
  childCwd: string;
}): void {
  const header = {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: params.childCwd,
    parentSession: params.parentSessionFile,
  };
  const contentLines =
    params.mode === "fork" ? getForkContentLines(params.parentSessionFile) : [];
  const lines = [JSON.stringify(header), ...contentLines];

  mkdirSync(dirname(params.childSessionFile), { recursive: true });
  writeFileSync(params.childSessionFile, lines.join("\n") + "\n", "utf8");
}

function readEntries(sessionFile: string): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as SessionEntry];
      } catch {
        return [];
      }
    });
}

/**
 * Return the id of the last entry in the session file (current branch point / leaf).
 */
export function getLeafId(sessionFile: string): string | null {
  const entries = readEntries(sessionFile);
  return entries.length > 0 ? entries[entries.length - 1].id : null;
}

/**
 * Return entries added after `afterLine` (1-indexed count of existing entries).
 */
export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  return lines.slice(afterLine).flatMap((line) => {
    try {
      return [JSON.parse(line) as SessionEntry];
    } catch {
      return [];
    }
  });
}

/**
 * Find the last assistant message text in a list of entries.
 *
 * Falls back to the `errorMessage` field when the last assistant message has
 * `stopReason: "error"` and no usable text content — this happens when
 * auto-retry exhausts on a provider overload / rate limit / server error, and
 * without this fallback the parent would silently see a stale earlier message.
 */
export interface ObservedSessionRuntime {
  provider?: string;
  modelId?: string;
  thinking?: string;
}

/** Read the effective model and thinking entries recorded by Pi at session startup. */
export function findObservedSessionRuntime(entries: SessionEntry[]): ObservedSessionRuntime {
  const observed: ObservedSessionRuntime = {};
  for (const entry of entries) {
    if (entry.type === "model_change") {
      if (typeof entry.provider === "string") observed.provider = entry.provider;
      if (typeof entry.modelId === "string") observed.modelId = entry.modelId;
    } else if (
      entry.type === "thinking_level_change" &&
      typeof entry.thinkingLevel === "string"
    ) {
      observed.thinking = entry.thinkingLevel;
    }
  }
  return observed;
}

export interface ServedSessionRuntime {
  provider?: string;
  modelId?: string;
  api?: string;
}

/**
 * Read the runtime that actually SERVED the child's final assistant turn.
 *
 * TASK-336: the runtime-mismatch check used to compare the resolved launch
 * model against the last *declared* `model_change` (findObservedSessionRuntime)
 * — a switch target the child may never have run (occurrence #17 named a model
 * that never served a token). This reads the provider/model/api of the final
 * assistant `message` entry instead; an error turn still counts, because that
 * is the provider that attempted to serve it.
 */
export function findServedSessionRuntime(entries: SessionEntry[]): ServedSessionRuntime {
  const served: ServedSessionRuntime = {};
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = (entry as { message?: Record<string, unknown> }).message;
    if (!message || message.role !== "assistant") continue;
    if (typeof message.provider !== "string" && typeof message.model !== "string") continue;
    if (typeof message.provider === "string") served.provider = message.provider;
    if (typeof message.model === "string") served.modelId = message.model;
    if (typeof message.api === "string") served.api = message.api;
  }
  return served;
}

export interface SessionFallbackRecord {
  kind: "agent-fallback" | "provider-failover";
  from?: string;
  to?: string;
  reason?: string;
}

/**
 * Read the last recorded failover declaration from the child session. Both the
 * agent-profile chain (`agent-fallback`) and pi-multi-account
 * (`provider-failover`) write a `custom` entry whose `data.to` is the fallback
 * target and `data.reason` the cause.
 */
export function findSessionFallbackRecord(entries: SessionEntry[]): SessionFallbackRecord | undefined {
  let record: SessionFallbackRecord | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    const customType = entry.customType;
    if (customType !== "agent-fallback" && customType !== "provider-failover") continue;
    const data = entry.data as Record<string, unknown> | undefined;
    if (!data || typeof data !== "object") continue;
    record = {
      kind: customType,
      ...(typeof data.from === "string" ? { from: data.from } : {}),
      ...(typeof data.to === "string" ? { to: data.to } : {}),
      ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
    };
  }
  return record;
}

export interface RuntimeObservation {
  /** Last declared model_change / thinking_level_change (unchanged semantics). */
  observed: ObservedSessionRuntime;
  /** Model that served the final assistant turn, when one exists. */
  served?: { provider: string; modelId: string; api?: string };
  /** Last declared fallback record, when one exists. */
  fallback?: SessionFallbackRecord;
  /**
   * Reserved for a served model that differs from the resolved launch model
   * with NO recorded fallback: an unexplained substitution.
   */
  runtimeMismatch?: string;
  /** Informational note when the served model IS the recorded fallback target. */
  runtimeFallback?: string;
}

/**
 * TASK-336: classify what the child session actually did. The mismatch warning
 * is reserved for a served model that differs from the resolved launch model
 * with no fallback record; a served fallback target is informational, and a
 * session whose declared model_change never served a turn is not reported as
 * having run that model.
 */
export function classifyRuntimeObservation(
  entries: SessionEntry[],
  resolvedModel: string | undefined,
): RuntimeObservation {
  const observed = findObservedSessionRuntime(entries);
  const servedRuntime = findServedSessionRuntime(entries);
  const fallback = findSessionFallbackRecord(entries);
  const served =
    servedRuntime.provider && servedRuntime.modelId
      ? {
          provider: servedRuntime.provider,
          modelId: servedRuntime.modelId,
          ...(servedRuntime.api ? { api: servedRuntime.api } : {}),
        }
      : undefined;
  const servedModel = served ? `${served.provider}/${served.modelId}` : undefined;

  const observation: RuntimeObservation = {
    observed,
    ...(served ? { served } : {}),
    ...(fallback ? { fallback } : {}),
  };

  if (!servedModel || !resolvedModel || servedModel === resolvedModel) return observation;

  if (fallback?.to === servedModel) {
    observation.runtimeFallback = `Resolved model ${resolvedModel}; fell back to ${servedModel}${
      fallback.reason ? ` (${fallback.reason})` : ""
    }`;
  } else {
    observation.runtimeMismatch = `Resolved model ${resolvedModel} but child served ${servedModel}`;
  }
  return observation;
}

/**
 * The `subagent_done` report argument extracted from one block list. Only the
 * `subagent_done` tool is considered; a non-empty trimmed string wins.
 */
function extractSubagentDoneReport(blocks: any[]): string | null {
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const type = (block as any).type;
    const toolName = (block as any).name ?? (block as any).toolName ?? (block as any).tool ?? "";
    // Only consider subagent_done tool calls; skip other tools even if they happen to have a report field.
    if (toolName !== "subagent_done") {
      if (type === "toolCall" || type === "tool_call" || type === "functionCall" || type === "function_call") continue;
      continue;
    }
    let report: unknown;
    const candidates = [
      (block as any).arguments,
      (block as any).args,
      (block as any).input,
      (block as any).parameters,
      (block as any).params,
    ];
    for (const cand of candidates) {
      if (cand == null) continue;
      if (typeof cand === "object" && typeof (cand as any).report === "string") {
        report = (cand as any).report;
        break;
      }
      if (typeof cand === "string") {
        try {
          const parsed = JSON.parse(cand);
          if (typeof parsed.report === "string") {
            report = parsed.report;
            break;
          }
        } catch {
          // ignore malformed JSON in report argument; treat as no report
          void 0;
        }
      }
    }
    if (report === undefined && typeof (block as any).report === "string") report = (block as any).report;
    if (typeof report === "string" && report.trim() !== "") return report.trim();
  }
  return null;
}

/**
 * TASK-337: extract the *terminal report* from a single final assistant
 * message — the same-message text or a non-empty `subagent_done` `report`
 * argument. This is the substantive-evidence admission check: a completion
 * whose final assistant turn carries neither is reportless, and an exit code
 * alone must never admit it. Earlier assistant text is deliberately excluded
 * (the tool contract requires the report in the same message as the call).
 */
export function extractTerminalReportFromMessage(lastMsg: any): string | null {
  const lastContent: any[] = Array.isArray(lastMsg.content) ? lastMsg.content : [];

  // (1) final same-message text
  const lastTexts = lastContent
    .filter((block: any) => block.type === "text" && typeof block.text === "string" && block.text.trim() !== "")
    .map((block: any) => block.text as string);
  if (lastTexts.length > 0 && lastTexts.join("").trim()) return lastTexts.join("\n");

  // (2) final subagent_done toolCall arguments.report (non-empty string)
  const reportFromContent = extractSubagentDoneReport(lastContent);
  if (reportFromContent !== null) return reportFromContent;

  // Also check alternative message-level tool-call arrays (defensive: some Pi builds store tool calls outside content).
  const altArrays: any[] = [];
  if (Array.isArray(lastMsg.toolCalls)) altArrays.push(...lastMsg.toolCalls);
  if (Array.isArray(lastMsg.tool_calls)) altArrays.push(...lastMsg.tool_calls);
  if (Array.isArray(lastMsg.toolCall)) altArrays.push(...lastMsg.toolCall);
  if (altArrays.length > 0) {
    const altReport = extractSubagentDoneReport(altArrays);
    if (altReport !== null) return altReport;
  }
  return null;
}

/**
 * TASK-337: the terminal report of the last assistant turn, or null. Used by
 * the completion-admission check so a reportless exit-0 run is classified as
 * an explicit failure instead of being admitted as `completed`.
 */
export function findTerminalReport(entries: SessionEntry[]): string | null {
  let lastIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;
    lastIdx = i;
    break;
  }
  if (lastIdx === -1) return null;
  return extractTerminalReportFromMessage((entries[lastIdx] as MessageEntry).message as any);
}

export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
  // Deep's L-162 phase 2 priority chain:
  // (1) final same-message text; (2) final subagent_done arguments.report (non-empty);
  // (3) final provider error; (4) most recent earlier assistant text; (5) null.
  // This keeps Muse's text+toolCall impossibility from silencing the report,
  // while error-over-stale-text remains intact for overload failures.
  let lastIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;
    lastIdx = i;
    break;
  }
  if (lastIdx === -1) return null;

  const lastEntry = entries[lastIdx] as MessageEntry;
  const lastMsg: any = lastEntry.message as any;

  // (1)+(2) terminal report in the final assistant message.
  const terminalReport = extractTerminalReportFromMessage(lastMsg);
  if (terminalReport !== null) return terminalReport;

  // (3) final provider error (stopReason: "error" with errorMessage)
  const stopReason = (lastMsg as { stopReason?: unknown }).stopReason;
  const errorMessage = (lastMsg as { errorMessage?: unknown }).errorMessage;
  if (stopReason === "error" && typeof errorMessage === "string" && errorMessage.trim() !== "") {
    return `Subagent error: ${errorMessage.trim()}`;
  }

  // (4) most recent earlier assistant text (fallback)
  for (let i = lastIdx - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;
    const texts = (msg.message.content || [])
      .filter((block: any) => block.type === "text" && typeof block.text === "string" && block.text.trim() !== "")
      .map((block: any) => block.text as string);
    if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");
  }

  // (5) null → caller falls back to "Sub-agent exited without output"
  return null;
}

/**
 * Classify why a child run ended without a normal completion (TASK-326).
 *
 * Grounded in the two real owner-closed transcripts observed 2026-09-21
 * (19 and 22 successful tool calls, zero error entries): one ended with an
 * assistant turn whose `stopReason` was `aborted`; the other was cut off
 * mid-turn (`stopReason: "toolUse"` with no terminal sidecar). Only a genuine
 * provider/transport failure carries `stopReason: "error"` alongside the
 * provider's own error message, so that is the sole case allowed to keep the
 * provider-failure wording. A session with no assistant turn at all produced
 * no result; a terminal turn whose completion evidence was lost is reported
 * as no-result rather than as a provider outage.
 */
export function classifySessionFailure(
  entries: SessionEntry[],
): "provider" | "operator" | "no-result" {
  let lastIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message" && (entry as MessageEntry).message.role === "assistant") {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx === -1) return "no-result";

  const stopReason = ((entries[lastIdx] as MessageEntry).message as { stopReason?: unknown })
    .stopReason;
  if (stopReason === "error") return "provider";
  if (stopReason === "aborted" || stopReason === "toolUse") return "operator";
  return "no-result";
}

/**
 * Append a branch_summary entry to the session file.
 * Returns the new entry's id.
 */
export function appendBranchSummary(
  sessionFile: string,
  branchPointId: string,
  fromId: string | null,
  summary: string,
): string {
  const id = randomBytes(4).toString("hex");
  const entry = {
    type: "branch_summary",
    id,
    parentId: branchPointId,
    timestamp: new Date().toISOString(),
    fromId: fromId ?? branchPointId,
    summary,
  };
  appendFileSync(sessionFile, JSON.stringify(entry) + "\n", "utf8");
  return id;
}

/**
 * Copy the session file to destDir for parallel worker isolation.
 * Returns the path of the copy.
 */
export function copySessionFile(sessionFile: string, destDir: string): string {
  const id = randomBytes(4).toString("hex");
  const dest = join(destDir, `subagent-${id}.jsonl`);
  copyFileSync(sessionFile, dest);
  return dest;
}

/**
 * Read new entries from sourceFile (after afterLine), append them to targetFile.
 * Returns the appended entries.
 */
export function mergeNewEntries(
  sourceFile: string,
  targetFile: string,
  afterLine: number,
): SessionEntry[] {
  const entries = getNewEntries(sourceFile, afterLine);
  for (const entry of entries) {
    appendFileSync(targetFile, JSON.stringify(entry) + "\n", "utf8");
  }
  return entries;
}
