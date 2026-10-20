import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  Type,
} from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import extension from "../pi-extension/subagents/index.ts";

export async function captureGuidanceRequests(options: {
  denied?: boolean;
  inactive?: boolean;
  hidden?: boolean;
  scoped?: boolean;
  contributions?: boolean;
  requests?: number;
  reloadBetweenRequests?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-guidance-"));
  const agentDir = join(dir, "agent");
  const previousCwd = process.cwd();
  const envNames = ["PI_CODING_AGENT_DIR", "PI_SUBAGENT_ID", "PI_DENY_TOOLS"];
  const previousEnv = envNames.map((name) => process.env[name]);
  let session: AgentSession | undefined;
  const requests: Array<{ prompt: string; tools: string[] }> = [];
  const errors: unknown[] = [];
  try {
    process.chdir(dir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_SUBAGENT_ID;
    delete process.env.PI_DENY_TOOLS;
    if (options.denied) {
      process.env.PI_SUBAGENT_ID = "guidance-test-child";
      process.env.PI_DENY_TOOLS = "subagent";
    }
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    writeFileSync(join(agentDir, "agents", "researcher.md"),
      "---\nname: researcher\ndescription: Researches external topics using authoritative sources\nmodel: guidance-test/research\nthinking: high\n---\nResearch the task.\n");
    writeFileSync(join(agentDir, "agents", "private.md"),
      "---\nname: private-agent\ndescription: PRIVATE_AGENT_DESCRIPTION\ndisable-model-invocation: true\n---\nPrivate task.\n");
    const settingsManager = SettingsManager.inMemory({});
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir,
      agentDir,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) => {
          pi.registerProvider("guidance-test", {
            baseUrl: "https://example.invalid",
            apiKey: "deterministic-test-key",
            api: "guidance-test-api",
            models: ["fast", "research"].map((id) => ({
              id, name: id, reasoning: false, input: ["text" as const],
              contextWindow: 128_000, maxTokens: 1000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            })),
            streamSimple(model, context) {
              requests.push({
                prompt: getCurrentSystemPrompt(context.messages),
                tools: getCurrentTools(context.messages).map((tool) => tool.name),
              });
              const stream = createAssistantMessageEventStream();
              const message: AssistantMessage = {
                role: "assistant", provider: model.provider, model: model.id, api: model.api,
                content: [{ type: "text", text: "ok" }], stopReason: "stop", timestamp: Date.now(),
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              };
              stream.push({ type: "start", partial: message });
              stream.push({ type: "done", reason: "stop", message });
              stream.end();
              return stream;
            },
          });
          if (options.contributions) {
            pi.on("before_agent_start", (event) => {
              (event.systemPromptOptions.toolGuidelines.subagent ??= []).push("EARLIER_SUBAGENT_GUIDELINE");
              event.systemPromptOptions.promptGuidelines.push("OTHER_GLOBAL_GUIDELINE");
            });
          }
        },
        extension,
        (pi) => {
          if (options.hidden) {
            pi.registerTool({
              name: "guidance-wrapper", label: "Wrapper", description: "Test loadout wrapper",
              parameters: Type.Object({}),
              prepareLoadout: () => ({ hiddenDeclarations: ["subagent"] }),
              execute: async () => ({ content: [], details: undefined }),
            });
          }
          if (options.contributions) {
            pi.on("before_agent_start", (event) => {
              (event.systemPromptOptions.toolGuidelines.subagent ??= []).push("LATER_SUBAGENT_GUIDELINE");
            });
          }
        },
      ],
    });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({
      cwd: dir, agentDir, resourceLoader, settingsManager,
      sessionManager: SessionManager.inMemory(),
      ...(options.inactive ? { excludeTools: ["subagent"] } : {}),
    }));
    const model = session.extensionRunner!.getModelRegistry().find("guidance-test", "fast");
    assert.ok(model);
    await session.setModel(model);
    session.setScopedModels(options.scoped ? [{ model, thinkingLevel: "off" }] : []);
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    for (let index = 0; index < (options.requests ?? 1); index++) {
      if (index > 0 && options.reloadBetweenRequests) {
        writeFileSync(join(agentDir, "agents", "researcher.md"),
          "---\nname: researcher\ndescription: REFRESHED_RESEARCHER_DESCRIPTION\n---\nResearch the task.\n");
        await session.reload();
      }
      await session.prompt(`Request ${index + 1}`);
    }
    assert.deepEqual(errors, [], "extension handlers must not fail silently");
    assert.equal(requests.length, options.requests ?? 1, "the provider must receive every request");
    return requests;
  } finally {
    session?.dispose();
    process.chdir(previousCwd);
    envNames.forEach((name, index) => {
      if (previousEnv[index] === undefined) delete process.env[name];
      else process.env[name] = previousEnv[index];
    });
    rmSync(dir, { recursive: true, force: true });
  }
}
