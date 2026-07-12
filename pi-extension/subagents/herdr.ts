import { execFile, execSync, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const commandAvailability = new Map<string, boolean>();

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

async function herdrExecAsync(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("herdr", args, { encoding: "utf8" });
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

export function createHerdrSurface(name: string): string {
  // Create a new tab per subagent so parallel spawns each get a full tab
  // instead of ever-narrower splits of the parent pane.
  const output = herdrExec([
    "tab",
    "create",
    "--label",
    name,
    "--cwd",
    process.cwd(),
    "--no-focus",
  ]);
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

export function readHerdrScreen(surface: string, lines = 50): string {
  // `visible` is reliable for freshly created panes where herdr's `recent`
  // scrollback may not be populated yet.
  return herdrExec(["pane", "read", surface, "--source", "visible", "--lines", String(lines)]);
}

export async function readHerdrScreenAsync(surface: string, lines = 50): Promise<string> {
  return herdrExecAsync(["pane", "read", surface, "--source", "visible", "--lines", String(lines)]);
}

/**
 * Check whether a herdr pane is still present.
 * Returns `true` when presence is unknown (list/parse failures) so callers
 * never treat infrastructure glitches as pane disappearance.
 * Returns `false` only when the list is successfully parsed and the pane is absent.
 */
export async function isHerdrPanePresent(surface: string): Promise<boolean> {
  try {
    const output = await herdrExecAsync(["pane", "list"]);
    const parsed = parseHerdrJson(output) as { result?: { panes?: Array<{ pane_id?: unknown }> } } | null;
    const panes = parsed?.result?.panes;
    if (!Array.isArray(panes)) return true;
    return panes.some((pane) => pane?.pane_id === surface);
  } catch {
    return true;
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

export const __herdrTest__ = {
  parseHerdrJson,
  extractHerdrPaneId,
  extractHerdrRootPaneId,
};
