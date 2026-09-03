import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  type Dirent,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { findLastAssistantMessage, type SessionEntry } from "./session.ts";

export type OrphanClassification =
  | "completed-delivered"
  | "completed-undelivered"
  | "interrupted"
  | "phantom"
  | "stale-pane";

export interface SpawnMetadataRecord {
  allowance?: unknown;
  parentSessionFile?: string;
  parentSessionId?: string;
  childSessionFile?: string;
  name?: string;
  agent?: string | null;
  task?: string;
  taskArtifactPath?: string;
  launchedAt?: string;
}

export interface PaneSessionReference {
  paneId: string;
  sessionPath: string;
}

export interface DiscoveredOrphan {
  /** Absolute child session path. This is the deduplication key. */
  sessionFile: string;
  name: string;
  agent?: string;
  task: string;
  classification: OrphanClassification;
  /** Final assistant report when classification is completed-undelivered. */
  report?: string;
  spawnMetadata?: SpawnMetadataRecord;
  /** Herdr pane IDs that currently claim this exact child session path. */
  stalePaneIds: string[];
  /** A prior restore action was durably recorded in the parent session. */
  handled: boolean;
  sources: Array<"sidecar" | "session" | "artifact" | "pane">;
}

export interface OrphanDiscoveryOptions {
  /** Override the directory containing the parent session (mainly for tests). */
  sessionDir?: string;
  /** Override the parent ID when the parent header is unavailable. */
  parentSessionId?: string;
  /** Herdr's persisted pane/session references. No Herdr call is made here. */
  paneSessions?: readonly PaneSessionReference[];
  /** Alias accepted by fixture callers. */
  panes?: readonly PaneSessionReference[];
}

interface Candidate {
  sessionFile: string;
  sources: Set<DiscoveredOrphan["sources"][number]>;
  metadata?: SpawnMetadataRecord;
  hasLineageSidecar: boolean;
  name?: string;
  agent?: string;
  task?: string;
  taskArtifactPath?: string;
  stalePaneIds: Set<string>;
}

interface ArtifactHint {
  sessionFile: string;
  name?: string;
  agent?: string;
  task?: string;
  taskArtifactPath?: string;
}

interface ExitEvidence {
  present: boolean;
  valid: boolean;
}

type DiscoverySource = DiscoveredOrphan["sources"][number];

const ARTIFACT_MAX_DEPTH = 4;
const ARTIFACT_MAX_FILES = 2_000;
const ACTIONABLE_CLASSIFICATIONS = new Set<OrphanClassification>([
  "completed-undelivered",
  "interrupted",
  "phantom",
  "stale-pane",
]);
const RESTORABLE_CLASSIFICATIONS = new Set<OrphanClassification>([
  "interrupted",
  "phantom",
  "stale-pane",
]);

function canonicalPath(path: string, base = process.cwd()): string {
  return resolve(base, path);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJsonFile(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readJsonl(path: string): SessionEntry[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line);
          return isRecord(parsed) ? [parsed as SessionEntry] : [];
        } catch {
          // A crash can leave a partial final line. Keep the valid prefix.
          return [];
        }
      });
  } catch {
    return [];
  }
}

function readSessionHeader(path: string): Record<string, unknown> | null {
  try {
    const firstLine = readFileSync(path, "utf8")
      .split("\n")
      .find((line) => line.trim());
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine);
    return isRecord(parsed) && parsed.type === "session" ? parsed : null;
  } catch {
    return null;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readDir(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walkFiles(path: string, maxDepth = ARTIFACT_MAX_DEPTH): string[] {
  const files: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (files.length >= ARTIFACT_MAX_FILES || depth > maxDepth) return;
    for (const entry of readDir(dir)) {
      if (files.length >= ARTIFACT_MAX_FILES) return;
      const child = join(dir, entry.name);
      if (entry.isDirectory()) visit(child, depth + 1);
      else if (entry.isFile()) files.push(child);
    }
  };
  visit(path, 0);
  return files;
}

function normalizeMetadata(value: unknown): SpawnMetadataRecord | null {
  if (!isRecord(value)) return null;
  const metadata: SpawnMetadataRecord = {};
  for (const key of [
    "parentSessionFile",
    "parentSessionId",
    "childSessionFile",
    "name",
    "agent",
    "task",
    "taskArtifactPath",
    "launchedAt",
  ] as const) {
    const stringValue = nonEmptyString(value[key]);
    if (stringValue) metadata[key] = stringValue;
  }
  if ("allowance" in value) metadata.allowance = value.allowance;
  return metadata;
}

function metadataMatchesParent(
  metadata: SpawnMetadataRecord,
  parentSessionFile: string,
  parentSessionId: string | undefined,
): boolean {
  const parentPath = nonEmptyString(metadata.parentSessionFile);
  const parentId = nonEmptyString(metadata.parentSessionId);
  return Boolean(
    (parentPath && canonicalPath(parentPath) === parentSessionFile) ||
    (parentId && parentSessionId && parentId === parentSessionId),
  );
}

function metadataChildPath(metadata: SpawnMetadataRecord, sidecarPath: string): string {
  const child = nonEmptyString(metadata.childSessionFile);
  if (child) return canonicalPath(child, dirname(sidecarPath));
  return canonicalPath(sidecarPath.slice(0, -".spawn.json".length));
}

function taskFromArtifact(path: string | undefined, baseDir: string): string | undefined {
  const raw = nonEmptyString(path);
  if (!raw) return undefined;
  const candidate = raw.startsWith("@") ? raw.slice(1) : raw;
  const artifactPath = canonicalPath(candidate, baseDir);
  try {
    const content = readFileSync(artifactPath, "utf8").trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

function taskFromMetadata(metadata: SpawnMetadataRecord | undefined, baseDir: string): {
  task?: string;
  taskArtifactPath?: string;
} {
  const task = nonEmptyString(metadata?.task);
  if (task) return { task };
  const artifact = nonEmptyString(metadata?.taskArtifactPath);
  return artifact
    ? { task: taskFromArtifact(artifact, baseDir), taskArtifactPath: artifact }
    : {};
}

function unquoteShellToken(value: string): string {
  const trimmed = value.trim().replace(/[;,]+$/, "");
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}

function firstMatch(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.slice(1).find((part) => typeof part === "string" && part.length > 0);
    if (value) return unquoteShellToken(value);
  }
  return undefined;
}

function artifactHintFromScript(path: string): ArtifactHint | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  const session = firstMatch(text, [
    /^\s*#\s*Session:\s*(.+?)\s*$/m,
    /PI_SUBAGENT_SESSION=(?:'([^']+)'|"([^"]+)"|(\S+))/,
    /--session\s+(?:'([^']+)'|"([^"]+)"|(\S+))/,
  ]);
  // firstMatch handles one capture group at a time; the alternation captures
  // are recovered below for the environment/flag forms.
  const sessionValue = session ?? (() => {
    for (const pattern of [
      /PI_SUBAGENT_SESSION=(?:'([^']+)'|"([^"]+)"|(\S+))/,
      /--session\s+(?:'([^']+)'|"([^"]+)"|(\S+))/,
    ]) {
      const match = text.match(pattern);
      const value = match?.slice(1).find((part) => typeof part === "string" && part.length > 0);
      if (value) return unquoteShellToken(value);
    }
    return undefined;
  })();
  if (!sessionValue) return null;

  const taskArtifactPath = firstMatch(text, [/^\s*#\s*Task artifact:\s*(.+?)\s*$/m]) ?? (() => {
    const matches = text.matchAll(/@(?:"([^"]+)"|'((?:'\\''|[^'])+)'|(\S+))/g);
    for (const match of matches) {
      const value = match.slice(1).find((part) => typeof part === "string" && part.length > 0);
      if (!value) continue;
      const candidate = canonicalPath(unquoteShellToken(value), dirname(path));
      if (isRegularFile(candidate)) return candidate;
    }
    return undefined;
  })();

  const task = taskFromArtifact(taskArtifactPath, dirname(path));
  const name = firstMatch(text, [/^\s*#\s*(?:Subagent|.+? subagent) launch script for\s+(.+?)\s*$/im]);
  const agent = firstMatch(text, [/PI_SUBAGENT_AGENT=(?:'([^']+)'|"([^"]+)"|(\S+))/]);
  return {
    sessionFile: canonicalPath(sessionValue, dirname(path)),
    ...(name ? { name } : {}),
    ...(agent ? { agent } : {}),
    ...(task ? { task } : {}),
    ...(taskArtifactPath ? { taskArtifactPath } : {}),
  };
}

function exitEvidence(sessionFile: string): ExitEvidence {
  const path = `${sessionFile}.exit`;
  if (!existsSync(path)) return { present: false, valid: false };
  const payload = readJsonFile(path);
  const valid = isRecord(payload) &&
    (payload.type === "done" || payload.type === "error" || payload.type === "ping");
  return { present: true, valid };
}

function messageFromEntry(entry: SessionEntry): Record<string, unknown> | null {
  return entry.type === "message" && isRecord(entry.message) ? entry.message : null;
}

function entrySessionReference(entry: SessionEntry): string | undefined {
  const message = messageFromEntry(entry);
  const values = [
    entry.sessionFile,
    entry.sessionPath,
    entry.childSessionFile,
    entry.session_path,
    message?.sessionFile,
    message?.sessionPath,
    message?.childSessionFile,
    message?.session_path,
    isRecord(entry.details) ? entry.details.sessionFile : undefined,
    isRecord(entry.details) ? entry.details.sessionPath : undefined,
    isRecord(entry.details) ? entry.details.childSessionFile : undefined,
    isRecord(entry.details) ? entry.details.session_path : undefined,
    isRecord(message?.details) ? message?.details.sessionFile : undefined,
    isRecord(message?.details) ? message?.details.sessionPath : undefined,
    isRecord(message?.details) ? message?.details.childSessionFile : undefined,
    isRecord(message?.details) ? message?.details.session_path : undefined,
  ];
  return values.find((value): value is string => typeof value === "string" && value.trim() !== "");
}

function customTypeOf(entry: SessionEntry): string | undefined {
  const message = messageFromEntry(entry);
  return nonEmptyString(entry.customType) ?? nonEmptyString(message?.customType);
}

function detailsOf(entry: SessionEntry): Record<string, unknown> | null {
  const message = messageFromEntry(entry);
  if (isRecord(entry.details)) return entry.details;
  return isRecord(message?.details) ? message.details : null;
}

function handledByParent(entries: SessionEntry[], childSessionFile: string): boolean {
  return entries.some((entry) => {
    const customType = customTypeOf(entry);
    const data = isRecord(entry.data) ? entry.data : detailsOf(entry);
    if (customType === "subagent_restore_handled") {
      const path = data?.childSessionFile ?? data?.sessionFile ?? data?.sessionPath;
      return typeof path === "string" && canonicalPath(path) === childSessionFile;
    }
    if (customType !== "subagent_restore_report") return false;
    const reported = data?.reportedChildren;
    if (!Array.isArray(reported)) return false;
    return reported.some((item) => {
      if (!isRecord(item)) return false;
      const path = item.childSessionFile ?? item.sessionFile ?? item.sessionPath;
      return typeof path === "string" && canonicalPath(path) === childSessionFile;
    });
  });
}

function parentRecordedCompletion(
  entries: SessionEntry[],
  childSessionFile: string,
  completionEvidence: boolean,
): boolean {
  return entries.some((entry) => {
    const reference = entrySessionReference(entry);
    if (!reference || canonicalPath(reference) !== childSessionFile) return false;

    const customType = customTypeOf(entry);
    if (customType === "subagent_result") return true;
    if (customType === "subagent_ping" || customType === "subagent_restore_handled") return false;

    const message = messageFromEntry(entry);
    if (message?.role !== "toolResult") return false;
    const details = detailsOf(entry);
    if (details?.status === "started") return false;
    if (
      details?.status === "completed" ||
      details?.status === "done" ||
      details?.status === "delivered" ||
      typeof details?.exitCode === "number"
    ) {
      return true;
    }

    // Old fixtures and older pi sessions did not persist a completion status.
    // A tool result is sufficient only when the child also has durable terminal
    // evidence; the initial "launched" result must not hide an interruption.
    return completionEvidence;
  });
}

function hasTerminalAssistant(entries: SessionEntry[]): boolean {
  // Tool-result entries can trail the final assistant tool call. Look for the
  // latest assistant rather than assuming the final JSONL line is a message.
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const message = messageFromEntry(entries[i]);
    if (!message) continue;
    // A later user message means a new turn is in flight. Tool results are
    // allowed to trail the final subagent_done assistant call.
    if (message.role === "user") return false;
    if (message.role !== "assistant") continue;
    if (message.stopReason === "stop" || message.stopReason === "error") return true;

    // subagent_done writes .exit before shutdown; this catches the narrow
    // race where the parent consumed that sidecar before the child tool result
    // was flushed, while ordinary toolUse turns remain interrupted.
    const blocks = Array.isArray(message.content) ? message.content : [];
    const toolCalls = [message.toolCalls, message.tool_calls, message.toolCall]
      .filter((value): value is unknown[] => Array.isArray(value))
      .flat();
    return [...blocks, ...toolCalls].some((block) =>
      isRecord(block) &&
      (block.name === "subagent_done" || block.toolName === "subagent_done" || block.tool === "subagent_done"),
    );
  }
  return false;
}

function sessionExists(path: string): boolean {
  return isRegularFile(path);
}

function hasChildEntries(entries: SessionEntry[], parentEntries: SessionEntry[]): boolean {
  const parentIds = new Set(parentEntries.map((entry) => entry.id).filter(Boolean));
  return entries.some((entry) =>
    entry.type !== "session" && typeof entry.id === "string" && !parentIds.has(entry.id),
  );
}

function upsertCandidate(
  candidates: Map<string, Candidate>,
  path: string,
  source: DiscoverySource,
  hint: Partial<Candidate> = {},
): Candidate {
  const sessionFile = canonicalPath(path);
  let candidate = candidates.get(sessionFile);
  if (!candidate) {
    candidate = {
      sessionFile,
      sources: new Set(),
      hasLineageSidecar: false,
      stalePaneIds: new Set(),
    };
    candidates.set(sessionFile, candidate);
  }
  candidate.sources.add(source);
  if (hint.name && !candidate.name) candidate.name = hint.name;
  if (hint.agent && !candidate.agent) candidate.agent = hint.agent;
  if (hint.task && !candidate.task) candidate.task = hint.task;
  if (hint.taskArtifactPath && !candidate.taskArtifactPath) candidate.taskArtifactPath = hint.taskArtifactPath;
  return candidate;
}

function mergeMetadata(candidate: Candidate, metadata: SpawnMetadataRecord, baseDir: string): void {
  candidate.metadata = { ...candidate.metadata, ...metadata };
  const task = taskFromMetadata(metadata, baseDir);
  candidate.name = nonEmptyString(metadata.name) ?? candidate.name;
  candidate.agent = nonEmptyString(metadata.agent) ?? candidate.agent;
  candidate.task = task.task ?? candidate.task;
  candidate.taskArtifactPath = task.taskArtifactPath ?? candidate.taskArtifactPath;
}

function sourceList(candidate: Candidate): DiscoveredOrphan["sources"] {
  return ["sidecar", "session", "artifact", "pane"].filter((source) => candidate.sources.has(source)) as DiscoveredOrphan["sources"];
}

export function isActionableOrphan(child: Pick<DiscoveredOrphan, "classification" | "handled">): boolean {
  return !child.handled && ACTIONABLE_CLASSIFICATIONS.has(child.classification);
}

export function isRestorableOrphan(child: Pick<DiscoveredOrphan, "classification" | "handled">): boolean {
  return !child.handled && RESTORABLE_CLASSIFICATIONS.has(child.classification);
}

export function taskExcerpt(task: string, maxLength = 240): string {
  const compact = task.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function discoverOrphanedSubagents(
  parentSessionFile: string,
  options: OrphanDiscoveryOptions = {},
): DiscoveredOrphan[] {
  const parentPath = canonicalPath(parentSessionFile);
  const sessionDir = canonicalPath(options.sessionDir ?? dirname(parentPath));
  const parentHeader = readSessionHeader(parentPath);
  const parentId = nonEmptyString(options.parentSessionId) ?? nonEmptyString(parentHeader?.id);
  const parentEntries = readJsonl(parentPath);
  const candidates = new Map<string, Candidate>();

  // Seeded lineage headers cover lineage-only and fork modes. This scan stays
  // in the parent session directory; standalone/custom-cwd launches are found
  // through their sidecar or the artifact launch script below.
  for (const entry of readDir(sessionDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const path = join(sessionDir, entry.name);
    const header = readSessionHeader(path);
    const linkedParent = nonEmptyString(header?.parentSession);
    if (linkedParent && canonicalPath(linkedParent, dirname(path)) === parentPath) {
      upsertCandidate(candidates, path, "session");
    }
  }

  const artifactDir = parentId ? join(sessionDir, "artifacts", parentId) : undefined;
  if (artifactDir) {
    for (const path of walkFiles(artifactDir)) {
      if (!path.endsWith(".sh")) continue;
      const hint = artifactHintFromScript(path);
      if (!hint) continue;
      upsertCandidate(candidates, hint.sessionFile, "artifact", hint);
    }
  }

  // New launch sidecars are the authoritative standalone/phantom index. A
  // malformed sidecar is ignored; the parent/session/artifact sources still
  // provide a conservative fallback.
  for (const entry of readDir(sessionDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".spawn.json")) continue;
    const sidecarPath = join(sessionDir, entry.name);
    const metadata = normalizeMetadata(readJsonFile(sidecarPath));
    if (!metadata || !metadataMatchesParent(metadata, parentPath, parentId)) continue;
    const childPath = metadataChildPath(metadata, sidecarPath);
    if (childPath === parentPath) continue;
    const candidate = upsertCandidate(candidates, childPath, "sidecar");
    candidate.hasLineageSidecar = true;
    mergeMetadata(candidate, metadata, dirname(sidecarPath));
  }

  // Artifact scripts can point to a child session directory selected by cwd.
  // Read its sidecar after the path has been recovered, even when that sidecar
  // lives outside the parent's own session directory.
  for (const candidate of candidates.values()) {
    const sidecarPath = `${candidate.sessionFile}.spawn.json`;
    if (!isRegularFile(sidecarPath)) continue;
    const metadata = normalizeMetadata(readJsonFile(sidecarPath));
    if (!metadata || !metadataMatchesParent(metadata, parentPath, parentId)) continue;
    candidate.sources.add("sidecar");
    candidate.hasLineageSidecar = true;
    mergeMetadata(candidate, metadata, dirname(sidecarPath));
  }

  // A pane reference is only allowed to attach to a path already discovered
  // from durable parent-owned evidence. This prevents a crew/orchestrator pane
  // from becoming a restore target merely because it has a session path.
  const paneSessions = options.paneSessions ?? options.panes ?? [];
  for (const pane of paneSessions) {
    const paneId = nonEmptyString(pane?.paneId);
    const path = nonEmptyString(pane?.sessionPath);
    if (!paneId || !path) continue;
    const candidate = candidates.get(canonicalPath(path));
    if (!candidate) continue;
    candidate.sources.add("pane");
    candidate.stalePaneIds.add(paneId);
  }

  const result: DiscoveredOrphan[] = [];
  for (const candidate of candidates.values()) {
    const fileExists = sessionExists(candidate.sessionFile);
    const entries = fileExists ? readJsonl(candidate.sessionFile) : [];
    const hasOwnEntries = fileExists && hasChildEntries(entries, parentEntries);
    const report = hasOwnEntries ? findLastAssistantMessage(entries) : null;
    const usableReport = typeof report === "string" && report.trim() ? report.trim() : undefined;
    const exit = exitEvidence(candidate.sessionFile);
    const terminalAssistant = hasOwnEntries && hasTerminalAssistant(entries);
    // An invalid/truncated .exit is not completion evidence. An absent sidecar
    // may be the narrow consumed-before-delivery race, so a terminal child
    // report is accepted only when no malformed sidecar is present.
    const completionEvidence = exit.valid || (!exit.present && terminalAssistant);
    const delivered = parentRecordedCompletion(parentEntries, candidate.sessionFile, completionEvidence);
    const handled = handledByParent(parentEntries, candidate.sessionFile);

    let classification: OrphanClassification;
    if (delivered) {
      classification = "completed-delivered";
    } else if (!fileExists && candidate.hasLineageSidecar) {
      classification = "phantom";
    } else if (usableReport && completionEvidence) {
      classification = "completed-undelivered";
    } else if (fileExists && candidate.stalePaneIds.size > 0) {
      classification = "stale-pane";
    } else if (fileExists) {
      classification = "interrupted";
    } else if (candidate.hasLineageSidecar) {
      classification = "phantom";
    } else {
      // An artifact reference without a session or enriched sidecar is not
      // enough to claim a phantom; do not invent a child from stale artifacts.
      continue;
    }

    const hintTask = candidate.task ?? taskFromMetadata(candidate.metadata, sessionDir).task;
    const agent = candidate.agent ?? candidate.metadata?.agent;
    result.push({
      sessionFile: candidate.sessionFile,
      name: candidate.name ?? candidate.metadata?.name ?? basename(candidate.sessionFile, ".jsonl"),
      ...(agent ? { agent } : {}),
      task: hintTask ?? "",
      classification,
      ...(classification === "completed-undelivered" && usableReport ? { report: usableReport } : {}),
      ...(candidate.metadata ? { spawnMetadata: candidate.metadata } : {}),
      stalePaneIds: [...candidate.stalePaneIds],
      handled,
      sources: sourceList(candidate),
    });
  }

  return result.sort((a, b) => a.sessionFile.localeCompare(b.sessionFile));
}

export function formatOrphanRestoreReport(children: readonly DiscoveredOrphan[]): string {
  const pending = children.filter(isActionableOrphan);
  if (pending.length === 0) return "";

  const lines = [
    `Crash restore found ${pending.length} orphaned subagent${pending.length === 1 ? "" : "s"}:`,
  ];
  for (const child of pending) {
    const agent = child.agent ? child.agent : "(unknown)";
    lines.push(`- ${child.name}, agent ${agent} — ${taskExcerpt(child.task) || "(task unavailable)"}`);
    lines.push(`  Session: ${child.sessionFile}`);
    lines.push(`  Classification: ${child.classification}`);
    if (child.classification === "completed-undelivered" && child.report) {
      lines.push("  Stored final report:");
      for (const reportLine of child.report.split("\n")) lines.push(`    ${reportLine}`);
    }
  }
  lines.push(
    "",
    'Restore contract: when the user sends "resume", resume each interrupted or stale-pane child by calling subagent_resume with its session path; use an auto-exit one-shot continuation that asks the child to re-orient from its session and finish. Relaunch each phantom via subagent with its recorded task. Do nothing for completed-delivered children.',
  );
  return lines.join("\n");
}

export interface OrphanResumeOperations {
  closePane: (paneId: string, child: DiscoveredOrphan) => void | Promise<void>;
  resume: (child: DiscoveredOrphan) => Promise<unknown>;
  relaunch: (child: DiscoveredOrphan) => Promise<unknown>;
}

export interface OrphanResumeOutcome {
  child: DiscoveredOrphan;
  action: "resume" | "relaunch";
  ok: boolean;
  result?: unknown;
  error?: string;
}

export async function resumeOrphanedSubagents(
  children: readonly DiscoveredOrphan[],
  operations: OrphanResumeOperations,
): Promise<OrphanResumeOutcome[]> {
  const outcomes: OrphanResumeOutcome[] = [];
  for (const child of children) {
    if (!isRestorableOrphan(child)) continue;
    try {
      // Never launch a second writer until every pane claiming this exact path
      // has been closed. Pane IDs come only from the discovered path match.
      for (const paneId of child.stalePaneIds) await operations.closePane(paneId, child);
      const action = child.classification === "phantom" ? "relaunch" : "resume";
      const result = action === "relaunch"
        ? await operations.relaunch(child)
        : await operations.resume(child);
      outcomes.push({ child, action, ok: true, result });
    } catch (error) {
      outcomes.push({
        child,
        action: child.classification === "phantom" ? "relaunch" : "resume",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}

export const __orphanDiscoveryTest__ = {
  artifactHintFromScript,
  exitEvidence,
  hasTerminalAssistant,
  parentRecordedCompletion,
  taskFromArtifact,
  taskExcerpt,
};
