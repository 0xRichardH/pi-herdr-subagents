import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  closeHerdrSurface,
  createHerdrSurface,
  createHerdrSurfaceSplit,
  isHerdrAvailable,
  getHerdrParentPaneId,
  readHerdrScreen,
  readHerdrScreenAsync,
  inspectHerdrPane,
  renameHerdrTab,
  renameHerdrWorkspace,
  reportHerdrPaneTask,
  sendHerdrCommand,
  sendHerdrEscape,
} from "./herdr.ts";
import { createCoreBackend } from "./herdr-core.ts";
import type { PaneInspection } from "./lifecycle.ts";

export type PaneId = string;
export type SplitDirection = "right" | "down";
export type SubagentLayout = "tab" | SplitDirection;
export type TerminalBackendKind = "herdr-tui" | "herdr-core";

export interface TerminalLaunchRequest {
  readonly name: string;
  readonly task: string;
  readonly cwd: string;
  readonly layout: SubagentLayout;
  readonly command: string;
  readonly scriptPath: string;
  readonly preamble?: string;
}

export interface TerminalBackend {
  readonly kind: TerminalBackendKind;
  readonly isAvailable: () => boolean;
  readonly launch: (request: TerminalLaunchRequest) => Promise<PaneId>;
  readonly send: (paneId: PaneId, command: string) => void;
  readonly interrupt: (paneId: PaneId) => void;
  readonly read: (paneId: PaneId, lines: number) => string;
  readonly readAsync: (paneId: PaneId, lines: number) => Promise<string>;
  readonly inspect: (paneId: PaneId) => Promise<PaneInspection>;
  readonly close: (paneId: PaneId) => void;
  readonly setTask: (paneId: PaneId, task: string) => void;
  readonly renameTab: (title: string) => void;
  readonly renameWorkspace: (title: string) => void;
}

const SETUP_HINT = "Start pi inside herdr-tui (`herdr`, then `pi`) or herdr-core (`hc run pi`). Set PI_SUBAGENT_BACKEND=herdr-tui or herdr-core when both host identities are inherited.";

export function parseSubagentLayout(raw?: string): SubagentLayout {
  const value = (raw ?? "").trim();
  if (value === "split" || value === "split:right") return "right";
  if (value === "split:down") return "down";
  return "tab";
}

export function resolveSubagentLayout(env: Record<string, string | undefined> = process.env): SubagentLayout {
  return parseSubagentLayout(env.PI_SUBAGENT_LAYOUT);
}

export function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function createTuiSurface(name: string, layout: SubagentLayout, cwd = process.cwd()): PaneId {
  if (layout !== "tab") {
    const parentPaneId = getHerdrParentPaneId();
    if (parentPaneId) return createHerdrSurfaceSplit(name, layout, parentPaneId, cwd);
  }
  return createHerdrSurface(name, cwd);
}

function createTuiBackend(): TerminalBackend {
  return Object.freeze({
    kind: "herdr-tui",
    isAvailable: isHerdrAvailable,
    async launch(request) {
      const paneId = createTuiSurface(request.name, request.layout, request.cwd);
      try {
        reportHerdrPaneTask(paneId, request.task);
        await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
        sendHerdrCommand(paneId, `PI_SUBAGENT_SURFACE=${shellQuote(paneId)} bash ${shellQuote(request.scriptPath)}`);
        return paneId;
      } catch (error) {
        closeHerdrSurface(paneId);
        throw error;
      }
    },
    send: sendHerdrCommand,
    interrupt: sendHerdrEscape,
    read: readHerdrScreen,
    readAsync: readHerdrScreenAsync,
    async inspect(paneId) {
      const result = await inspectHerdrPane(paneId);
      return result.kind === "present" ? { ...result, observedAt: Date.now() } : result;
    },
    close: closeHerdrSurface,
    setTask: reportHerdrPaneTask,
    renameTab: renameHerdrTab,
    renameWorkspace: renameHerdrWorkspace,
  } satisfies TerminalBackend);
}

let selectedBackend: TerminalBackend | undefined;
let selectionError: Error | undefined;

export function getTerminalBackend(): TerminalBackend {
  if (selectionError) throw selectionError;
  if (selectedBackend) return selectedBackend;
  const override = process.env.PI_SUBAGENT_BACKEND;
  const core = Boolean(process.env.HC_TERMINAL_ID);
  const tui = process.env.HERDR_ENV === "1";
  if ((override !== undefined && override !== "herdr-tui" && override !== "herdr-core") || (!override && core && tui)) {
    selectionError = new Error(`Cannot select terminal backend. ${SETUP_HINT}`);
    throw selectionError;
  }
  selectedBackend = override === "herdr-core" || (!override && core) ? createCoreBackend() : createTuiBackend();
  return selectedBackend;
}

export function isTerminalAvailable(): boolean {
  try {
    return getTerminalBackend().isAvailable();
  } catch {
    return false;
  }
}

export function terminalSetupHint(): string {
  return selectionError?.message ?? SETUP_HINT;
}

function assertTerminalAvailable(): TerminalBackend {
  const backend = getTerminalBackend();
  if (!backend.isAvailable()) throw new Error(`${backend.kind} is not available. ${SETUP_HINT}`);
  return backend;
}

export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function writeScript(scriptPath: string, command: string, preamble?: string): void {
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, ["#!/bin/bash", preamble?.trimEnd(), command, ""].filter((line) => line !== undefined).join("\n"), { mode: 0o755 });
}

export async function launchSubagentTerminal(request: TerminalLaunchRequest): Promise<PaneId> {
  const backend = assertTerminalAvailable();
  const bindings = [
    `export PI_SUBAGENT_BACKEND=${shellQuote(backend.kind)}`,
    backend.kind === "herdr-core"
      ? 'export PI_SUBAGENT_SURFACE="$HC_TERMINAL_ID"'
      : "export PI_SUBAGENT_SURFACE",
  ];
  writeScript(request.scriptPath, request.command, [...bindings, request.preamble].filter(Boolean).join("\n"));
  return backend.launch(request);
}

export function createSubagentSurface(name: string, layout: SubagentLayout = "tab"): PaneId {
  if (assertTerminalAvailable().kind !== "herdr-tui") throw new Error("Use launchSubagentTerminal for herdr-core");
  return createTuiSurface(name, layout);
}

export function createSubagentPane(name: string): PaneId {
  return createSubagentSurface(name);
}

export function renameCurrentTab(title: string): void {
  assertTerminalAvailable().renameTab(title);
}

export function renameCurrentWorkspace(title: string): void {
  assertTerminalAvailable().renameWorkspace(title);
}

export function runInPane(paneId: PaneId, command: string): void {
  assertTerminalAvailable().send(paneId, command);
}

export function interruptPane(paneId: PaneId): void {
  assertTerminalAvailable().interrupt(paneId);
}

export function runScriptInPane(
  paneId: PaneId,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath = options?.scriptPath ?? join(tmpdir(), "pi-herdr-subagent-scripts", `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`);
  writeScript(scriptPath, command, options?.scriptPreamble);
  runInPane(paneId, `bash ${shellQuote(scriptPath)}`);
  return scriptPath;
}

export function readPane(paneId: PaneId, lines = 50): string {
  return assertTerminalAvailable().read(paneId, lines);
}

export async function readPaneAsync(paneId: PaneId, lines = 50): Promise<string> {
  return assertTerminalAvailable().readAsync(paneId, lines);
}

export type { PaneInspection, HerdrAgentStatus } from "./lifecycle.ts";

export async function inspectPane(paneId: PaneId): Promise<PaneInspection> {
  return assertTerminalAvailable().inspect(paneId);
}

export function closePane(paneId: PaneId): void {
  assertTerminalAvailable().close(paneId);
}

export function setPaneTask(paneId: PaneId, task: string): void {
  if (isTerminalAvailable()) getTerminalBackend().setTask(paneId, task);
}
