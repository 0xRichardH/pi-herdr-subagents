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
  return process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID && hasCommand("herdr");
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

function swapHerdrPane(
  paneId: string,
  parentPaneId: string,
  run: (args: string[]) => string = herdrExec,
): void {
  try {
    run(["pane", "swap", "--source-pane", paneId, "--target-pane", parentPaneId]);
  } catch (error) {
    try {
      run(["pane", "close", paneId]);
    } catch {}
    throw error;
  }
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
    const output = herdrExec(["pane", "current", "--current"]);
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
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const parentPaneId = fromSurface ?? getHerdrParentPaneId();
  // Herdr exposes split axes as right/down; left/up map to the same axis.
  const splitDirection = direction === "left" || direction === "right" ? "right" : "down";
  const output = herdrExec([
    "pane",
    "split",
    "--pane",
    parentPaneId,
    "--direction",
    splitDirection,
    "--no-focus",
    "--cwd",
    process.cwd(),
  ]);
  const paneId = extractHerdrPaneId(output, "pane split");
  if (direction === "left" || direction === "up") {
    swapHerdrPane(paneId, parentPaneId);
  }
  try {
    herdrExec(["pane", "rename", paneId, name]);
  } catch {
    // Optional.
  }
  return paneId;
}

export function readHerdrScreen(surface: string, lines = 50): string {
  // Hidden Herdr tabs do not populate host scrollback until viewed, so read
  // their live viewport instead of the empty recent/recent-unwrapped sources.
  return herdrExec([
    "pane",
    "read",
    surface,
    "--source",
    "visible",
    "--lines",
    String(Math.max(1, lines)),
  ]);
}

export async function readHerdrScreenAsync(surface: string, lines = 50): Promise<string> {
  return herdrExecAsync([
    "pane",
    "read",
    surface,
    "--source",
    "visible",
    "--lines",
    String(Math.max(1, lines)),
  ]);
}

export function sendHerdrCommand(surface: string, command: string): void {
  // pane run sends the text and Enter in a single socket request, avoiding
  // a race where Enter could arrive before the text is fully processed.
  herdrExec(["pane", "run", surface, command]);
}

export function sendHerdrEscape(surface: string): void {
  herdrExec(["pane", "send-keys", surface, "esc"]);
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
  swapHerdrPane,
};
