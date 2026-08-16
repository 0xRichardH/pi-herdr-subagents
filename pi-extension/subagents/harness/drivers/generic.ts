import type {
  HarnessDriver,
  SubagentLaunchContext,
  BuiltHarnessCommand,
  SubagentResultContext,
  HarnessResult,
} from "../types.ts";
import type { ResolvedRuntimePlan } from "../../runtime-routing.ts";
import { extractPaneSummary } from "../pane-summary.ts";

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
      // Replace template variables. Replacement values are passed via a
      // replacer function (not a string) so that "$$", "$&", etc. in
      // untrusted task/model/cwd text are inserted literally instead of
      // being interpreted as String.replace() special patterns.
      const quotedModel = effectiveModel ? shellQuote(effectiveModel) : "";
      const quotedTask = shellQuote(fullTask);
      const quotedCwd = effectiveCwd ? shellQuote(effectiveCwd) : ".";
      const quotedName = shellQuote(params.name);
      const quotedId = shellQuote(params.id);
      commandBody = template
        .replace(/\{model\}/g, () => quotedModel)
        .replace(/\{task\}/g, () => quotedTask)
        .replace(/\{prompt\}/g, () => quotedTask)
        .replace(/\{cwd\}/g, () => quotedCwd)
        .replace(/\{name\}/g, () => quotedName)
        .replace(/\{id\}/g, () => quotedId);
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
    return { summary: extractPaneSummary(context, this.name) };
  }
}
