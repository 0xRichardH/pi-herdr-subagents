import type {
  HarnessDriver,
  SubagentLaunchContext,
  BuiltHarnessCommand,
  SubagentResultContext,
  HarnessResult,
} from "../types.ts";
import type { ResolvedRuntimePlan } from "../../runtime-routing.ts";
import { extractPaneSummary } from "../pane-summary.ts";

export class CodexHarnessDriver implements HarnessDriver {
  readonly id = "codex";
  readonly name = "Codex";
  readonly hasActivitySnapshots = false;
  readonly supportsTurnInterrupt = false;

  formatModel(runtimePlan: Pick<ResolvedRuntimePlan, "model" | "modelId" | "provider">): string {
    return runtimePlan.modelId;
  }

  buildCommand(context: SubagentLaunchContext): BuiltHarnessCommand {
    const {
      params,
      agentDefs,
      effectiveModel,
      effectiveThinking,
      effectiveCwd,
      surface,
      shellQuote,
      inheritsConversationContext,
      roleBlock,
      modeHint,
      summaryInstruction,
    } = context;

    const fullTask = inheritsConversationContext
      ? params.task
      : `${roleBlock ?? ""}\n\n${modeHint ?? ""}\n\n${params.task}\n\n${summaryInstruction ?? ""}`;

    const cmdParts: string[] = ["codex"];

    if (effectiveModel) {
      cmdParts.push("--model", shellQuote(effectiveModel));
    }

    if (effectiveThinking && ["low", "medium", "high"].includes(effectiveThinking)) {
      cmdParts.push("--reasoning-effort", shellQuote(effectiveThinking));
    }

    const sp = params.systemPrompt ?? agentDefs?.body;
    if (sp) {
      cmdParts.push("--system-prompt", shellQuote(sp));
    }

    cmdParts.push(shellQuote(fullTask));

    const cdPrefix = effectiveCwd ? `cd ${shellQuote(effectiveCwd)} && ` : "";
    const command = `${cdPrefix}${cmdParts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;

    return {
      command,
      cli: "codex",
      launchScriptPreamble: [
        `# Codex subagent launch script for ${params.name}`,
        `# Generated: ${new Date().toISOString()}`,
        `# Surface: ${surface}`,
      ],
    };
  }

  async extractResult(context: SubagentResultContext): Promise<HarnessResult | null> {
    return { summary: extractPaneSummary(context, this.name) };
  }
}
