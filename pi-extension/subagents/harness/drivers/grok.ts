import type {
  HarnessDriver,
  SubagentLaunchContext,
  BuiltHarnessCommand,
  SubagentResultContext,
  HarnessResult,
} from "../types.ts";
import type { ResolvedRuntimePlan } from "../../runtime-routing.ts";

export class GrokHarnessDriver implements HarnessDriver {
  readonly id = "grok";
  readonly name = "Grok";
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

    const cmdParts: string[] = ["grok"];

    if (effectiveModel) {
      cmdParts.push("--model", shellQuote(effectiveModel));
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
      cli: "grok",
      launchScriptPreamble: [
        `# Grok subagent launch script for ${params.name}`,
        `# Generated: ${new Date().toISOString()}`,
        `# Surface: ${surface}`,
      ],
    };
  }

  async extractResult(context: SubagentResultContext): Promise<HarnessResult | null> {
    const { completionResult, surface, readPane } = context;
    let summary = readPane(surface, 200)
      .replace(/__SUBAGENT_DONE_\d+__/, "")
      .trimEnd();

    if (!summary) {
      summary = completionResult.exitCode !== 0
        ? `Grok exited with code ${completionResult.exitCode}`
        : "Grok exited without output";
    }

    return { summary };
  }
}
