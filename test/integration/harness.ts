/**
 * Integration test harness for pi-herdr-subagents.
 *
 * Provides utilities to:
 * - Detect whether herdr is available
 * - Create isolated test environments with test agent definitions
 * - Start real pi sessions in mux surfaces
 * - Poll for file creation and screen output
 * - Clean up surfaces and temp files after tests
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readdirSync,
  rmSync,
  existsSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  isTerminalAvailable,
  createSubagentPane,
  splitCurrentPane,
  runInPane,
  runScriptInPane,
  readPane,
  readPaneAsync,
  closePane,
  interruptPane,
  shellQuote,
} from "../../pi-extension/subagents/terminal.ts";

type MuxBackend = "herdr";

// Re-export mux primitives for tests
export {
  createSubagentPane,
  splitCurrentPane,
  runInPane,
  runScriptInPane,
  readPane,
  readPaneAsync,
  closePane,
  interruptPane,
  shellQuote,
};
export type { MuxBackend };

// ── Paths ──

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HARNESS_DIR, "../..");
const TEST_AGENTS_SRC = join(HARNESS_DIR, "agents");

/**
 * Absolute path to the extension source in the working tree.
 *
 * Integration tests must exercise the code on the current branch — NOT the
 * version installed as a pi-package under `~/.pi/agent/git/...` or the project
 * mirror under `.pi/git/...`, which stays pinned to the last released tag.
 *
 * We force-load this file via `pi -ne -e <path>` in startPi() below so local
 * edits are always the code under test, regardless of what pi-packages are
 * installed on the host.
 */
const EXTENSION_SOURCE = join(PROJECT_ROOT, "pi-extension", "subagents", "index.ts");

// ── Configuration ──

/** Model used for integration tests. Override with PI_TEST_MODEL env var. */
export const TEST_MODEL = process.env.PI_TEST_MODEL ?? "openrouter/free";

/** Per-test timeout in ms. Override with PI_TEST_TIMEOUT env var. */
export const PI_TIMEOUT = Number(process.env.PI_TEST_TIMEOUT ?? "120000");

// ── Backend detection ──

/** Detect whether the required herdr backend is available. */
export function getAvailableBackends(): MuxBackend[] {
  return isTerminalAvailable() ? ["herdr"] : [];
}

export function setBackend(_backend: MuxBackend): undefined {
  return undefined;
}

export function restoreBackend(_prev: string | undefined): void {}

export function focusSurface(_backend: MuxBackend, surface: string): void {
  // Focus the tab containing the pane — herdr has no direct "focus pane X"
  // CLI, but focusing the tab brings it to the foreground.
  const info = execFileSync("herdr", ["pane", "get", surface], { encoding: "utf8" });
  const tabId = JSON.parse(info)?.result?.pane?.tab_id;
  if (tabId) execFileSync("herdr", ["tab", "focus", tabId], { encoding: "utf8" });
}

export function getFocusedSurface(_backend: MuxBackend): string | null {
  try {
    const info = execFileSync("herdr", ["pane", "current"], { encoding: "utf8" });
    return JSON.parse(info)?.result?.pane?.pane_id ?? null;
  } catch {
    return null;
  }
}

export function getSurfacePane(_backend: MuxBackend, surface: string): string | null {
  return surface;
}

export async function waitForFocusedSurface(
  backend: MuxBackend,
  surface: string,
  timeout: number = PI_TIMEOUT,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (getFocusedSurface(backend) === surface) return;
    await sleep(200);
  }

  throw new Error(
    `Timeout (${timeout}ms) waiting for focused ${backend} surface ${surface}; ` +
      `current focus is ${getFocusedSurface(backend) ?? "unknown"}`,
  );
}

// ── Test environment ──

export interface TestEnv {
  /** Temp directory serving as the test project root */
  dir: string;
  /** Active mux backend for this test run */
  backend: MuxBackend;
  /** Surfaces created during the test (cleaned up automatically) */
  surfaces: string[];
  /** Temp files to clean up */
  tempFiles: string[];
}

/**
 * Create an isolated test environment with test agent definitions.
 * The temp dir has `.pi/agents/` containing copies of all test agents.
 */
export function createTestEnv(backend: MuxBackend): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "pi-integ-"));
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });

  // Copy test agent definitions into the project-local agents dir
  if (existsSync(TEST_AGENTS_SRC)) {
    for (const file of readdirSync(TEST_AGENTS_SRC)) {
      if (file.endsWith(".md")) {
        cpSync(join(TEST_AGENTS_SRC, file), join(agentsDir, file));
      }
    }
  }

  return { dir, backend, surfaces: [], tempFiles: [] };
}

/**
 * Clean up all resources created during the test.
 */
export function cleanupTestEnv(env: TestEnv): void {
  for (const surface of env.surfaces) {
    try {
      closePane(surface);
    } catch {}
  }
  for (const file of env.tempFiles) {
    try {
      unlinkSync(file);
    } catch {}
  }
  try {
    rmSync(env.dir, { recursive: true, force: true });
  } catch {}
}

/**
 * Create a surface and register it for automatic cleanup.
 */
export function createTrackedSurface(env: TestEnv, name: string): string {
  const surface = createSubagentPane(name);
  env.surfaces.push(surface);
  return surface;
}

export function createTrackedSurfaceSplit(
  env: TestEnv,
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const surface = splitCurrentPane(name, direction, fromSurface);
  env.surfaces.push(surface);
  return surface;
}

/**
 * Remove a surface from tracking (after manual close).
 */
export function untrackSurface(env: TestEnv, surface: string): void {
  env.surfaces = env.surfaces.filter((s) => s !== surface);
}

// ── Pi session management ──

/**
 * Start a pi session in a mux surface with the subagents extension loaded.
 * Returns immediately — the pi process runs asynchronously in the surface.
 *
 * The command ends with a sentinel so we can detect when pi exits:
 *   `pi ...; echo '__TEST_DONE_'$?'__'`
 */
export function startPi(
  surface: string,
  testDir: string,
  task: string,
  opts?: { model?: string; extraArgs?: string },
): void {
  const model = opts?.model ?? TEST_MODEL;
  const extra = opts?.extraArgs ?? "";

  // Force pi to load the working-tree extension (not an installed pi-package
  // snapshot). `-ne` disables extension auto-discovery, `-e <path>` loads the
  // current branch's source directly. Without this, the tests silently run
  // against whatever version is checked out under `~/.pi/agent/git/...`.
  const cmd = [
    `cd ${shellQuote(testDir)} &&`,
    `pi`,
    `-ne`,
    `-e ${shellQuote(EXTENSION_SOURCE)}`,
    `--model ${shellQuote(model)}`,
    extra,
    shellQuote(task),
  ]
    .filter(Boolean)
    .join(" ");

  runScriptInPane(surface, `${cmd}; echo '__TEST_DONE_'$?'__'`, {
    scriptPath: join(testDir, `test-launch-${Date.now()}.sh`),
  });
}

// ── Polling helpers ──

/**
 * Poll until a regex pattern appears in the surface's screen output.
 * Throws on timeout with the last screen contents for debugging.
 */
export async function waitForScreen(
  surface: string,
  pattern: RegExp,
  timeout: number = PI_TIMEOUT,
  lines: number = 200,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const screen = await readPaneAsync(surface, lines);
      if (pattern.test(screen)) return screen;
    } catch {}
    await sleep(2000);
  }

  let finalScreen = "";
  try {
    finalScreen = readPane(surface, lines);
  } catch {}
  throw new Error(
    `Timeout (${timeout}ms) waiting for pattern ${pattern}.\nLast screen:\n${finalScreen.slice(-1000)}`,
  );
}

/**
 * Poll until a file exists and optionally matches a content pattern.
 * Returns the file content on success.
 */
export async function waitForFile(
  path: string,
  timeout: number = PI_TIMEOUT,
  contentPattern?: RegExp,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8");
      if (!contentPattern || contentPattern.test(content)) return content;
    }
    await sleep(2000);
  }
  throw new Error(
    `Timeout (${timeout}ms) waiting for file: ${path}` +
      (contentPattern ? ` matching ${contentPattern}` : ""),
  );
}

/**
 * Wait for the pi process in a surface to exit (sentinel detection).
 * Returns the exit code.
 */
export async function waitForPiExit(
  surface: string,
  timeout: number = PI_TIMEOUT,
): Promise<number> {
  const screen = await waitForScreen(surface, /__TEST_DONE_(\d+)__/, timeout);
  const match = screen.match(/__TEST_DONE_(\d+)__/);
  return match ? parseInt(match[1], 10) : -1;
}

// ── Utilities ──

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function uniqueId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Register a temp file for cleanup.
 */
export function trackTempFile(env: TestEnv, path: string): void {
  env.tempFiles.push(path);
}
