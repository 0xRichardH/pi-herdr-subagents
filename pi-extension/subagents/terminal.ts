import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  closeHerdrSurface,
  createHerdrSurface,
  createHerdrSurfaceSplit,
  isHerdrAvailable,
  readHerdrScreen,
  readHerdrScreenAsync,
  inspectHerdrPane,
  renameHerdrTab,
  renameHerdrWorkspace,
  reportHerdrPaneTask,
  sendHerdrCommand,
  sendHerdrEscape,
} from "./herdr.ts";

export type PaneId = string;
export type SplitDirection = "right" | "down";

/**
 * Where a subagent surface should be created:
 *   - `"tab"`   — a brand-new tab (default)
 *   - `"right"` — split the orchestrator pane to the right
 *   - `"down"`  — split the orchestrator pane below
 */
export type SubagentLayout = "tab" | SplitDirection;

const SETUP_HINT = "Start pi inside herdr (`herdr`, then run `pi`).";

/**
 * Parse the `PI_SUBAGENT_LAYOUT` env var into a {@link SubagentLayout}.
 * Accepted values (case-sensitive, trimmed): `split`, `split:right` (both map
 * to a right-hand split), `split:down` (split below). Anything else — unset,
 * empty, or unknown — falls back to the default `tab`.
 */
export function parseSubagentLayout(raw?: string): SubagentLayout {
  const value = (raw ?? "").trim();
  if (value === "split" || value === "split:right") return "right";
  if (value === "split:down") return "down";
  return "tab";
}

/** Read `PI_SUBAGENT_LAYOUT` from the provided environment (defaults to the process env). */
export function resolveSubagentLayout(env: Record<string, string | undefined> = process.env): SubagentLayout {
  return parseSubagentLayout(env.PI_SUBAGENT_LAYOUT);
}

/** Create the surface for a subagent according to the requested layout. */
export function createSubagentSurface(name: string, layout: SubagentLayout = "tab"): PaneId {
  assertTerminalAvailable();
  return layout === "tab" ? createSubagentPane(name) : splitCurrentPane(name, layout);
}

export function isTerminalAvailable(): boolean {
  return isHerdrAvailable();
}

export function terminalSetupHint(): string {
  return SETUP_HINT;
}

function assertTerminalAvailable(): void {
  if (!isTerminalAvailable()) throw new Error(`herdr is not available. ${SETUP_HINT}`);
}

export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Create a new herdr tab and return its root pane ID. */
export function createSubagentPane(name: string): PaneId {
  assertTerminalAvailable();
  return createHerdrSurface(name);
}

/** Split the current herdr pane and return the child pane ID. */
export function splitCurrentPane(name: string, direction: SplitDirection): PaneId {
  assertTerminalAvailable();
  return createHerdrSurfaceSplit(name, direction);
}

export function renameCurrentTab(title: string): void {
  assertTerminalAvailable();
  renameHerdrTab(title);
}

export function renameCurrentWorkspace(title: string): void {
  assertTerminalAvailable();
  renameHerdrWorkspace(title);
}

export function runInPane(paneId: PaneId, command: string): void {
  assertTerminalAvailable();
  sendHerdrCommand(paneId, command);
}

export function interruptPane(paneId: PaneId): void {
  assertTerminalAvailable();
  sendHerdrEscape(paneId);
}

export function runScriptInPane(
  paneId: PaneId,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-herdr-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptLines = ["#!/bin/bash"];
  if (options?.scriptPreamble) scriptLines.push(options.scriptPreamble.trimEnd());
  scriptLines.push(command);
  writeFileSync(scriptPath, `${scriptLines.join("\n")}\n`, { mode: 0o755 });

  runInPane(paneId, `bash ${shellQuote(scriptPath)}`);
  return scriptPath;
}

export function readPane(paneId: PaneId, lines = 50): string {
  assertTerminalAvailable();
  return readHerdrScreen(paneId, lines);
}

export async function readPaneAsync(paneId: PaneId, lines = 50): Promise<string> {
  assertTerminalAvailable();
  return readHerdrScreenAsync(paneId, lines);
}

export type { PaneInspection, HerdrAgentStatus } from "./lifecycle.ts";

export async function inspectPane(paneId: PaneId): Promise<import("./lifecycle.ts").PaneInspection> {
  assertTerminalAvailable();
  const result = await inspectHerdrPane(paneId);
  if (result.kind === "present") {
    return { kind: "present", observedAt: Date.now(), ...result };
  }
  return result;
}

export function closePane(paneId: PaneId): void {
  assertTerminalAvailable();
  closeHerdrSurface(paneId);
}

export function setPaneTask(paneId: PaneId, task: string): void {
  if (!isTerminalAvailable()) return;
  reportHerdrPaneTask(paneId, task);
}
