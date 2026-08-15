import type {
  HarnessDriver,
  SubagentLaunchContext,
  BuiltHarnessCommand,
  SubagentResultContext,
  HarnessResult,
} from "../types.ts";
import type { ResolvedRuntimePlan } from "../../runtime-routing.ts";

export class GenericHarnessDriver implements HarnessDriver {
  readonly id: string;
  readonly name: string;
  readonly hasActivitySnapshots = false;
  readonly supportsTurnInterrupt = false;

  constructor(cliId = "generic", displayName?: string) {
    this.id = cliId;
    this.name = displayName ?? cliId;
  }

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

    const template = agentDefs?.commandTemplate;
    let commandBody: string;

    if (template) {
      // Replace template variables
      commandBody = template
        .replace(/\{model\}/g, effectiveModel ? shellQuote(effectiveModel) : "")
        .replace(/\{task\}/g, shellQuote(fullTask))
        .replace(/\{prompt\}/g, shellQuote(fullTask))
        .replace(/\{cwd\}/g, effectiveCwd ? shellQuote(effectiveCwd) : ".")
        .replace(/\{name\}/g, shellQuote(params.name))
        .replace(/\{id\}/g, shellQuote(params.id));
    } else {
      const binary = this.id === "generic" ? (agentDefs?.cli ?? "subagent") : this.id;
      const cmdParts: string[] = [binary];

      if (effectiveModel) {
        cmdParts.push("--model", shellQuote(effectiveModel));
      }

      const sp = params.systemPrompt ?? agentDefs?.body;
      if (sp) {
        cmdParts.push("--system-prompt", shellQuote(sp));
      }

      cmdParts.push(shellQuote(fullTask));
      commandBody = cmdParts.join(" ");
    }

    const cdPrefix = effectiveCwd ? `cd ${shellQuote(effectiveCwd)} && ` : "";
    const command = `${cdPrefix}${commandBody}; echo '__SUBAGENT_DONE_'$?'__'`;

    return {
      command,
      cli: this.id,
      launchScriptPreamble: [
        `# ${this.name} subagent launch script for ${params.name}`,
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
        ? `${this.name} exited with code ${completionResult.exitCode}`
        : `${this.name} exited without output`;
    }

    return { summary };
  }
}
