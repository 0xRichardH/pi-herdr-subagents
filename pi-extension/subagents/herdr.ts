import { execFile, execSync, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const commandAvailability = new Map<string, boolean>();
const HERDR_COMMAND_TIMEOUT_MS = 2_000;

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  if (process.platform === "win32") {
    try {
      execFileSync("where.exe", [command], { stdio: "ignore" });
      available = true;
    } catch {
      try {
        execSync(`command -v ${command}`, { stdio: "ignore" });
        available = true;
      } catch {
        available = false;
      }
    }
  } else {
    try {
      execSync(`command -v ${command}`, { stdio: "ignore" });
      available = true;
    } catch {
      available = false;
    }
  }

  commandAvailability.set(command, available);
  return available;
}

export function isHerdrAvailable(): boolean {
  return process.env.HERDR_ENV === "1" && hasCommand("herdr");
}

function parseHerdrJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractHerdrPaneId(output: string, context: string): string {
  const parsed = parseHerdrJson(output);
  const paneId = (parsed as { result?: { pane?: { pane_id?: unknown } } })?.result?.pane?.pane_id;
  if (typeof paneId !== "string" || !paneId) {
    throw new Error(`Unexpected herdr ${context} output: ${output.trim() || "(empty)"}`);
  }
  return paneId;
}

function extractHerdrRootPaneId(output: string, context: string): string {
  const parsed = parseHerdrJson(output);
  const paneId = (parsed as { result?: { root_pane?: { pane_id?: unknown } } })?.result?.root_pane
    ?.pane_id;
  if (typeof paneId !== "string" || !paneId) {
    throw new Error(`Unexpected herdr ${context} output: ${output.trim() || "(empty)"}`);
  }
  return paneId;
}

function herdrExec(args: string[]): string {
  return execFileSync("herdr", args, { encoding: "utf8" });
}

async function herdrExecAsync(
  args: string[],
  timeoutMs = HERDR_COMMAND_TIMEOUT_MS,
): Promise<string> {
  const { stdout } = await execFileAsync("herdr", args, {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return stdout;
}

function getHerdrParentPaneId(): string {
  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) {
    throw new Error("HERDR_PANE_ID not set");
  }
  return paneId;
}

function getHerdrCurrentPaneInfo(): {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
} {
  const paneId = process.env.HERDR_PANE_ID;
  const tabId = process.env.HERDR_TAB_ID;
  const workspaceId = process.env.HERDR_WORKSPACE_ID;

  // Fall back to `herdr pane current` if any identity env var is missing —
  // older herdr versions may not set all three.
  if (!paneId || !tabId || !workspaceId) {
    const output = herdrExec(["pane", "current"]);
    const parsed = parseHerdrJson(output);
    const pane = (parsed as { result?: { pane?: unknown } } | null)?.result?.pane as
      | { pane_id?: string; tab_id?: string; workspace_id?: string }
      | undefined;
    if (!pane?.pane_id || !pane?.tab_id || !pane?.workspace_id) {
      throw new Error(`Unexpected herdr pane current output: ${output.trim() || "(empty)"}`);
    }
    return {
      pane_id: pane.pane_id,
      tab_id: pane.tab_id,
      workspace_id: pane.workspace_id,
    };
  }

  return { pane_id: paneId, tab_id: tabId, workspace_id: workspaceId };
}

function buildTabCreateArgs(name: string, cwd: string, workspaceId: string): string[] {
  return [
    "tab",
    "create",
    "--workspace",
    workspaceId,
    "--label",
    name,
    "--cwd",
    cwd,
    "--no-focus",
  ];
}

export function createHerdrSurface(name: string): string {
  // Create a new tab per subagent so parallel spawns each get a full tab
  // instead of ever-narrower splits of the parent pane. Target the current
  // workspace explicitly because Herdr's implicit default may be another space.
  const { workspace_id: workspaceId } = getHerdrCurrentPaneInfo();
  const output = herdrExec(buildTabCreateArgs(name, process.cwd(), workspaceId));
  const paneId = extractHerdrRootPaneId(output, "tab create");
  try {
    herdrExec(["pane", "rename", paneId, name]);
  } catch {
    // Optional — pane label is cosmetic.
  }
  return paneId;
}

export function createHerdrSurfaceSplit(
  name: string,
  direction: "right" | "down",
): string {
  const parentPaneId = getHerdrParentPaneId();
  const output = herdrExec([
    "pane",
    "split",
    parentPaneId,
    "--direction",
    direction,
    "--no-focus",
    "--cwd",
    process.cwd(),
  ]);
  const paneId = extractHerdrPaneId(output, "pane split");
  try {
    herdrExec(["pane", "rename", paneId, name]);
  } catch {
    // Optional.
  }
  return paneId;
}

export type HerdrReadSource = "visible" | "recent" | "recent-unwrapped" | "detection";

/**
 * Build a `herdr pane read` invocation. `visible` (the viewport) stays the
 * default for the existing inline tail; scrollback snapshots pass an explicit
 * `recent-unwrapped` source so the last N KiB survive the pane close.
 */
export function buildPaneReadArgs(
  surface: string,
  lines: number,
  source: HerdrReadSource = "visible",
): string[] {
  return ["pane", "read", surface, "--source", source, "--lines", String(lines)];
}

export function readHerdrScreen(
  surface: string,
  lines = 50,
  source: HerdrReadSource = "visible",
): string {
  // `visible` is reliable for freshly created panes where herdr's `recent`
  // scrollback may not be populated yet.
  return herdrExec(buildPaneReadArgs(surface, lines, source));
}

export async function readHerdrScreenAsync(
  surface: string,
  lines = 50,
  source: HerdrReadSource = "visible",
): Promise<string> {
  return herdrExecAsync(buildPaneReadArgs(surface, lines, source));
}

export type { PaneInspection, HerdrAgentStatus } from "./lifecycle.ts";

type PaneInspectionResult =
  | {
      kind: "present";
      agent?: string;
      agentStatus: "idle" | "working" | "blocked" | "done" | "unknown";
      workerPid?: number;
      workerPgid?: number;
    }
  | { kind: "missing"; error?: string }
  | { kind: "unavailable"; error: string };

function parseProcessId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(?:Some\(\s*(\d+)\s*\)|(\d+))$/);
  if (!match) return undefined;
  const parsed = Number(match[1] ?? match[2]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function commandLooksLikePi(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const first = value.trim().split(/\s+/, 1)[0];
  return first === "pi" || first.endsWith("/pi");
}

interface PaneProcessInspection {
  workerPid?: number;
  workerPgid?: number;
}

function parsePaneProcessInfoOutput(
  output: string,
  surface: string,
): PaneProcessInspection | null {
  const parsed = parseHerdrJson(output) as
    | { result?: { process_info?: unknown }; error?: { code?: unknown } }
    | null;
  if (parsed?.error) return null;
  const processInfo = parsed?.result?.process_info;
  if (!processInfo || typeof processInfo !== "object") return null;

  const record = processInfo as {
    pane_id?: unknown;
    foreground_process_group_id?: unknown;
    foreground_processes?: unknown;
    worker_pid?: unknown;
    worker_pgid?: unknown;
  };
  if (record.pane_id !== undefined && record.pane_id !== surface) return null;

  const processes = Array.isArray(record.foreground_processes)
    ? record.foreground_processes.filter((process): process is Record<string, unknown> =>
        !!process && typeof process === "object")
    : [];
  const worker = processes.find((process) =>
    commandLooksLikePi(process.name) ||
    commandLooksLikePi(process.argv0) ||
    (Array.isArray(process.argv) && commandLooksLikePi(process.argv[0])) ||
    commandLooksLikePi(process.cmdline));
  const workerPid = parseProcessId(record.worker_pid) ?? parseProcessId(worker?.pid);
  const workerPgid = parseProcessId(record.worker_pgid) ??
    (worker ? parseProcessId(record.foreground_process_group_id) : undefined);

  return {
    ...(workerPid == null ? {} : { workerPid }),
    ...(workerPgid == null ? {} : { workerPgid }),
  };
}

function parsePaneGetOutput(output: string, surface: string): PaneInspectionResult {
  const parsed = parseHerdrJson(output) as
    | { result?: { pane?: unknown }; error?: { code?: unknown; message?: unknown } }
    | null;
  const errorObj = parsed?.error;
  if (errorObj?.code === "pane_not_found" || errorObj?.code === "not_found") {
    return { kind: "missing", error: typeof errorObj.message === "string" ? errorObj.message : "pane not found" };
  }
  const pane = parsed?.result?.pane;
  if (!pane || typeof pane !== "object") return { kind: "unavailable", error: "pane get returned no pane record" };
  const record = pane as {
    pane_id?: unknown;
    agent?: unknown;
    agent_status?: unknown;
    worker_pid?: unknown;
    worker_pgid?: unknown;
    pgid?: unknown;
    process?: unknown;
  };
  if (record.pane_id !== surface) return { kind: "unavailable", error: "pane id mismatch" };
  const agent = typeof record.agent === "string" ? record.agent : undefined;
  const rawStatus = typeof record.agent_status === "string" ? record.agent_status : "unknown";
  const agentStatus = rawStatus === "idle" ||
      rawStatus === "working" ||
      rawStatus === "blocked" ||
      rawStatus === "done" ||
      rawStatus === "unknown"
    ? rawStatus
    : "unknown";
  const processRecord = record.process && typeof record.process === "object"
    ? record.process as { pgid?: unknown; pid?: unknown }
    : undefined;
  const workerPid = parseProcessId(record.worker_pid) ?? parseProcessId(processRecord?.pid);
  const workerPgid = parseProcessId(record.worker_pgid) ??
    parseProcessId(record.pgid) ??
    parseProcessId(processRecord?.pgid);
  return {
    kind: "present",
    ...(agent ? { agent } : {}),
    agentStatus,
    ...(workerPid == null ? {} : { workerPid }),
    ...(workerPgid == null ? {} : { workerPgid }),
  };
}

function parsePaneGetError(error: any): PaneInspectionResult {
  for (const raw of [error?.stderr, error?.stdout]) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    try {
      const parsed = parsePaneGetOutput(raw, "");
      if (parsed.kind === "missing") return parsed;
    } catch {
      // A CLI may emit plain diagnostics on one stream and structured JSON on
      // the other. Parse each stream independently before giving up.
    }
    // Older/alternate Herdr builds may print the stable error code as plain
    // text rather than JSON. Only match explicit identifiers, not generic
    // prose such as "pane unavailable".
    if (/\b(?:pane_not_found|not_found)\b/.test(raw)) {
      return { kind: "missing", error: raw.trim() };
    }
  }
  const message = error?.message ? String(error.message) : "herdr pane get failed";
  return { kind: "unavailable", error: message };
}

/**
 * Structured pane query.
 * - present: pane is reachable; agent/agentStatus may be present when detected
 * - missing: server responded, pane is gone
 * - unavailable: server command failed; caller should keep polling
 */
export async function inspectHerdrPane(surface: string): Promise<PaneInspectionResult> {
  try {
    const pane = parsePaneGetOutput(await herdrExecAsync(["pane", "get", surface]), surface);
    if (pane.kind !== "present") return pane;

    // Herdr 0.9 exposes the foreground process list separately from pane get.
    // Keep this enrichment best-effort so older servers retain the existing
    // pane-status behavior instead of turning a missing optional API into a
    // watcher failure.
    try {
      const processInfo = parsePaneProcessInfoOutput(
        await herdrExecAsync(["pane", "process-info", "--pane", surface]),
        surface,
      );
      return processInfo ? { ...pane, ...processInfo } : pane;
    } catch {
      return pane;
    }
  } catch (error: any) {
    return parsePaneGetError(error);
  }
}

export function sendHerdrCommand(surface: string, command: string): void {
  // pane run sends the text and Enter in a single socket request, avoiding
  // a race where Enter could arrive before the text is fully processed.
  herdrExec(["pane", "run", surface, command]);
}

export function sendHerdrEscape(surface: string): void {
  herdrExec(["pane", "send-keys", surface, "Escape"]);
}

export interface HerdrPaneSessionReference {
  paneId: string;
  sessionPath: string;
}

/** Read persisted agent session paths without making them restore targets. */
export function listHerdrPaneSessions(): HerdrPaneSessionReference[] {
  try {
    const output = execFileSync("herdr", ["pane", "list"], {
      encoding: "utf8",
      timeout: 2_000,
    });
    const parsed = parseHerdrJson(output) as {
      result?: { panes?: unknown };
    } | null;
    if (!Array.isArray(parsed?.result?.panes)) return [];

    return parsed.result.panes.flatMap((rawPane) => {
      if (!rawPane || typeof rawPane !== "object") return [];
      const pane = rawPane as {
        pane_id?: unknown;
        agent_session?: unknown;
        agent_session_path?: unknown;
      };
      const paneId = typeof pane.pane_id === "string" && pane.pane_id ? pane.pane_id : undefined;
      if (!paneId) return [];
      const session = pane.agent_session;
      const sessionPath = session && typeof session === "object"
        ? (session as { kind?: unknown; value?: unknown }).kind === "path" &&
          typeof (session as { value?: unknown }).value === "string"
          ? (session as { value: string }).value
          : undefined
        : typeof pane.agent_session_path === "string" ? pane.agent_session_path : undefined;
      return sessionPath ? [{ paneId, sessionPath }] : [];
    });
  } catch {
    // Discovery is best-effort when herdr is unavailable or is restarting.
    return [];
  }
}

export function closeHerdrSurface(surface: string): void {
  herdrExec(["pane", "close", surface]);
}

export function renameHerdrTab(title: string): void {
  const { tab_id: tabId } = getHerdrCurrentPaneInfo();
  herdrExec(["tab", "rename", tabId, title]);
}

export function renameHerdrWorkspace(title: string): void {
  const { workspace_id: workspaceId } = getHerdrCurrentPaneInfo();
  herdrExec(["workspace", "rename", workspaceId, title]);
}

function buildPaneReportTaskArgs(
  paneId: string,
  task: string,
  source = "pi",
): string[] {
  const normalizedTask = task.replace(/[\r\n\t]+/g, " ").trim();
  return [
    "pane",
    "report-metadata",
    paneId,
    "--source",
    source,
    "--token",
    `task=${normalizedTask}`,
  ];
}

export function reportHerdrPaneTask(
  paneId: string,
  task: string,
  source = "pi",
): void {
  const normalizedTask = task.replace(/[\r\n\t]+/g, " ").trim();
  if (!normalizedTask) return;
  try {
    herdrExec(buildPaneReportTaskArgs(paneId, normalizedTask, source));
  } catch {
    // Non-fatal: cosmetic metadata report failure should not abort subagent launch.
  }
}

export const __herdrTest__ = {
  clearCommandAvailability: () => commandAvailability.clear(),
  buildTabCreateArgs,
  buildPaneReportTaskArgs,
  buildPaneReadArgs,
  parseHerdrJson,
  extractHerdrPaneId,
  extractHerdrRootPaneId,
  parsePaneGetOutput,
  parsePaneGetError,
  parsePaneProcessInfoOutput,
  listHerdrPaneSessions,
};
