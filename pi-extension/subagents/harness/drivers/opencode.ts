import type {
  HarnessDriver,
  SubagentLaunchContext,
  BuiltHarnessCommand,
  SubagentResultContext,
  HarnessResult,
} from "../types.ts";
import type { ResolvedRuntimePlan } from "../../runtime-routing.ts";

export class OpenCodeHarnessDriver implements HarnessDriver {
  readonly id = "opencode";
  readonly name = "OpenCode";
  readonly hasActivitySnapshots = false;
  readonly supportsTurnInterrupt = false;

  formatModel(runtimePlan: Pick<ResolvedRuntimePlan, "model" | "modelId" | "provider">): string {
    return runtimePlan.model;
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

    const cmdParts: string[] = ["opencode", "run"];

    if (effectiveModel) {
      cmdParts.push("--model", shellQuote(effectiveModel));
    }

    const sp = params.systemPrompt ?? agentDefs?.body;
    if (sp) {
      cmdParts.push("--system-prompt", shellQuote(sp));
    }

    if (params.resumeSessionId) {
      cmdParts.push("--session", shellQuote(params.resumeSessionId));
    }

    cmdParts.push(shellQuote(fullTask));

    const cdPrefix = effectiveCwd ? `cd ${shellQuote(effectiveCwd)} && ` : "";
    const command = `${cdPrefix}${cmdParts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;

    return {
      command,
      cli: "opencode",
      launchScriptPreamble: [
        `# OpenCode subagent launch script for ${params.name}`,
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
        ? `OpenCode exited with code ${completionResult.exitCode}`
        : "OpenCode exited without output";
    }

    return { summary };
  }
}
