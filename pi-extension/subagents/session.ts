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
  const lastContent: any[] = Array.isArray(lastMsg.content) ? lastMsg.content : [];

  // (1) final same-message text
  const lastTexts = lastContent
    .filter((block: any) => block.type === "text" && typeof block.text === "string" && block.text.trim() !== "")
    .map((block: any) => block.text as string);
  if (lastTexts.length > 0 && lastTexts.join("").trim()) return lastTexts.join("\n");

  // (2) final subagent_done toolCall arguments.report (non-empty string)
  const extractReport = (blocks: any[]): string | null => {
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
  };

  const reportFromContent = extractReport(lastContent);
  if (reportFromContent !== null) return reportFromContent;

  // Also check alternative message-level tool-call arrays (defensive: some Pi builds store tool calls outside content).
  const altArrays: any[] = [];
  if (Array.isArray(lastMsg.toolCalls)) altArrays.push(...lastMsg.toolCalls);
  if (Array.isArray(lastMsg.tool_calls)) altArrays.push(...lastMsg.tool_calls);
  if (Array.isArray(lastMsg.toolCall)) altArrays.push(...lastMsg.toolCall);
  if (altArrays.length > 0) {
    const altReport = extractReport(altArrays);
    if (altReport !== null) return altReport;
  }

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
