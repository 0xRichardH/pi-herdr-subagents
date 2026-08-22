import type { ResolvedRuntimePlan, ThinkingLevel } from "../runtime-routing.ts";
import type { CompletionResult } from "../completion.ts";

export interface SubagentLaunchParams {
  id: string;
  name: string;
  task: string;
  agent?: string;
  cwd?: string;
  systemPrompt?: string;
  resumeSessionId?: string;
  tools?: string;
  skills?: string;
  interactive?: boolean;
}

export interface AgentDefinition {
  name: string;
  description?: string;
  model?: string;
  thinking?: string;
  tools?: string;
  skills?: string;
  sessionMode?: string;
  systemPromptMode?: string;
  interactive?: boolean;
  cli?: string;
  commandTemplate?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

export interface SubagentLaunchContext {
  params: SubagentLaunchParams;
  agentDefs?: AgentDefinition | null;
  runtimePlan: ResolvedRuntimePlan;
  effectiveModel?: string;
  effectiveThinking?: ThinkingLevel;
  parentThinking: ThinkingLevel;
  surface: string;
  artifactDir: string;
  sessionDir: string;
  subagentSessionFile: string;
  effectiveCwd: string;
  localAgentDir?: string;
  effectiveAutoExit: boolean;
  effectiveInteractive: boolean;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
  denySet?: Set<string>;
  /** PI_SUBAGENT_SPAWN_DEPTH handed to this child (its children's ceiling); null = unlimited. */
  childSpawnDepth?: number | null;
  identity?: string | null;
  identityInSystemPrompt?: boolean;
  systemPromptMode?: string;
  roleBlock?: string;
  modeHint?: string;
  summaryInstruction?: string;
  subagentsDir: string;
  shellQuote: (s: string) => string;
}

export interface BuiltHarnessCommand {
  /** The full shell command line to run in the pane (including cd and sentinel trailer) */
  command: string;
  sentinelFile?: string;
  sessionFile?: string;
  launchScriptPreamble?: string[];
  cli: string;
}

export interface SubagentResultContext {
  running: {
    id: string;
    name: string;
    task: string;
    agent?: string;
    surface: string;
    startTime: number;
    sessionFile: string;
    launchScriptFile?: string;
    cli?: string;
    sentinelFile?: string;
    interactive: boolean;
    runtimePlan?: ResolvedRuntimePlan;
  };
  completionResult: CompletionResult;
  surface: string;
  readPane: (surface: string, lines?: number) => string;
  closePane: (surface: string) => void;
  artifactDir: string;
}

export interface HarnessResult {
  summary: string;
  sessionId?: string;
  details?: Record<string, unknown>;
}

export interface HarnessDriver {
  /** Canonical CLI identifier (e.g. "pi", "claude", "opencode", "codex", "grok", "generic") */
  readonly id: string;

  /** Human-readable display name (e.g. "Claude Code", "OpenCode", "Codex", "Grok", "Pi") */
  readonly name: string;

  /** Format the model reference for this CLI */
  formatModel(runtimePlan: Pick<ResolvedRuntimePlan, "model" | "modelId" | "provider">): string;

  /** Optional validation of runtime plan before launch (e.g. thinking overrides) */
  validateRuntimePlan?(runtimePlan: ResolvedRuntimePlan, parentThinking: ThinkingLevel): void;

  /** Build the execution command line and metadata for launch */
  buildCommand(context: SubagentLaunchContext): BuiltHarnessCommand;

  /** Extract the final summary / session info on completion */
  extractResult?(context: SubagentResultContext): Promise<HarnessResult | null> | HarnessResult | null;

  /** Whether this CLI writes structured .activity.json snapshots */
  readonly hasActivitySnapshots?: boolean;

  /** Whether this CLI supports Turn-only Escape interrupts */
  readonly supportsTurnInterrupt?: boolean;
}
