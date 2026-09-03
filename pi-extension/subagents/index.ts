import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  accessSync,
  constants as fsConstants,
} from "node:fs";
import { homedir } from "node:os";
import {
  isTerminalAvailable,
  terminalSetupHint,
  createSubagentPane,
  runScriptInPane,
  closePane,
  interruptPane,
  shellQuote,
  readPane,
  readPaneAsync,
  inspectPane,
  setPaneTask,
  listPaneSessionReferences,
} from "./terminal.ts";
import { waitForCompletion } from "./completion.ts";
import {
  buildAuthenticatedModelCatalog,
  resolveRuntimePlan,
  wrapPiModelRegistry,
  THINKING_LEVELS,
  type ResolvedRuntimePlan,
  type ThinkingLevel,
} from "./runtime-routing.ts";
import {
  getHarnessDriver,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
} from "./harness/index.ts";
import { loadModelConfig, resolveModelDefault, type ModelConfig } from "./model-config.ts";

import {
  findLastAssistantMessage,
  findObservedSessionRuntime,
  getNewEntries,
  seedSubagentSessionFile,
} from "./session.ts";
import {
  type SubagentStatusState,
  capStatusLines,
  formatElapsedDuration,
  formatStatusAggregate,
  normalizeStatusName,
  loadStatusConfig,
} from "./status.ts";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";
import {
  createLifecycle,
  formatLifecycleTransitionLine,
  lifecycleTransition,
  markCompleted,
  markCompletionDetected,
  markDelivery,
  markFailed,
  MISSING_PANE_DEBOUNCE_MS,
  MISSING_PANE_ERROR,
  markInterruptRequested,
  markProcessRunning,
  observeActivity,
  observePaneInspection,
  projectLifecycle,
  type LifecycleProjection,
  type SubagentLifecycle,
  type PaneInspection,
} from "./lifecycle.ts";
import {
  advanceRecoveryLadder,
  formatRecoveryKillError,
  parseActiveToolStallMs,
  parseRecoveryDelays,
  type RecoveryDelays,
  type RecoveryState,
} from "./recovery.ts";
import {
  cleanupWrapupDirective,
  evalTimeLimit,
  formatTimeLimitError,
  getTimeLimitDeadlineAt,
  parsePositiveIntegerSeconds,
  parseTimeoutWarnThreshold,
  writeWrapupDirective,
  type TimeLimitConfig,
} from "./time-limits.ts";
import {
  discoverOrphanedSubagents,
  formatOrphanRestoreReport,
  isActionableOrphan,
  isRestorableOrphan,
  resumeOrphanedSubagents,
  type DiscoveredOrphan,
  type OrphanResumeOutcome,
  type SpawnMetadataRecord,
} from "./orphan-discovery.ts";

/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

function preflightSubagentDonePath(subagentsDir = SUBAGENTS_DIR): string {
  const subagentDonePath = join(subagentsDir, "subagent-done.ts");
  try {
    accessSync(subagentDonePath, fsConstants.R_OK);
  } catch {
    throw new Error(
      `Cannot launch subagent: child extension "${subagentDonePath}" is missing or unreadable. ` +
      "Likely cause: a live-package-swap (pi install/remove) while the parent session was running.",
    );
  }
  return subagentDonePath;
}

// Survive /reload: replace presentation timers while keeping active completion
// watchers and their registry alive. Old module closures continue watching the
// children; the reloaded module adopts the shared registry for status/interrupts.
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const RUNTIME_KEY = Symbol.for("pi-subagents/runtime");

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
}

function buildSubagentRoutingGuidelines(
  modelCatalog?: string,
  agentCatalog?: string,
): string[] {
  return [
    "Choose the named agent whose description most closely matches the task; do not use one agent as a generic default.",
    "Omit model and thinking when invoking a named agent so its configured defaults apply. Passing either field is an explicit one-off override and takes precedence over agent frontmatter.",
    "For a bare spawn, omit model and thinking to inherit the parent runtime.",
    "When an intentional runtime override is necessary, prefer changing thinking before changing models: minimal/low for bounded mechanical work, medium for ordinary implementation or review, and high+ for architecture, concurrency, security, or hard diagnosis.",
    "When overriding a subagent model, use an exact authenticated provider/model-id from the live catalog below. Do not invent aliases or fuzzy names.",
    agentCatalog ?? "Available named subagent catalog becomes available after session start.",
    modelCatalog ?? "Authenticated subagent model catalog becomes available after session start.",
  ];
}

const subagentRoutingGuidelines = buildSubagentRoutingGuidelines();

const ThinkingLevelSchema = Type.Union(
  THINKING_LEVELS.map((level) => Type.Literal(level)),
  {
    description:
      "Pi thinking level. Omit to use a named agent's thinking default, then the parent level. Passing a value explicitly overrides agent frontmatter for this spawn.",
  },
);

const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name to load defaults from the available named subagent catalog. Agent frontmatter can provide model, thinking, tools, skills, and role instructions.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Appended to system prompt (role instructions)" }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Exact authenticated provider/model-id. Omit to use a named agent's model default, then the configured or parent model. Passing a value explicitly overrides agent frontmatter for this spawn.",
    }),
  ),
  thinking: Type.Optional(ThinkingLevelSchema),
  skills: Type.Optional(
    Type.String({ description: "Comma-separated skills (overrides agent default)" }),
  ),
  tools: Type.Optional(
    Type.String({ description: "Comma-separated tools (overrides agent default)" }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "Force the full-context fork mode for this spawn. The sub-agent inherits the current session conversation, overriding any agent frontmatter session-mode.",
    }),
  ),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "Mark the subagent as interactive (long-running, user drives the conversation in its own pane). When true, the main session is not woken by status transitions (stalled/recovered) for this subagent. If omitted, falls back to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit` (agents that auto-exit are autonomous and get stall pings; agents that don't are interactive and stay quiet).",
    }),
  ),
  resumeSessionId: Type.Optional(
    Type.String({
      description:
        "Resume a previous Claude Code session by its ID. Loads the conversation history and continues where it left off. The session ID is returned in details of every claude tool call. Use this to retry cancelled runs or ask follow-up questions.",
    }),
  ),
});

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  interactive?: boolean;
  timeLimitSeconds?: number;
  idleTimeoutSeconds?: number;
  timeoutWarnThreshold?: number;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  commandTemplate?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

type AgentSource = "package" | "global" | "project";

interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/** Tools gated behind an explicit frontmatter spawn grant (`spawning: true`) */
const SPAWNING_TOOLS = new Set([
  "subagent",
  "subagent_interrupt",
  "subagents_list",
  "subagent_resume",
]);

/**
 * Parse PI_SUBAGENT_SPAWN_DEPTH into a child-spawning allowance.
 * Unset/blank/unparsable/negative → null (unlimited; a frontmatter grant is
 * still required). A non-negative integer is the generation ceiling granted
 * to this process's direct children.
 */
function parseSpawnDepth(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * Depth handed down to the next generation: decrements by one per
 * generation, never rises, clamps at zero. Unlimited stays unlimited.
 */
function decrementSpawnDepth(allowance: number | null): number | null {
  return allowance === null ? null : Math.max(0, allowance - 1);
}

/**
 * Resolve the effective set of denied tool names from agent defaults.
 *
 * Spawning is deny-by-default: all SPAWNING_TOOLS are denied unless the
 * agent frontmatter explicitly grants `spawning: true` AND depth remains
 * (`spawnAllowance > 0`, or null = unlimited).
 * `deny-tools` additions stack on top either way.
 */
function resolveDenyTools(
  agentDefs: AgentDefaults | null,
  spawnAllowance: number | null = null,
): Set<string> {
  const denied = new Set<string>();

  // Deny-by-default: only spawning:true + remaining depth keeps the tools.
  const spawnGranted =
    agentDefs?.spawning === true && (spawnAllowance === null || spawnAllowance > 0);
  if (!spawnGranted) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  // deny-tools: explicit list stacks on top of the default denial
  if (agentDefs?.denyTools) {
    for (const t of agentDefs.denyTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      denied.add(t);
    }
  }

  return denied;
}

/**
 * Resume clamp: first-launch metadata is authoritative. The resumed session
 * never receives more spawning allowance than its first launch recorded —
 * min(recorded, requested). Missing/corrupt metadata resolves to 0 (deny).
 */
function clampResumeSpawn(
  recorded: { allowance?: unknown } | null | undefined,
  requestedAllowance: number | null,
): { maySpawn: boolean; childEnvDepth: number | null } {
  const capRaw = recorded?.allowance;
  if (capRaw !== null && (typeof capRaw !== "number" || !Number.isFinite(capRaw) || capRaw < 0)) {
    return { maySpawn: false, childEnvDepth: 0 };
  }
  const cap = capRaw === null ? null : Math.floor(capRaw);
  const effective =
    cap === null
      ? requestedAllowance
      : requestedAllowance === null
        ? cap
        : Math.min(cap, requestedAllowance);
  const maySpawn = effective === null || effective > 0;
  return { maySpawn, childEnvDepth: decrementSpawnDepth(effective) };
}

/**
 * Read the first-launch spawn metadata sidecar written next to a subagent
 * session file. Any failure (missing file, corrupt JSON) → null, which the
 * clamp treats as zero allowance.
 */
function readSpawnMetadata(sessionFile: string): SpawnMetadataRecord | null {
  try {
    return JSON.parse(readFileSync(`${sessionFile}.spawn.json`, "utf8"));
  } catch {
    return null;
  }
}

/** Write one complete spawn record without exposing a partially-written JSON. */
function writeSpawnMetadata(sessionFile: string, metadata: SpawnMetadataRecord): void {
  const target = `${sessionFile}.spawn.json`;
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The rename succeeded, or the temporary file was never created.
    }
  }
}

type ResumeSessionCwdResult =
  | { ok: true; healed: boolean }
  | { ok: false; error: string };

/** Ensure a resumed session has a cwd that pi can open without prompting. */
function ensureResumeSessionCwd(sessionFile: string, resumingCwd: string): ResumeSessionCwdResult {
  let raw: Buffer;
  try {
    raw = readFileSync(sessionFile);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Unable to read session file: ${reason}` };
  }

  const firstLineEnd = raw.indexOf(0x0a);
  const firstLine = raw
    .subarray(0, firstLineEnd === -1 ? raw.length : firstLineEnd)
    .toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return { ok: false, error: "Unable to parse the session header JSON" };
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as { cwd?: unknown }).cwd !== "string"
  ) {
    return { ok: false, error: "Session header has no valid cwd" };
  }

  const header = parsed as Record<string, unknown>;
  if (existsSync(header.cwd as string)) return { ok: true, healed: false };

  const lineEndingStart =
    firstLineEnd !== -1 && firstLineEnd > 0 && raw[firstLineEnd - 1] === 0x0d
      ? firstLineEnd - 1
      : firstLineEnd === -1
        ? raw.length
        : firstLineEnd;
  const rewritten = Buffer.concat([
    Buffer.from(JSON.stringify({ ...header, cwd: resumingCwd }), "utf8"),
    raw.subarray(lineEndingStart),
  ]);
  const tempFile = join(
    dirname(sessionFile),
    `.${basename(sessionFile)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(tempFile, rewritten, { flag: "wx", mode: 0o600 });
    renameSync(tempFile, sessionFile);
  } catch (error) {
    try {
      unlinkSync(tempFile);
    } catch {
      // Keep the original failure as the block reason.
    }
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Unable to repair missing session cwd: ${reason}` };
  }

  return { ok: true, healed: true };
}

/** Same-agent respawn guard: an agent never spawns another instance of itself. */
function blockedSelfSpawn(requestedAgent: string | undefined, currentAgent: string | undefined): boolean {
  return !!requestedAgent && !!currentAgent && requestedAgent === currentAgent;
}

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function getBundledAgentsDir(): string {
  return join(SUBAGENTS_DIR, "../../agents");
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!match) return undefined;
  const value = match[1].trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    denyTools: getFrontmatterValue(frontmatter, "deny-tools"),
    spawning: parseOptionalBoolean(getFrontmatterValue(frontmatter, "spawning")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    timeLimitSeconds: parsePositiveIntegerSeconds(getFrontmatterValue(frontmatter, "time-limit")),
    idleTimeoutSeconds: parsePositiveIntegerSeconds(getFrontmatterValue(frontmatter, "idle-timeout")),
    timeoutWarnThreshold: parseTimeoutWarnThreshold(
      getFrontmatterValue(frontmatter, "timeout-warn-threshold"),
    ),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    commandTemplate:
      getFrontmatterValue(frontmatter, "command") ??
      getFrontmatterValue(frontmatter, "command-template"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      try {
        const parsed = parseAgentDefinition(
          readFileSync(join(dir, file), "utf8"),
          file.replace(/\.md$/, ""),
        );
        if (!parsed) continue;
        agents.set(parsed.name, { ...parsed, source });
      } catch {
        // Skip unreadable or racy entries rather than aborting discovery
        // for every other agent definition.
      }
    }
  }

  return [...agents.values()];
}

function buildAvailableAgentCatalog(
  agents: ListedAgentDefinition[],
  limit = 24,
  config: ModelConfig = modelConfig,
): string {
  const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));
  const visible = sorted.slice(0, limit);
  const lines = [
    "Available named subagents (choose by role; omit model/thinking to use agent defaults):",
  ];

  for (const agent of visible) {
    const effectiveModel = resolveModelDefault(agent.name, agent.model, config);
    const defaults = [
      effectiveModel ? `model ${effectiveModel}` : undefined,
      agent.thinking ? `thinking ${agent.thinking}` : undefined,
    ].filter(Boolean);
    const runtime = defaults.length > 0 ? `; defaults: ${defaults.join(", ")}` : "";
    const description = agent.description ? ` — ${agent.description}` : "";
    lines.push(`- ${agent.name} [${agent.source}${runtime}]${description}`);
  }

  if (visible.length === 0) lines.push("- none discovered; use a bare spawn");
  if (sorted.length > visible.length) {
    lines.push(`- … ${sorted.length - visible.length} more named subagents omitted`);
  }

  return lines.join("\n");
}

function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

function resolveEffectiveSessionMode(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  if (params.fork) return "fork";
  return agentDefs?.sessionMode ?? "standalone";
}

function resolveLaunchBehavior(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` tool parameter wins.
 *   2. Explicit `interactive` frontmatter field on the agent.
 *   3. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, worker, reviewer) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (planner, iterate/fork) and
 *      stall pings are noise.
 *
 * When no agent defs exist at all (bare `subagent({ name, task })` call,
 * typical for `/iterate` with `fork: true`), `autoExit` is undefined and the
 * subagent is treated as interactive — matching the intent of iterate.
 */
function resolveEffectiveAutoExit(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  // Named agents preserve their declared behavior. Bare tool calls are
  // autonomous by default, including full-context forks: `fork` controls
  // context inheritance, not whether the child should remain open. Interactive
  // flows such as /iterate opt out explicitly with `interactive: true`.
  if (agentDefs) return agentDefs.autoExit ?? false;
  return params.interactive !== true;
}

function resolveEffectiveInteractive(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  if (params.interactive != null) return params.interactive;
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !resolveEffectiveAutoExit(params, agentDefs);
}

function resolveTimeLimitConfig(
  agentDefs: AgentDefaults | null,
  interactive: boolean,
  supportsWrapup = true,
): TimeLimitConfig | undefined {
  if (interactive || !agentDefs) return undefined;
  const config: TimeLimitConfig = {
    timeLimitSeconds: agentDefs.timeLimitSeconds,
    idleTimeoutSeconds: agentDefs.idleTimeoutSeconds,
    timeoutWarnThreshold: supportsWrapup ? agentDefs.timeoutWarnThreshold : undefined,
  };
  return config.timeLimitSeconds || config.idleTimeoutSeconds ? config : undefined;
}

function loadAgentDefaults(agentName: string): AgentDefaults | null {
  // Resolve through the same name-keyed map discoverAgentDefinitions() builds
  // for the tool-guidance catalog, so a name advertised there always resolves
  // to the same definition here — even when an agent's frontmatter `name`
  // differs from its filename.
  return discoverAgentDefinitions().find((agent) => agent.name === agentName) ?? null;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

export const DEFAULT_INTERRUPT_GRACE_MS = 5_000;
const INTERRUPTED_EXIT_CODE = 130;
const INTERRUPTED_ERROR = "Subagent interrupted by parent after the grace period.";

/** Parse PI_SUBAGENT_INTERRUPT_GRACE_MS; invalid values use five seconds. */
function parseInterruptGraceMs(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_INTERRUPT_GRACE_MS;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_INTERRUPT_GRACE_MS;
}

function getInterruptGraceMs(): number {
  return parseInterruptGraceMs(process.env.PI_SUBAGENT_INTERRUPT_GRACE_MS);
}

function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require herdr. ${terminalSetupHint()}`,
      },
    ],
    details: { error: "herdr not available" },
  };
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

const statusConfig = loadStatusConfig();
const modelConfig = loadModelConfig();

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "errorMessage" | "partial" | "timeout"
  >,
  name: string,
): string {
  const sessionRef = result.sessionFile
    ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
    : "";

  if (result.errorMessage) {
    // Auto-retry exhausted or other agent-loop error. The subagent did not
    // produce a usable result — surface the underlying provider/network
    // failure so the orchestrator can decide whether to retry, resume, or
    // change approach instead of silently treating the run as completed.
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or resume the session with subagent_resume.${sessionRef}`
    );
  }

  if (result.partial) {
    return (
      `Sub-agent "${name}" delivered a partial report under its time limit ` +
      `(${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`
    );
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
}

function buildResultTimeoutDetails(result: Pick<SubagentResult, "partial" | "timeout">) {
  return {
    ...(result.partial ? { partial: true } : {}),
    ...(result.timeout ? { timeout: result.timeout } : {}),
  };
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  claudeSessionId?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  /** A normal completion produced by the one-shot time-limit report continuation. */
  partial?: boolean;
  timeout?: "warned-wrapup" | "hard-stop";
  ping?: { name: string; message: string };
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  launchScriptFile?: string;
  activityFile?: string;
  activity?: SubagentActivityState;
  activityRead?: {
    ok: boolean;
    reason?: "missing" | "invalid" | "wrong-id";
    error?: string;
  };
  abortController?: AbortController;
  /** Timer waiting for an interrupted autonomous child to become terminal. */
  interruptGraceTimer?: ReturnType<typeof setTimeout>;
  /** Synthetic terminal result after the parent-owned interrupt grace expires. */
  interrupted?: { errorMessage: string; interruptedAt: number };
  recovery?: RecoveryState;
  recoveryKilled?: { errorMessage: string; killedAt: number };
  timeLimit?: TimeLimitConfig;
  timeLimitWarned?: boolean;
  /** The deadline fixed at warning time so fresh report activity cannot extend an idle limit. */
  timeLimitDeadlineAt?: number;
  timeLimitStopped?: { errorMessage: string; stoppedAt: number };
  /** A report-only continuation has been requested and awaits its normal completion. */
  wrapupPending?: boolean;
  cli?: string;
  sentinelFile?: string;
  /**
   * Optional legacy status snapshot retained only for hydrating pre-lifecycle
   * runtime entries after /reload. Live observation uses `lifecycle` only.
   */
  statusState?: SubagentStatusState;
  lifecycle: SubagentLifecycle;
  /** Last projected kind used to detect stalled/recovered transitions. */
  lastProjectedKind?: LifecycleProjection["kind"];
  /**
   * When true, status transitions (stalled/recovered) do not wake the parent
   * session via a steer message. The widget still updates locally. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. planner).
   */
  interactive: boolean;
  /** Parent-resolved model/thinking selection and provenance. */
  runtimePlan: ResolvedRuntimePlan | undefined;
}

interface RecoveryPaneOperations {
  interruptPane: (surface: string) => void;
  closePane: (surface: string) => void;
  abortWatcher: (controller: AbortController | undefined) => void;
}

const DEFAULT_RECOVERY_PANE_OPERATIONS: RecoveryPaneOperations = {
  interruptPane,
  closePane,
  abortWatcher: (controller) => controller?.abort(),
};

interface TimeLimitPaneOperations extends RecoveryPaneOperations {
  writeWrapup: (sessionFile: string) => void;
  removeWrapup: (sessionFile: string) => void;
}

const DEFAULT_TIME_LIMIT_PANE_OPERATIONS: TimeLimitPaneOperations = {
  ...DEFAULT_RECOVERY_PANE_OPERATIONS,
  writeWrapup: writeWrapupDirective,
  removeWrapup: cleanupWrapupDirective,
};

interface SubagentRuntime {
  runningSubagents: Map<string, RunningSubagent>;
  pi?: ExtensionAPI;
  latestCtx?: ExtensionContext;
  modelCatalog?: string;
  agentCatalog?: string;
}

function createSubagentRuntime(): SubagentRuntime {
  return { runningSubagents: new Map<string, RunningSubagent>() };
}

/** Runtime state preserved across /reload. */
const runtime: SubagentRuntime =
  (globalThis as any)[RUNTIME_KEY] ??
  ((globalThis as any)[RUNTIME_KEY] = createSubagentRuntime());
const runningSubagents = runtime.runningSubagents;

export function shouldPreserveSubagentsOnShutdown(reason: unknown): boolean {
  return reason === "reload";
}

export function cleanupSubagentsForShutdown(
  reason: unknown,
  agents: Map<string, Pick<RunningSubagent, "abortController" | "lifecycle" | "interruptGraceTimer">>,
): void {
  if (shouldPreserveSubagentsOnShutdown(reason)) return;

  for (const agent of agents.values()) {
    if (agent.interruptGraceTimer != null) {
      clearTimeout(agent.interruptGraceTimer);
      agent.interruptGraceTimer = undefined;
    }
    if (agent.lifecycle) {
      agent.lifecycle = markDelivery(agent.lifecycle, "suppressed");
    }
    agent.abortController?.abort();
  }
  agents.clear();
}

export function shouldDeliverSubagentCompletion(
  running: Pick<RunningSubagent, "lifecycle">,
): boolean {
  // Authoritative gate: only pending deliveries may be sent.
  // Missing lifecycle (pre-migration fixtures) defaults to pending/true.
  return (running.lifecycle?.delivery ?? "pending") === "pending";
}

export function selectCompletionApi<T>(previous: T, current: T | undefined): T {
  return current ?? previous;
}

// ── Widget management ──

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number, endTime = Date.now()): string {
  const seconds = Math.floor((endTime - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACTIVE_ACCENT = "\x1b[38;2;77;163;255m";
const OPEN_ACCENT = "\x1b[38;2;214;158;46m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number, accent = ACTIVE_ACCENT): string {
  if (width <= 0) return "";
  if (width === 1) return `${accent}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${accent}│${RST}${truncRight}${" ".repeat(rightPad)}${accent}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${accent}│${RST}${truncLeft}${" ".repeat(pad)}${right}${accent}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number, accent = ACTIVE_ACCENT): string {
  if (width <= 0) return "";
  if (width === 1) return `${accent}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${accent}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number, accent = ACTIVE_ACCENT): string {
  if (width <= 0) return "";
  if (width === 1) return `${accent}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${accent}╰${"─".repeat(inner)}╯${RST}`;
}

function formatLifecycleWidgetLabel(
  projection: ReturnType<typeof projectLifecycle>,
  now: number,
): string {
  const duration = projection.stateDurationSince == null
    ? ""
    : ` ${formatElapsedDuration(now - projection.stateDurationSince)}`;
  if (projection.kind === "active") return projection.label
    ? ` active · ${projection.label}${duration} `
    : ` active${duration} `;
  if (projection.kind === "blocked") return ` blocked${duration} `;
  if (projection.kind === "running") return " running… ";
  if (projection.kind === "waiting") return ` waiting${duration} `;
  if (projection.kind === "interrupted") return ` interrupted${duration} `;
  if (projection.kind === "stalled") return ` stalled${duration} `;
  // completed/failed exist as lifecycle projections for delivery bookkeeping,
  // but the row is removed immediately after result delivery — so the only
  // visible terminal handoff label is finalizing.
  if (
    projection.kind === "finalizing" ||
    projection.kind === "completed" ||
    projection.kind === "failed"
  ) {
    return " finalizing… ";
  }
  return " starting… ";
}

function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
  const now = Date.now();
  const rendered = agents.map((agent) => ({
    agent,
    projection: projectLifecycle(ensureLifecycle(agent), now, {
      activeToolStallMs: parseActiveToolStallMs(process.env.PI_SUBAGENT_ACTIVE_TOOL_STALL_MS),
    }),
  }));
  const activeCount = rendered.filter(({ projection }) =>
    projection.kind === "active" ||
    projection.kind === "starting" ||
    projection.kind === "running" ||
    projection.kind === "blocked"
  ).length;
  const openCount = agents.length - activeCount;
  const info = activeCount > 0
    ? openCount > 0 ? `${activeCount} active · ${openCount} open` : `${activeCount} active`
    : `${openCount} open`;
  const accent = activeCount > 0 ? ACTIVE_ACCENT : OPEN_ACCENT;

  const lines: string[] = [borderTop("Subagents", info, width, accent)];

  for (const { agent, projection } of rendered) {
    const elapsed = formatElapsedMMSS(agent.startTime, projection.runtimeEndedAt ?? now);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const left = ` ${elapsed}  ${agent.name}${agentTag} `;
    const runtimeTag = agent.runtimePlan
      ? `${agent.runtimePlan.modelId}|${agent.runtimePlan.thinking} · `
      : "";
    const right = statusConfig.enabled
      ? ` ${runtimeTag}${formatLifecycleWidgetLabel(projection, now).trim()} `
      : agent.cli && agent.cli !== "pi"
        ? ` ${runtimeTag}running… `
        : ` ${runtimeTag}starting… `;

    lines.push(borderLine(left, right, width, accent));
  }

  lines.push(borderBottom(width, accent));
  return lines;
}

function updateWidget() {
  const latestCtx = runtime.latestCtx;
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(Array.from(runningSubagents.values()), width);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */


function ensureLifecycle(running: RunningSubagent): SubagentLifecycle {
  if (running.lifecycle) return running.lifecycle;
  let lifecycle = createLifecycle(running.startTime);
  const driver = getHarnessDriver(running.cli);
  if (!driver.hasActivitySnapshots) {
    lifecycle = markProcessRunning(lifecycle, running.startTime);
    running.lifecycle = lifecycle;
    return lifecycle;
  }
  const state = running.statusState;
  if (state?.activityLabel === "interrupted" && state.localOverrideAtMs != null) {
    lifecycle = markInterruptRequested(lifecycle, state.localOverrideAtMs);
  } else if (state?.phase === "done") {
    // Legacy activity "done" means the turn ended, not that completion
    // evidence was recorded. Hydrate as Herdr-style waiting and let the
    // preserved watcher consume sidecar/sentinel evidence.
    const observedAt = state.lastActivityAtMs ?? running.startTime;
    lifecycle = observePaneInspection(
      lifecycle,
      { kind: "present", observedAt, agentStatus: "done" },
      observedAt,
    );
  } else if (state?.phase === "active" || state?.phase === "waiting" || state?.phase === "starting") {
    lifecycle = observeActivity(lifecycle, {
      ok: true,
      activity: {
        version: 1,
        runningChildId: running.id,
        createdAt: running.startTime,
        updatedAt: state.lastActivityAtMs ?? running.startTime,
        sequence: state.lastActivitySequence ?? 0,
        latestEvent: state.latestEvent === "agent_end" ? "agent_end" : "agent_start",
        phase: state.phase,
        agentActive: state.phase === "active",
        turnActive: state.phase === "active",
        providerActive: false,
        toolActive: state.activeScope === "tool",
        ...(state.activeScope ? { activeScope: state.activeScope as any } : {}),
        ...(state.activeSinceMs != null ? { activeSince: state.activeSinceMs } : {}),
        ...(state.waitingSinceMs != null ? { waitingSince: state.waitingSinceMs } : {}),
        ...(state.activityLabel && state.activeScope === "tool" ? { toolName: state.activityLabel } : {}),
      },
    }, state.lastActivityAtMs ?? running.startTime);
  } else if (state?.hasActivitySnapshots === false || running.startTime) {
    // Pre-lifecycle Pi agents without a known phase still get a running process.
    lifecycle = markProcessRunning(lifecycle, running.startTime);
  }
  running.lifecycle = lifecycle;
  return lifecycle;
}

function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  ensureLifecycle(running);
  const driver = getHarnessDriver(running.cli);
  if (!driver.hasActivitySnapshots) return;

  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  running.activityRead = read.ok
    ? { ok: true }
    : { ok: false, reason: read.reason, error: read.error };

  if (read.ok) running.activity = read.activity;
  running.lifecycle = observeActivity(ensureLifecycle(running), read, observedAt);
}

function resolveInterruptTarget(params: { id?: string; name?: string }):
  | { running: RunningSubagent }
  | { error: string } {
  const requestedId = params.id?.trim();
  if (requestedId) {
    const running = runningSubagents.get(requestedId);
    return running ? { running } : { error: `No running subagent with id "${requestedId}".` };
  }

  const requestedName = params.name?.trim();
  if (!requestedName) {
    return { error: "Provide a running subagent id or exact display name." };
  }

  const matches = Array.from(runningSubagents.values()).filter((running) => running.name === requestedName);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    return { error: `No running subagent named "${requestedName}".` };
  }

  const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

function requestSubagentInterrupt(
  running: RunningSubagent,
  interruptPaneKey: (surface: string) => void = interruptPane,
): { ok: true } | { error: string } {
  try {
    interruptPaneKey(running.surface);
    return { ok: true };
  } catch (error: any) {
    return {
      error:
        `Failed to send Escape to subagent "${running.name}" via herdr: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

function isTerminalLifecycle(lifecycle: SubagentLifecycle): boolean {
  return lifecycle.process.kind === "completed" || lifecycle.process.kind === "failed";
}

/** Ignore a race where the pane disappeared before normal cleanup ran. */
function closePaneQuietly(
  surface: string,
  closePaneKey: (surface: string) => void = closePane,
): void {
  try {
    closePaneKey(surface);
  } catch {}
}

/** Persist a terminal projection so result delivery can remove its widget row. */
function reconcileProjectedFailure(running: RunningSubagent, projection: LifecycleProjection): LifecycleProjection {
  const lifecycle = ensureLifecycle(running);
  if (
    projection.kind !== "failed" ||
    lifecycle.pane.kind !== "missing" ||
    isTerminalLifecycle(lifecycle)
  ) {
    return projection;
  }

  const terminalAt = lifecycle.pane.detectedAt + MISSING_PANE_DEBOUNCE_MS;
  running.lifecycle = markFailed(
    lifecycle,
    projection.label ?? MISSING_PANE_ERROR,
    terminalAt,
    1,
  );
  return projectLifecycle(running.lifecycle, terminalAt);
}

function clearInterruptGraceTimer(running: RunningSubagent): void {
  if (running.interruptGraceTimer == null) return;
  clearTimeout(running.interruptGraceTimer);
  running.interruptGraceTimer = undefined;
}

/**
 * Finish a parent-requested interrupt without asking the child to publish a
 * completion sidecar. Escape intentionally disarms child auto-exit; the
 * parent owns the bounded terminal transition and preserves the JSONL.
 */
function finalizeInterruptedSubagent(
  running: RunningSubagent,
  now: number,
  operations: Pick<RecoveryPaneOperations, "closePane" | "abortWatcher"> = DEFAULT_RECOVERY_PANE_OPERATIONS,
): boolean {
  const lifecycle = ensureLifecycle(running);
  if (
    lifecycle.process.kind === "finalizing" ||
    isTerminalLifecycle(lifecycle) ||
    lifecycle.delivery !== "pending"
  ) {
    return false;
  }

  running.interrupted = { errorMessage: INTERRUPTED_ERROR, interruptedAt: now };
  running.lifecycle = markFailed(lifecycle, INTERRUPTED_ERROR, now, INTERRUPTED_EXIT_CODE);
  try {
    operations.closePane(running.surface);
  } catch {}
  try {
    operations.abortWatcher(running.abortController);
  } catch {}
  return true;
}

function scheduleInterruptedFinalization(
  running: RunningSubagent,
  graceMs = getInterruptGraceMs(),
  operations: Pick<RecoveryPaneOperations, "closePane" | "abortWatcher"> = DEFAULT_RECOVERY_PANE_OPERATIONS,
): boolean {
  if (
    running.interactive ||
    running.interruptGraceTimer != null ||
    running.interrupted != null ||
    isTerminalLifecycle(ensureLifecycle(running))
  ) {
    return false;
  }

  const delay = Math.max(0, Math.floor(graceMs));
  const timer = setTimeout(() => {
    running.interruptGraceTimer = undefined;
    if (finalizeInterruptedSubagent(running, Date.now(), operations)) updateWidget();
  }, delay);
  timer.unref?.();
  running.interruptGraceTimer = timer;
  return true;
}

/** Idempotent failure teardown shared with future hard-stop paths. */
function failAndTeardownSubagent(
  running: RunningSubagent,
  error: string,
  now: number,
  operations: Pick<RecoveryPaneOperations, "closePane" | "abortWatcher"> = DEFAULT_RECOVERY_PANE_OPERATIONS,
  beforeAbort?: () => void,
): boolean {
  const lifecycle = ensureLifecycle(running);
  if (isTerminalLifecycle(lifecycle)) return false;

  beforeAbort?.();
  running.lifecycle = markFailed(lifecycle, error, now, 1);
  try {
    operations.closePane(running.surface);
  } catch {}
  try {
    operations.abortWatcher(running.abortController);
  } catch {}
  return true;
}

function advanceRunningRecovery(
  running: RunningSubagent,
  projection: LifecycleProjection,
  now: number,
  delays: RecoveryDelays,
  operations: RecoveryPaneOperations = DEFAULT_RECOVERY_PANE_OPERATIONS,
) {
  const advance = advanceRecoveryLadder(running.recovery, {
    now,
    stalled: projection.kind === "stalled",
    exempt:
      running.interactive ||
      running.wrapupPending === true ||
      running.timeLimitStopped != null,
    delays,
  });
  running.recovery = advance.state;

  if (advance.action === "nudge") {
    requestSubagentInterrupt(running, operations.interruptPane);
  } else if (advance.action === "kill") {
    const error = formatRecoveryKillError(now - running.startTime);
    failAndTeardownSubagent(running, error, now, operations, () => {
      // The watcher observes its abort asynchronously, so set this first.
      running.recoveryKilled = { errorMessage: error, killedAt: now };
    });
  }

  return advance;
}

function buildRecoveryKilledResult(running: RunningSubagent, now: number): SubagentResult | null {
  const recoveryKilled = running.recoveryKilled;
  if (!recoveryKilled) return null;
  return {
    name: running.name,
    task: running.task,
    summary: `Subagent error: ${recoveryKilled.errorMessage}`,
    sessionFile: running.sessionFile,
    exitCode: 1,
    elapsed: Math.floor(Math.max(0, now - running.startTime) / 1000),
    error: recoveryKilled.errorMessage,
    errorMessage: recoveryKilled.errorMessage,
  };
}

function buildInterruptedResult(running: RunningSubagent, now: number): SubagentResult | null {
  const interrupted = running.interrupted;
  if (!interrupted) return null;
  return {
    name: running.name,
    task: running.task,
    summary: `${interrupted.errorMessage}\n\nThe session remains on disk and can be resumed with subagent_resume.`,
    sessionFile: running.sessionFile,
    exitCode: INTERRUPTED_EXIT_CODE,
    elapsed: Math.floor(Math.max(0, now - running.startTime) / 1000),
    error: "interrupted",
  };
}

function advanceRunningTimeLimit(
  running: RunningSubagent,
  now: number,
  operations: TimeLimitPaneOperations = DEFAULT_TIME_LIMIT_PANE_OPERATIONS,
): { action: "warn" | "hard-stop" | null } {
  if (
    running.interactive ||
    !running.timeLimit ||
    running.recoveryKilled ||
    running.timeLimitStopped
  ) {
    return { action: null };
  }

  const lastActivityAt = running.activity?.updatedAt;
  const action = running.timeLimitDeadlineAt != null
    ? now >= running.timeLimitDeadlineAt ? "hard-stop" : "none"
    : evalTimeLimit(
      now,
      running.startTime,
      lastActivityAt,
      running.timeLimit,
      running.timeLimitWarned === true,
    );

  if (action === "warn") {
    try {
      operations.writeWrapup(running.sessionFile);
    } catch {
      return { action: null };
    }
    const interruption = requestSubagentInterrupt(running, operations.interruptPane);
    if ("error" in interruption) {
      try {
        operations.removeWrapup(running.sessionFile);
      } catch {}
      return { action: null };
    }

    running.timeLimitWarned = true;
    running.wrapupPending = true;
    running.timeLimitDeadlineAt = getTimeLimitDeadlineAt(
      running.startTime,
      lastActivityAt,
      running.timeLimit,
    );
    running.lifecycle = markInterruptRequested(ensureLifecycle(running), now);
    return { action: "warn" };
  }

  if (action === "hard-stop") {
    const error = formatTimeLimitError(now - running.startTime);
    const stopped = failAndTeardownSubagent(running, error, now, operations, () => {
      running.timeLimitStopped = { errorMessage: error, stoppedAt: now };
      running.wrapupPending = false;
      try {
        operations.removeWrapup(running.sessionFile);
      } catch {}
    });
    return { action: stopped ? "hard-stop" : null };
  }

  return { action: null };
}

function buildTimeLimitStoppedResult(running: RunningSubagent, now: number): SubagentResult | null {
  const stopped = running.timeLimitStopped;
  if (!stopped) return null;

  let tail: string | null = null;
  try {
    if (existsSync(running.sessionFile)) {
      tail = findLastAssistantMessage(getNewEntries(running.sessionFile, 0));
    }
  } catch {}

  return {
    name: running.name,
    task: running.task,
    summary: `${stopped.errorMessage}${tail ? `\n\nLast session output:\n${tail}` : ""}`,
    sessionFile: running.sessionFile,
    exitCode: 1,
    elapsed: Math.floor(Math.max(0, now - running.startTime) / 1_000),
    error: stopped.errorMessage,
    timeout: "hard-stop",
  };
}

function handleSubagentInterrupt(
  params: { id?: string; name?: string },
  interruptPaneKey: (surface: string) => void = interruptPane,
  options: {
    closePane?: (surface: string) => void;
    abortWatcher?: (controller: AbortController | undefined) => void;
    graceMs?: number;
  } = {},
) {
  const resolved = resolveInterruptTarget(params);
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  const driver = getHarnessDriver(running.cli);
  if (!driver.supportsTurnInterrupt) {
    return {
      content: [{
        type: "text" as const,
        text:
          `Turn-only Escape interrupt is currently supported only for Pi-backed subagents. ${driver.name}-backed semantics have not been verified yet.`,
      }],
      details: {
        error: `${running.cli ?? "external"} interrupt unsupported`,
        id: running.id,
        name: running.name,
      },
    };
  }

  const now = Date.now();
  observeRunningSubagent(running, now);

  const interruption = requestSubagentInterrupt(running, interruptPaneKey);
  if ("error" in interruption) {
    return {
      content: [{ type: "text" as const, text: interruption.error }],
      details: { error: interruption.error, id: running.id, name: running.name },
    };
  }

  running.lifecycle = markInterruptRequested(ensureLifecycle(running), now);
  if (!running.interactive && running.abortController) {
    scheduleInterruptedFinalization(
      running,
      options.graceMs ?? getInterruptGraceMs(),
      {
        closePane: options.closePane ?? closePane,
        abortWatcher: options.abortWatcher ?? DEFAULT_RECOVERY_PANE_OPERATIONS.abortWatcher,
      },
    );
  }
  updateWidget();

  return {
    content: [{ type: "text" as const, text: `Interrupt requested for subagent "${running.name}".` }],
    details: { id: running.id, name: running.name, status: "interrupt_requested" },
  };
}

function startStatusRefresh(pi: ExtensionAPI) {
  if (!statusConfig.enabled || statusInterval) return;
  const recoveryDelays = parseRecoveryDelays(process.env.PI_SUBAGENT_RECOVERY_DELAYS_MS);
  const activeToolStallMs = parseActiveToolStallMs(process.env.PI_SUBAGENT_ACTIVE_TOOL_STALL_MS);

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      // Dual-writes lifecycle + statusState for reload hydration; steers use lifecycle only.
      observeRunningSubagent(running, now);
      const projection = reconcileProjectedFailure(
        running,
        projectLifecycle(ensureLifecycle(running), now, { activeToolStallMs }),
      );
      const recovery = advanceRunningRecovery(running, projection, now, recoveryDelays);
      if (recovery.action) shouldRefreshWidget = true;
      const transition = lifecycleTransition(running.lastProjectedKind, projection.kind);
      if (running.lastProjectedKind !== projection.kind) {
        shouldRefreshWidget = true;
      }
      running.lastProjectedKind = projection.kind;

      // Interactive subagents (long-running, user-driven) intentionally don't
      // wake the parent session on stalled/recovered transitions — the user is
      // working in the subagent's pane, and a steer message here would burn an
      // orchestrator turn on a no-op "still waiting" ping. Widget still updates.
      if (transition && !running.interactive) {
        transitionLines.push(
          formatLifecycleTransitionLine(
            normalizeStatusName(running.name),
            projection,
            transition,
            now,
            running.startTime,
            formatElapsedDuration,
          ),
        );
      }
    }

    if (shouldRefreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(transitionLines, statusConfig.lineLimit),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

function clearResumeExitSidecar(sessionFile: string): void {
  try {
    unlinkSync(`${sessionFile}.exit`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function resolveResumeLaunchBehavior(params: { autoExit?: boolean }): { autoExit: boolean; interactive: boolean } {
  const autoExit = params.autoExit ?? true;
  return { autoExit, interactive: !autoExit };
}

function buildResumeAutoExitEnv(params: { autoExit: boolean; hasMessage: boolean }): string[] {
  if (!params.autoExit) return [];
  return [
    "PI_SUBAGENT_AUTO_EXIT=1",
    // A resumed session is a fresh autonomous run even when its JSONL ends in
    // an operator Escape. The child consumes this one-shot re-arm on settle.
    "PI_SUBAGENT_AUTO_EXIT_REARM=1",
    ...(params.hasMessage ? ["PI_SUBAGENT_RESUME_INPUT=1"] : []),
  ];
}

export const __test__ = {
  borderLine,
  getShellReadyDelayMs,
  renderSubagentWidgetLines,
  loadAgentDefaults,
  discoverAgentDefinitions,
  buildAvailableAgentCatalog,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveAutoExit,
  resolveEffectiveInteractive,
  resolveTimeLimitConfig,
  parseAgentDefinition,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  observeRunningSubagent,
  resolveDenyTools,
  parseSpawnDepth,
  decrementSpawnDepth,
  clampResumeSpawn,
  readSpawnMetadata,
  ensureResumeSessionCwd,
  blockedSelfSpawn,
  SPAWNING_TOOLS,
  resolveInterruptTarget,
  requestSubagentInterrupt,
  reconcileProjectedFailure,
  closePaneQuietly,
  failAndTeardownSubagent,
  advanceRunningRecovery,
  buildRecoveryKilledResult,
  advanceRunningTimeLimit,
  buildTimeLimitStoppedResult,
  buildResultTimeoutDetails,
  buildInterruptedResult,
  parseInterruptGraceMs,
  getInterruptGraceMs,
  DEFAULT_INTERRUPT_GRACE_MS,
  scheduleInterruptedFinalization,
  finalizeInterruptedSubagent,
  buildResumeAutoExitEnv,
  handleSubagentInterrupt,
  resolveResultPresentation,
  resolveResumeLaunchBehavior,
  clearResumeExitSidecar,
  preflightSubagentDonePath,
  enrichNoSessionFailure,
  writeSpawnMetadata,
  discoverOrphanedSubagents,
  formatOrphanRestoreReport,
  isActionableOrphan,
  isRestorableOrphan,
  resumeOrphanedSubagents,
  runningSubagents,
  formatElapsed,
};

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/**
 * Launch a subagent: creates the herdr pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  params: typeof SubagentParams.static,
  ctx: {
    sessionManager: { getSessionFile(): string | null; getSessionId(): string; getSessionDir(): string };
    cwd: string;
    model?: { provider: string; id: string };
    modelRegistry: {
      find(provider: string, modelId: string): any;
      getAvailable?: () => any[];
      getAll?: () => any[];
      hasConfiguredAuth?: (model: any) => boolean;
    };
  },
  parentThinking: ThinkingLevel,
  options?: { surface?: string },
): Promise<RunningSubagent> {
  preflightSubagentDonePath();
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  if (!ctx.model) throw new Error("Subagent launch requires a resolved parent model");
  const runtimePlan = resolveRuntimePlan(
    { model: params.model, thinking: params.thinking },
    {
      model: resolveModelDefault(params.agent, agentDefs?.model, modelConfig),
      thinking: agentDefs?.thinking,
    },
    { provider: ctx.model.provider, modelId: ctx.model.id, thinking: parentThinking },
    wrapPiModelRegistry(ctx.modelRegistry),
  );
  const effectiveThinking = runtimePlan.thinking;
  const effectiveAutoExit = resolveEffectiveAutoExit(params, agentDefs);
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);
  const cliId = agentDefs?.cli ?? "pi";
  const driver = getHarnessDriver(cliId);
  const timeLimit = resolveTimeLimitConfig(agentDefs, effectiveInteractive, driver.id === "pi");

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

  const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(params, agentDefs);
  const targetCwdForSession = effectiveCwd ?? ctx.cwd;
  const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

  // Generate a deterministic session file path for this subagent.
  // This eliminates race conditions when multiple agents launch simultaneously —
  // each agent knows exactly which file is theirs.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  driver.validateRuntimePlan?.(runtimePlan, parentThinking);

  const surfacePreCreated = !!options?.surface;
  const surface = options?.surface ?? createSubagentPane(params.name);
  if (params.task) {
    setPaneTask(surface, params.task);
  }
  if (!surfacePreCreated) {
    await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
  }

  const launchBehavior = resolveLaunchBehavior(params, agentDefs);

  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
    });
  }

  const activityFile = getSubagentActivityFile(artifactDir, id);
  if (driver.hasActivitySnapshots) {
    mkdirSync(dirname(activityFile), { recursive: true });
  }
  const { inheritsConversationContext } = launchBehavior;

  // Build the task message
  // Only full-context fork mode inherits prior conversation state.
  // Blank-session modes need the wrapper instructions and artifact-backed handoff.
  const modeHint = effectiveAutoExit
    ? "Complete your task autonomously."
    : "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
  const summaryInstruction = effectiveAutoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";
  // Spawn grant + depth: this process's PI_SUBAGENT_SPAWN_DEPTH is the
  // generation ceiling for our direct children; they receive one less so
  // mutual spawning terminates.
  const launcherAllowance = parseSpawnDepth(process.env.PI_SUBAGENT_SPAWN_DEPTH);
  const spawnGranted = agentDefs?.spawning === true;
  const denySet = resolveDenyTools(agentDefs, launcherAllowance);
  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = systemPromptMode && identity;
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const effectiveModel = driver.formatModel(runtimePlan);

  const built = driver.buildCommand({
    params: { ...params, id },
    agentDefs,
    runtimePlan,
    effectiveModel,
    effectiveThinking,
    parentThinking,
    surface,
    artifactDir,
    sessionDir,
    subagentSessionFile,
    effectiveCwd,
    localAgentDir,
    effectiveAutoExit,
    effectiveInteractive,
    inheritsConversationContext,
    taskDelivery: launchBehavior.taskDelivery,
    denySet,
    childSpawnDepth: decrementSpawnDepth(launcherAllowance),
    identity,
    identityInSystemPrompt: Boolean(identityInSystemPrompt),
    systemPromptMode,
    roleBlock,
    modeHint,
    summaryInstruction,
    subagentsDir: SUBAGENTS_DIR,
    shellQuote,
  });

  const launchScriptName = `${(params.name || "subagent")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
  const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);

  const running: RunningSubagent = {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    surface,
    startTime,
    sessionFile: built.sessionFile ?? subagentSessionFile,
    launchScriptFile,
    cli: built.cli,
    sentinelFile: built.sentinelFile,
    interactive: effectiveInteractive,
    runtimePlan,
    activityFile: driver.hasActivitySnapshots ? activityFile : undefined,
    timeLimit,
    lifecycle: !driver.hasActivitySnapshots
      ? markProcessRunning(createLifecycle(startTime), Date.now())
      : createLifecycle(startTime),
  };

  // First-launch spawn metadata is durable lineage as well as the authoritative
  // cap for later subagent_resume. Write it before the command enters the pane
  // so a crash between pane creation and the first child message leaves a
  // discoverable phantom rather than an invisible launch.
  try {
    writeSpawnMetadata(running.sessionFile, {
      allowance: spawnGranted ? launcherAllowance ?? null : 0,
      parentSessionFile: sessionFile,
      parentSessionId: sessionId,
      childSessionFile: running.sessionFile,
      name: params.name,
      agent: params.agent ?? null,
      task: params.task,
      launchedAt: new Date(startTime).toISOString(),
    });
  } catch {
    // Unwritable sidecar ⇒ resume conservatively denies spawning, as before.
  }

  runScriptInPane(surface, built.command, {
    scriptPath: launchScriptFile,
    scriptPreamble: (built.launchScriptPreamble ?? [
      `# Subagent launch script for ${params.name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Surface: ${surface}`,
    ]).join("\n"),
  });

  runningSubagents.set(id, running);
  return running;
}

const FAILURE_PANE_TAIL_LINES = 20;

function enrichNoSessionFailure(
  result: Pick<import("./completion.ts").CompletionResult, "exitCode">,
  running: Pick<RunningSubagent, "sessionFile" | "surface">,
  summary: string,
  readPaneFn: typeof readPane = readPane,
): { summary: string; error?: string } {
  if (result.exitCode === 0 || existsSync(running.sessionFile)) return { summary };

  let paneTail: string;
  try {
    paneTail = readPaneFn(running.surface, FAILURE_PANE_TAIL_LINES);
  } catch {
    return { summary };
  }
  if (!paneTail.trim()) return { summary };

  return {
    summary: `${summary}\n\nChild pane output:\n${paneTail}`,
    error: paneTail,
  };
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface,
 * and removes the entry from runningSubagents.
 */
async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile } = running;

  try {
    const result = await waitForCompletion(signal, {
      intervalMs: 1000,
      sessionFile,
      sentinelFile: running.sentinelFile,
      readTerminalTail: () => readPaneAsync(surface, 5),
      inspectPane: async () => inspectPane(surface),
      onPaneInspection: (inspection: PaneInspection, observedAt: number) => {
        ensureLifecycle(running);
        running.lifecycle = observePaneInspection(running.lifecycle, inspection, observedAt);
        updateWidget();
      },
      onTick() {
        const now = Date.now();
        observeRunningSubagent(running, now);
        if (advanceRunningTimeLimit(running, now).action) updateWidget();
      },
    });

    const detectedAt = Date.now();
    const interruptedResult = buildInterruptedResult(running, detectedAt);
    if (interruptedResult) {
      updateWidget();
      return interruptedResult;
    }
    const timeLimitResult = buildTimeLimitStoppedResult(running, detectedAt);
    if (timeLimitResult) {
      updateWidget();
      return timeLimitResult;
    }
    const recoveryResult = buildRecoveryKilledResult(running, detectedAt);
    if (recoveryResult) {
      updateWidget();
      return recoveryResult;
    }
    running.lifecycle = markCompletionDetected(running.lifecycle, result, detectedAt);
    updateWidget();
    const elapsed = Math.floor((detectedAt - startTime) / 1000);

    const driver = getHarnessDriver(running.cli);
    if (driver.extractResult) {
      const extracted = await driver.extractResult({
        running,
        completionResult: result,
        surface,
        readPane,
        closePane,
        artifactDir: dirname(running.launchScriptFile ?? running.sessionFile),
      });

      if (extracted) {
        const enriched = enrichNoSessionFailure(result, running, extracted.summary);
        closePaneQuietly(surface);
        running.lifecycle = result.exitCode === 0
          ? markCompleted(running.lifecycle, Date.now())
          : markFailed(running.lifecycle, result.errorMessage ?? enriched.summary, Date.now(), result.exitCode);

        return {
          name,
          task,
          summary: enriched.summary,
          exitCode: result.exitCode,
          elapsed,
          ...(enriched.error ? { error: enriched.error } : {}),
          ...(extracted.sessionId ? { claudeSessionId: extracted.sessionId } : {}),
          ...(result.wrapup ? { partial: true, timeout: "warned-wrapup" as const } : {}),
          ...extracted.details,
        };
      }
    }

    // Pi subagent result extraction
    let summary: string;
    if (existsSync(sessionFile)) {
      const allEntries = getNewEntries(sessionFile, 0);
      const observed = findObservedSessionRuntime(allEntries);
      if (running.runtimePlan && observed.provider && observed.modelId) {
        const observedModel = `${observed.provider}/${observed.modelId}`;
        const observedThinking =
          observed.thinking === "off" ||
          observed.thinking === "minimal" ||
          observed.thinking === "low" ||
          observed.thinking === "medium" ||
          observed.thinking === "high" ||
          observed.thinking === "xhigh" ||
          observed.thinking === "max"
            ? observed.thinking
            : undefined;
        const mismatch = observedModel !== running.runtimePlan.model
          ? `Resolved model ${running.runtimePlan.model} but child reported ${observedModel}`
          : undefined;
        running.runtimePlan = {
          ...running.runtimePlan,
          ...(observedThinking ? { thinking: observedThinking } : {}),
          observed: {
            model: observedModel,
            ...(observedThinking ? { thinking: observedThinking } : {}),
          },
          ...(mismatch ? { runtimeMismatch: mismatch } : {}),
        };
      }
      summary =
        findLastAssistantMessage(allEntries) ??
        (result.errorMessage
          ? `Subagent error: ${result.errorMessage}`
          : result.exitCode !== 0
            ? `Sub-agent exited with code ${result.exitCode}`
            : "Sub-agent exited without output");
    } else {
      summary = result.errorMessage
        ? `Subagent error: ${result.errorMessage}`
        : result.exitCode !== 0
          ? `Sub-agent exited with code ${result.exitCode}`
          : "Sub-agent exited without output";
    }

    const enriched = enrichNoSessionFailure(result, running, summary);
    closePaneQuietly(surface);
    running.lifecycle = result.exitCode === 0
      ? markCompleted(running.lifecycle, Date.now())
      : markFailed(running.lifecycle, result.errorMessage ?? enriched.summary, Date.now(), result.exitCode);

    return {
      name,
      task,
      summary: enriched.summary,
      sessionFile,
      exitCode: result.exitCode,
      elapsed,
      ping: result.ping,
      ...(enriched.error ? { error: enriched.error } : {}),
      ...(result.wrapup ? { partial: true, timeout: "warned-wrapup" as const } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    };
  } catch (err: any) {
    const now = Date.now();
    const timeLimitResult = buildTimeLimitStoppedResult(running, now);
    if (timeLimitResult) {
      updateWidget();
      return timeLimitResult;
    }
    const recoveryResult = buildRecoveryKilledResult(running, now);
    if (recoveryResult) {
      running.lifecycle = markFailed(running.lifecycle, recoveryResult.errorMessage!, now, 1);
      updateWidget();
      return recoveryResult;
    }
    const interruptedResult = buildInterruptedResult(running, now);
    if (interruptedResult) {
      updateWidget();
      return interruptedResult;
    }

    try {
      closePane(surface);
    } catch {}
    running.lifecycle = markFailed(
      running.lifecycle,
      signal.aborted ? "Subagent cancelled." : err?.message ?? String(err),
      now,
      1,
    );
    updateWidget();

    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((now - startTime) / 1000),
        error: "cancelled",
        sessionFile,
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((now - startTime) / 1000),
      error: err?.message ?? String(err),
    };
  } finally {
    clearInterruptGraceTimer(running);
    cleanupWrapupDirective(sessionFile);
  }
}

type RegisteredToolExecutor = (...args: any[]) => Promise<any>;

export default function subagentsExtension(pi: ExtensionAPI) {
  runtime.pi = pi;
  let spawnToolExecutor: RegisteredToolExecutor | undefined;
  let resumeToolExecutor: RegisteredToolExecutor | undefined;
  let restoreInFlight = false;

  function currentSessionFile(ctx: any): string | null {
    try {
      const file = ctx?.sessionManager?.getSessionFile?.();
      return typeof file === "string" && file.trim() ? file : null;
    } catch {
      return null;
    }
  }

  function discoverCurrentOrphans(ctx: any): DiscoveredOrphan[] {
    const sessionFile = currentSessionFile(ctx);
    if (!sessionFile) return [];
    let sessionId: string | undefined;
    try {
      const id = ctx?.sessionManager?.getSessionId?.();
      if (typeof id === "string" && id.trim()) sessionId = id;
    } catch {
      // A damaged/ephemeral session cannot provide an artifact namespace.
    }

    let paneSessions: ReturnType<typeof listPaneSessionReferences> = [];
    try {
      paneSessions = listPaneSessionReferences();
    } catch {
      // Herdr may be restarting during parent restore; disk discovery remains useful.
    }
    return discoverOrphanedSubagents(sessionFile, {
      ...(sessionId ? { parentSessionId: sessionId } : {}),
      paneSessions,
    });
  }

  function appendRestoreHandled(child: DiscoveredOrphan, action: "resume" | "relaunch" | "report"): void {
    const appendEntry = (pi as any).appendEntry;
    if (typeof appendEntry !== "function") return;
    try {
      appendEntry("subagent_restore_handled", {
        childSessionFile: child.sessionFile,
        classification: child.classification,
        action,
        handledAt: new Date().toISOString(),
      });
    } catch {
      // Completion delivery remains authoritative when the marker cannot be persisted.
    }
  }

  function reportOrphansAtSessionStart(ctx: any): void {
    // A child inherits the parent session directory and must not try to restore
    // its parent's siblings when its own extension starts.
    if (process.env.PI_SUBAGENT_ID) return;
    const children = discoverCurrentOrphans(ctx);
    const pending = children.filter(isActionableOrphan);
    const content = formatOrphanRestoreReport(pending);
    if (!content) return;

    const reportedChildren = pending
      .filter((child) => child.classification === "completed-undelivered")
      .map((child) => ({ childSessionFile: child.sessionFile }));
    try {
      pi.sendMessage(
        {
          customType: "subagent_restore_report",
          content,
          display: true,
          details: {
            children: pending.map((child) => ({
              childSessionFile: child.sessionFile,
              name: child.name,
              classification: child.classification,
            })),
            reportedChildren,
          },
        },
        // Keep startup passive: the report is context for the next user turn,
        // not an instruction to resume children before the user asks.
        { triggerTurn: false, deliverAs: "steer" },
      );
      for (const child of pending) {
        if (child.classification === "completed-undelivered") appendRestoreHandled(child, "report");
      }
    } catch {
      // A session can be torn down while startup hooks are still draining.
    }
  }

  function isStartedToolResult(result: any): boolean {
    return result?.details?.status === "started";
  }

  async function restoreOnResume(ctx: any): Promise<boolean> {
    if (restoreInFlight) return true;
    const children = discoverCurrentOrphans(ctx);
    const pending = children.filter(isRestorableOrphan);
    if (pending.length === 0) return false;
    if (!resumeToolExecutor && pending.some((child) => child.classification !== "phantom")) {
      ctx?.ui?.notify?.("Cannot resume orphaned subagents: subagent_resume is unavailable.", "error");
      return true;
    }
    if (!spawnToolExecutor && pending.some((child) => child.classification === "phantom")) {
      ctx?.ui?.notify?.("Cannot relaunch phantom subagents: subagent is unavailable.", "error");
      return true;
    }

    restoreInFlight = true;
    try {
      const outcomes: OrphanResumeOutcome[] = await resumeOrphanedSubagents(pending, {
        closePane: (paneId) => closePane(paneId),
        resume: async (child) => {
          if (!resumeToolExecutor) throw new Error("subagent_resume is unavailable");
          const result = await resumeToolExecutor(
            `restore-resume-${child.name}`,
            {
              sessionPath: child.sessionFile,
              name: `Resume ${child.name}`,
              message: "Re-orient from your existing session, continue the interrupted task, and finish it. Return a concise final report when done.",
              autoExit: true,
            },
            undefined,
            undefined,
            ctx,
          );
          if (!isStartedToolResult(result)) {
            throw new Error(result?.content?.[0]?.text ?? "subagent_resume did not start");
          }
          // Persist the handled marker before moving to the next child so a
          // shutdown during a multi-child restore cannot replay this resume.
          appendRestoreHandled(child, "resume");
          return result;
        },
        relaunch: async (child) => {
          if (!spawnToolExecutor) throw new Error("subagent is unavailable");
          const result = await spawnToolExecutor(
            `restore-relaunch-${child.name}`,
            {
              name: child.name,
              task: child.task,
              ...(child.agent ? { agent: child.agent } : {}),
              interactive: false,
            },
            undefined,
            undefined,
            ctx,
          );
          if (!isStartedToolResult(result)) {
            throw new Error(result?.content?.[0]?.text ?? "subagent did not start");
          }
          appendRestoreHandled(child, "relaunch");
          return result;
        },
      });
      const failed = outcomes.filter((outcome) => !outcome.ok);
      if (failed.length > 0) {
        ctx?.ui?.notify?.(
          `Restore started ${outcomes.length - failed.length} subagent${outcomes.length - failed.length === 1 ? "" : "s"}; ${failed.length} failed to start.`,
          "warning",
        );
      } else {
        ctx?.ui?.notify?.(
          `Restore started ${outcomes.length} orphaned subagent${outcomes.length === 1 ? "" : "s"}.`,
          "info",
        );
      }
      return true;
    } finally {
      restoreInFlight = false;
    }
  }

  // Capture the UI context for widget updates and restore presentation for
  // subagents whose watchers survived a reload.
  pi.on("session_start", (_event, ctx) => {
    runtime.latestCtx = ctx;
    runtime.modelCatalog = buildAuthenticatedModelCatalog(wrapPiModelRegistry(ctx.modelRegistry));
    runtime.agentCatalog = buildAvailableAgentCatalog(
      discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation),
    );
    const refreshedGuidelines = buildSubagentRoutingGuidelines(
      runtime.modelCatalog,
      runtime.agentCatalog,
    );
    subagentRoutingGuidelines.splice(0, subagentRoutingGuidelines.length, ...refreshedGuidelines);
    if (runningSubagents.size > 0) {
      startWidgetRefresh();
      startStatusRefresh(pi);
      updateWidget();
    }
    reportOrphansAtSessionStart(ctx);
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", (event, _ctx) => {
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
      (globalThis as any)[STATUS_INTERVAL_KEY] = null;
    }

    cleanupSubagentsForShutdown((event as any).reason, runningSubagents);
  });

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(
    (process.env.PI_SUBAGENT_ID ? process.env.PI_DENY_TOOLS ?? "" : "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const shouldRegister = (name: string) => !deniedTools.has(name);

  // ── subagent tool ──
  if (shouldRegister("subagent")) {
    const subagentTool = {
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a sub-agent in a dedicated terminal herdr pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
      promptSnippet:
        "Spawn a sub-agent in a dedicated terminal herdr pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
      promptGuidelines: subagentRoutingGuidelines,
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // Prevent self-spawning (e.g. planner spawning another planner)
        // Non-empty here is guaranteed by blockedSelfSpawn requiring both args
        // truthy and equal, so the message always renders a real identity.
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (blockedSelfSpawn(params.agent, currentAgent)) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        // Validate prerequisites
        if (!isTerminalAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // Launch the subagent (creates pane, sends command)
        const parentThinking = pi.getThinkingLevel();
        if (
          parentThinking !== "off" &&
          parentThinking !== "minimal" &&
          parentThinking !== "low" &&
          parentThinking !== "medium" &&
          parentThinking !== "high" &&
          parentThinking !== "xhigh" &&
          parentThinking !== "max"
        ) {
          throw new Error(`Unsupported parent thinking level: ${parentThinking}`);
        }
        const running = await launchSubagent(params, ctx, parentThinking);

        // Create a separate AbortController for the watcher
        // (the tool's signal completes when we return)
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        // Start widget refresh and status supervision when the first agent launches
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget: start watching in background
        watchSubagent(running, watcherAbort.signal)
          .then((result) => {
            if (!shouldDeliverSubagentCompletion(running)) {
              running.lifecycle = markDelivery(running.lifecycle, "suppressed");
              runningSubagents.delete(running.id);
              updateWidget();
              return;
            }
            running.lifecycle = markDelivery(running.lifecycle, "delivered");
            runningSubagents.delete(running.id);
            updateWidget();
            const completionApi = selectCompletionApi(pi, runtime.pi);

            if (result.ping) {
              // Subagent is requesting help — steer a ping message with session path for resume
              const sessionRef = `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`;
              completionApi.sendMessage(
                {
                  customType: "subagent_ping",
                  content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
                  display: true,
                  details: {
                    name: result.ping.name,
                    message: result.ping.message,
                    agent: running.agent,
                    sessionFile: result.sessionFile,
                  },
                },
                { triggerTurn: true, deliverAs: "steer" },
              );
              return;
            }

            const basePresentation = resolveResultPresentation(result, running.name);
            const presentation = running.runtimePlan?.runtimeMismatch
              ? `${basePresentation}\n\nRuntime warning: ${running.runtimePlan.runtimeMismatch}`
              : basePresentation;

            completionApi.sendMessage(
              {
                customType: "subagent_result",
                content: presentation,
                display: true,
                details: {
                  name: running.name,
                  task: running.task,
                  agent: running.agent,
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: result.sessionFile,
                  ...buildResultTimeoutDetails(result),
                  ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
                  ...(result.claudeSessionId ? { claudeSessionId: result.claudeSessionId } : {}),
                  ...(running.runtimePlan ? { runtimePlan: running.runtimePlan } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            if (!shouldDeliverSubagentCompletion(running)) {
              running.lifecycle = markDelivery(running.lifecycle, "suppressed");
              runningSubagents.delete(running.id);
              updateWidget();
              return;
            }
            running.lifecycle = markDelivery(running.lifecycle, "delivered");
            runningSubagents.delete(running.id);
            updateWidget();
            selectCompletionApi(pi, runtime.pi).sendMessage(
              {
                customType: "subagent_result",
                content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name: running.name, task: running.task, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            launchScriptFile: running.launchScriptFile,
            model: running.runtimePlan?.model,
            thinking: running.runtimePlan?.thinking,
            runtimePlan: running.runtimePlan,
            status: "started",
          },
        };
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const name = typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        const agent = typeof partialArgs.agent === "string" && partialArgs.agent
          ? theme.fg("dim", ` (${partialArgs.agent})`)
          : "";
        const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
        let text =
          "▸ " +
          theme.fg("toolTitle", theme.bold(name)) +
          agent +
          cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          const runtime = details?.model
            ? ` — ${details.model}${details.thinking ? ` · ${details.thinking}` : ""}`
            : " — started";
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", runtime),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    };
    spawnToolExecutor = subagentTool.execute;
    pi.registerTool(subagentTool);
  }

  // ── subagent_interrupt tool ──
  if (shouldRegister("subagent_interrupt"))
    pi.registerTool({
      name: "subagent_interrupt",
      label: "Interrupt Subagent",
      description:
        "Interrupt the active turn of a running Pi-backed subagent. " +
        "Interactive children remain open for operator takeover; autonomous one-shot children " +
        "close after a bounded grace while their session stays resumable, and the parent delivers " +
        "a terminal interrupt result.",
      promptSnippet:
        "Interrupt the active turn of a running Pi-backed subagent. " +
        "Interactive children remain open for operator takeover; autonomous one-shot children " +
        "close after a bounded grace while their session stays resumable, and the parent delivers " +
        "a terminal interrupt result.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
        name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
      }),

      async execute(_toolCallId, params) {
        return handleSubagentInterrupt(params);
      },

      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : args.name ?? "(unknown)";
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(target)) +
            theme.fg("dim", " — interrupt turn"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.status === "interrupt_requested") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent")) +
              theme.fg("dim", " — interrupt requested"),
            0,
            0,
          );
        }

        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagents_list tool ──
  if (shouldRegister("subagents_list"))
    pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      promptSnippet:
        "List all available subagent definitions. " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      parameters: Type.Object({}),

      async execute() {
        const list = discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation);

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });



  // ── subagent_resume tool ──
  if (shouldRegister("subagent_resume")) {
    const subagentResumeTool = {
      name: "subagent_resume",
      label: "Resume Subagent",
      description:
        "Resume a previous sub-agent session in a new herdr pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
        "Use when a sub-agent was cancelled or needs follow-up work.",
      promptSnippet:
        "Resume a previous sub-agent session in a new herdr pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
        "Use when a sub-agent was cancelled or needs follow-up work.",
      parameters: Type.Object({
        sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
        name: Type.Optional(
          Type.String({ description: "Display name for the terminal tab. Default: 'Resume'" }),
        ),
        message: Type.Optional(
          Type.String({
            description: "Optional message to send after resuming (e.g. follow-up instructions)",
          }),
        ),
        autoExit: Type.Optional(
          Type.Boolean({
            description:
              "Whether the resumed session should automatically exit after completing its response. Defaults to true for autonomous follow-up work; set false for interactive resumed sessions.",
          }),
        ),
      }),

      renderCall(args, theme) {
        const name = args.name ?? "Resume";
        const text =
          "▸ " +
          theme.fg("toolTitle", theme.bold(name)) +
          theme.fg("dim", " — resuming session");
        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "Resume";

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const name = params.name ?? "Resume";
        const { autoExit, interactive } = resolveResumeLaunchBehavior(params);
        const startTime = Date.now();
        const id = Math.random().toString(16).slice(2, 10);

        if (!isTerminalAvailable()) {
          return muxUnavailableResult();
        }

        if (!existsSync(params.sessionPath)) {
          return {
            content: [
              { type: "text", text: `Error: session file not found: ${params.sessionPath}` },
            ],
            details: { error: "session not found" },
          };
        }

        const resumeCwd = ensureResumeSessionCwd(params.sessionPath, ctx.cwd);
        if (!resumeCwd.ok) {
          return {
            content: [{ type: "text", text: `Error: ${resumeCwd.error}` }],
            details: { error: resumeCwd.error },
          };
        }

        // A prior run may have left completion evidence behind after its watcher
        // consumed the original sidecar. It belongs to the old run, not this one.
        clearResumeExitSidecar(params.sessionPath);

        // Record entry count before resuming so we can extract new messages
        const entryCountBefore = getNewEntries(params.sessionPath, 0).length;

        const subagentDonePath = preflightSubagentDonePath();
        const surface = createSubagentPane(name);
        if (params.message) {
          setPaneTask(surface, params.message);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));

        // Build pi resume command
        const parts = ["pi", "--session", shellQuote(params.sessionPath)];

        // Load subagent-done extension so the agent can self-terminate if needed
        parts.push("-e", shellQuote(subagentDonePath));

        const sessionId = ctx.sessionManager.getSessionId();
        const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
        const activityFile = getSubagentActivityFile(artifactDir, id);
        mkdirSync(dirname(activityFile), { recursive: true });

        let resumeMsgFile: string | undefined;
        if (params.message) {
          const msgTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          resumeMsgFile = join(
            artifactDir,
            "subagent-resume",
            `${name
              .toLowerCase()
              .replace(/[^a-z0-9\s-]/g, "")
              .replace(/\s+/g, "-")
              .replace(/-+/g, "-")
              .replace(/^-|-$/g, "") || "resume"}-${msgTimestamp}-${id}.md`,
          );
          mkdirSync(dirname(resumeMsgFile), { recursive: true });
          writeFileSync(resumeMsgFile, params.message, "utf8");
          parts.push(shellQuote(`@${resumeMsgFile}`));
        }

        // Build env prefix — propagate PI_CODING_AGENT_DIR for config isolation
        const resumeEnvParts: string[] = [];
        if (process.env.PI_CODING_AGENT_DIR) {
          resumeEnvParts.push(`PI_CODING_AGENT_DIR=${shellQuote(process.env.PI_CODING_AGENT_DIR)}`);
        }
        resumeEnvParts.push(`PI_SUBAGENT_NAME=${shellQuote(name)}`);
        resumeEnvParts.push(`PI_SUBAGENT_SESSION=${shellQuote(params.sessionPath)}`);
        resumeEnvParts.push(`PI_SUBAGENT_ID=${shellQuote(id)}`);
        resumeEnvParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellQuote(activityFile)}`);
        resumeEnvParts.push(...buildResumeAutoExitEnv({
          autoExit,
          hasMessage: Boolean(params.message),
        }));
        // Spawn rights on resume are clamped to what the first launch recorded:
        // missing metadata ⇒ 0 (deny); never larger than first launch.
        const resumeSpawn = clampResumeSpawn(
          readSpawnMetadata(params.sessionPath),
          parseSpawnDepth(process.env.PI_SUBAGENT_SPAWN_DEPTH),
        );
        if (!resumeSpawn.maySpawn) {
          resumeEnvParts.push(`PI_DENY_TOOLS=${shellQuote([...SPAWNING_TOOLS].join(","))}`);
        }
        if (resumeSpawn.childEnvDepth !== null) {
          resumeEnvParts.push(`PI_SUBAGENT_SPAWN_DEPTH=${resumeSpawn.childEnvDepth}`);
        }
        const resumeEnvPrefix = resumeEnvParts.join(" ") + " ";

        const command = `${resumeEnvPrefix}${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;
        const launchScriptFile = join(
          artifactDir,
          "subagent-scripts",
          `${name
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "") || "resume"}-resume-${Date.now()}.sh`,
        );
        runScriptInPane(surface, command, {
          scriptPath: launchScriptFile,
          scriptPreamble: [
            `# Subagent resume script for ${name}`,
            `# Generated: ${new Date().toISOString()}`,
            `# Session: ${params.sessionPath}`,
            `# Surface: ${surface}`,
            ...(resumeMsgFile ? [`# Resume message file: ${resumeMsgFile}`] : []),
          ].join("\n"),
        });

        // Register as a running subagent for widget tracking
        const running: RunningSubagent = {
          id,
          name,
          task: params.message ?? "resumed session",
          surface,
          startTime,
          sessionFile: params.sessionPath,
          launchScriptFile,
          activityFile,
          interactive,
          runtimePlan: undefined,
          lifecycle: createLifecycle(startTime),
        };
        runningSubagents.set(id, running);
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget watcher
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        watchSubagent(running, watcherAbort.signal)
          .then((result) => {
            if (!shouldDeliverSubagentCompletion(running)) {
              running.lifecycle = markDelivery(running.lifecycle, "suppressed");
              runningSubagents.delete(running.id);
              updateWidget();
              return;
            }
            running.lifecycle = markDelivery(running.lifecycle, "delivered");
            runningSubagents.delete(running.id);
            updateWidget();
            const completionApi = selectCompletionApi(pi, runtime.pi);

            if (result.ping) {
              const sessionRef = `\n\nSession: ${params.sessionPath}\nResume: pi --session ${params.sessionPath}`;
              completionApi.sendMessage(
                {
                  customType: "subagent_ping",
                  content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
                  display: true,
                  details: {
                    name: result.ping.name,
                    message: result.ping.message,
                    sessionFile: params.sessionPath,
                  },
                },
                { triggerTurn: true, deliverAs: "steer" },
              );
              return;
            }

            const allEntries = getNewEntries(params.sessionPath, entryCountBefore);
            const summary = findLastAssistantMessage(allEntries) ??
              (result.errorMessage
                ? `Subagent error: ${result.errorMessage}`
                : result.exitCode !== 0
                  ? `Resumed session exited with code ${result.exitCode}`
                  : "Resumed session exited without new output");
            const basePresentation = resolveResultPresentation(
              { ...result, summary, sessionFile: params.sessionPath },
              name,
            );
            const presentation = running.runtimePlan?.runtimeMismatch
              ? `${basePresentation}\n\nRuntime warning: ${running.runtimePlan.runtimeMismatch}`
              : basePresentation;

            completionApi.sendMessage(
              {
                customType: "subagent_result",
                content: presentation,
                display: true,
                details: {
                  name,
                  task: params.message ?? "resumed session",
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: params.sessionPath,
                  ...buildResultTimeoutDetails(result),
                  ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
                  ...(running.runtimePlan ? { runtimePlan: running.runtimePlan } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            if (!shouldDeliverSubagentCompletion(running)) {
              running.lifecycle = markDelivery(running.lifecycle, "suppressed");
              runningSubagents.delete(running.id);
              updateWidget();
              return;
            }
            running.lifecycle = markDelivery(running.lifecycle, "delivered");
            runningSubagents.delete(running.id);
            updateWidget();
            selectCompletionApi(pi, runtime.pi).sendMessage(
              {
                customType: "subagent_result",
                content: `Resume error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        return {
          content: [{ type: "text", text: `Session "${name}" resumed.` }],
          details: {
            id,
            name,
            sessionPath: params.sessionPath,
            launchScriptFile,
            status: "started",
          },
        };
      },
    };
    resumeToolExecutor = subagentResumeTool.execute;
    pi.registerTool(subagentResumeTool);
  }

  // "resume" is intentionally handled only when durable restore work exists;
  // normal /resume session switching is dispatched before this input hook.
  pi.on("input", async (event, ctx) => {
    if (process.env.PI_SUBAGENT_ID) return { action: "continue" as const };
    const text = typeof (event as any)?.text === "string" ? (event as any).text.trim() : "";
    if ((event as any)?.source === "extension" || text.toLowerCase() !== "resume") {
      return { action: "continue" as const };
    }
    const restored = await restoreOnResume(ctx);
    return restored ? { action: "handled" as const } : { action: "continue" as const };
  });

  // /iterate command — fork the session into a subagent
  pi.registerCommand("iterate", {
    description: "Fork session into a subagent for focused work (bugfixes, iteration)",
    handler: async (args, _ctx) => {
      const task = args.trim() || "";
      const toolCall = task
        ? `Use subagent to fork an interactive session. fork: true, interactive: true, name: "Iterate", task: ${JSON.stringify(task)}`
        : `Use subagent to fork an interactive session. fork: true, interactive: true, name: "Iterate", task: "The user wants to do some hands-on work. Help them with whatever they need."`;
      pi.sendUserMessage(toolCall);
    },
  });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorMessage;
        const partial = !failed && (details.partial === true || details.timeout === "warned-wrapup");
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : partial
            ? (text: string) => theme.bg("customMessageBg", text)
            : (text: string) => theme.bg("toolSuccessBg", text);
        const icon = failed
          ? theme.fg("error", "✗")
          : partial
            ? theme.fg("warning", "⚠")
            : theme.fg("success", "✓");
        const status = errorMessage
          ? "failed (provider/agent error)"
          : failed
            ? `failed (exit ${exitCode})`
            : partial
              ? "partial report (time limit)"
              : "completed";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove session ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nSession: .+\nResume: .+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
          .replace(
            new RegExp(
              `^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
            ),
            "",
          );

        // Build content for the box
        const contentLines = [header];

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
            contentLines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_status message renderer ──
  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
        ];

        if (overflow > 0) {
          contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        }
        if (!options.expanded) {
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_ping message renderer ──
  pi.registerMessageRenderer("subagent_ping", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— needs help")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.message ?? "");
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
          }
        } else {
          const preview = (details.message ?? "").split("\n")[0].slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // /plan command — start the full planning workflow
  pi.registerCommand("plan", {
    description: "Start a planning session: /plan <what to build>",
    handler: async (args, ctx) => {
      const task = args.trim();
      if (!task) {
        ctx.ui.notify("Usage: /plan <what to build>", "warning");
        return;
      }

      // Load the plan skill from the subagents extension directory
      const planSkillPath = join(SUBAGENTS_DIR, "plan-skill.md");
      let content = readFileSync(planSkillPath, "utf8");
      content = content.replace(/^---\n[\s\S]*?\n---\n*/, "");
      pi.sendUserMessage(
        `<skill name="plan" location="${planSkillPath}">\n${content.trim()}\n</skill>\n\n${task}`,
      );
    },
  });
}
