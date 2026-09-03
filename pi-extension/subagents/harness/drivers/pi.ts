import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  HarnessDriver,
  SubagentLaunchContext,
  BuiltHarnessCommand,
} from "../types.ts";
import type { ResolvedRuntimePlan } from "../../runtime-routing.ts";
import { getSubagentActivityFile } from "../../activity.ts";

const SUBAGENT_CONTROL_TOOLS = ["caller_ping", "subagent_done"] as const;

export function buildSubagentToolAllowlist(effectiveTools?: string): string | null {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  if (requested.length === 0) return null;

  const allow = new Set(requested);
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }

  return [...allow].join(",");
}

export function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [
    ...(needsSeparator ? [""] : []),
    ...skillPrompts,
    params.taskArg,
  ];
}

export class PiHarnessDriver implements HarnessDriver {
  readonly id = "pi";
  readonly name = "Pi";
  readonly hasActivitySnapshots = true;
  readonly supportsTurnInterrupt = true;

  formatModel(runtimePlan: Pick<ResolvedRuntimePlan, "model" | "modelId" | "provider">): string {
    return runtimePlan.model;
  }

  buildCommand(context: SubagentLaunchContext): BuiltHarnessCommand {
    const {
      params,
      agentDefs,
      runtimePlan,
      effectiveModel,
      effectiveThinking,
      surface,
      artifactDir,
      subagentSessionFile,
      effectiveCwd,
      localAgentDir,
      effectiveAutoExit,
      taskDelivery,
      denySet,
      childSpawnDepth,
      identity,
      identityInSystemPrompt,
      systemPromptMode,
      roleBlock,
      modeHint,
      summaryInstruction,
      subagentsDir,
      shellQuote,
    } = context;

    const parts: string[] = ["pi"];
    parts.push("--session", shellQuote(subagentSessionFile));

    const subagentDonePath = join(subagentsDir, "subagent-done.ts");
    parts.push("-e", shellQuote(subagentDonePath));

    if (effectiveModel) {
      parts.push("--model", shellQuote(effectiveModel));
    }
    if (effectiveThinking) {
      parts.push("--thinking", shellQuote(effectiveThinking));
    }

    if (identityInSystemPrompt && identity) {
      const flag = systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
      const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const spSafeName = params.name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      const syspromptPath = join(artifactDir, `context/${spSafeName || "subagent"}-sysprompt-${spTimestamp}-${params.id}.md`);
      mkdirSync(dirname(syspromptPath), { recursive: true });
      writeFileSync(syspromptPath, identity, "utf8");
      parts.push(flag, shellQuote(syspromptPath));
    }

    const effectiveTools = params.tools ?? agentDefs?.tools;
    const toolAllowlist = buildSubagentToolAllowlist(effectiveTools);
    if (toolAllowlist) {
      parts.push("--tools", shellQuote(toolAllowlist));
    }

    const envParts: string[] = [];
    if (localAgentDir && existsSync(localAgentDir)) {
      envParts.push(`PI_CODING_AGENT_DIR=${shellQuote(localAgentDir)}`);
    } else if (process.env.PI_CODING_AGENT_DIR) {
      envParts.push(`PI_CODING_AGENT_DIR=${shellQuote(process.env.PI_CODING_AGENT_DIR)}`);
    }

    if (denySet && denySet.size > 0) {
      envParts.push(`PI_DENY_TOOLS=${shellQuote([...denySet].join(","))}`);
    }
    if (childSpawnDepth != null) {
      envParts.push(`PI_SUBAGENT_SPAWN_DEPTH=${childSpawnDepth}`);
    }
    envParts.push(`PI_SUBAGENT_NAME=${shellQuote(params.name)}`);
    if (params.agent) {
      envParts.push(`PI_SUBAGENT_AGENT=${shellQuote(params.agent)}`);
    }
    if (effectiveAutoExit) {
      envParts.push("PI_SUBAGENT_AUTO_EXIT=1");
    }
    envParts.push(`PI_SUBAGENT_SESSION=${shellQuote(subagentSessionFile)}`);
    envParts.push(`PI_SUBAGENT_ID=${shellQuote(params.id)}`);
    const activityFile = getSubagentActivityFile(artifactDir, params.id);
    envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellQuote(activityFile)}`);
    envParts.push(`PI_SUBAGENT_SURFACE=${shellQuote(surface)}`);

    const fullTask = taskDelivery === "direct"
      ? params.task
      : `${roleBlock ?? ""}\n\n${modeHint ?? ""}\n\n${params.task}\n\n${summaryInstruction ?? ""}`;

    let taskArg: string;
    if (taskDelivery === "direct") {
      taskArg = fullTask;
    } else {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const safeName = params.name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      const artifactName = `context/${safeName || "subagent"}-${timestamp}-${params.id}.md`;
      const artifactPath = join(artifactDir, artifactName);
      mkdirSync(dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, fullTask, "utf8");
      taskArg = `@${artifactPath}`;
    }

    const effectiveSkills = params.skills ?? agentDefs?.skills;
    const promptArgs = buildPiPromptArgs({
      effectiveSkills,
      taskDelivery,
      taskArg,
    });
    for (const promptArg of promptArgs) {
      parts.push(shellQuote(promptArg));
    }

    const envPrefix = envParts.length > 0 ? `${envParts.join(" ")} ` : "";
    const cdPrefix = effectiveCwd ? `cd ${shellQuote(effectiveCwd)} && ` : "";
    const command = `${cdPrefix}${envPrefix}${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;

    return {
      command,
      sessionFile: subagentSessionFile,
      cli: "pi",
      launchScriptPreamble: [
        `# Subagent launch script for ${params.name}`,
        `# Generated: ${new Date().toISOString()}`,
        `# Session: ${subagentSessionFile}`,
        `# Surface: ${surface}`,
        `# Runtime: ${runtimePlan.model} (thinking: ${runtimePlan.thinking})`,
      ],
    };
  }
}
