import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getHarnessDriver,
  registerHarnessDriver,
  PiHarnessDriver,
  ClaudeHarnessDriver,
  OpenCodeHarnessDriver,
  CodexHarnessDriver,
  GrokHarnessDriver,
  GenericHarnessDriver,
  type SubagentLaunchContext,
} from "../pi-extension/subagents/harness/index.ts";
import type { ResolvedRuntimePlan } from "../pi-extension/subagents/runtime-routing.ts";

function createMockLaunchContext(overrides?: Partial<SubagentLaunchContext>): SubagentLaunchContext {
  const runtimePlan: ResolvedRuntimePlan = {
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
    model: "anthropic/claude-sonnet-4-5",
    thinking: "medium",
    modelSource: "request",
    thinkingSource: "request",
  };

  return {
    params: {
      id: "abc12345",
      name: "worker",
      task: "Analyze the repository structure",
    },
    runtimePlan,
    effectiveModel: "anthropic/claude-sonnet-4-5",
    effectiveThinking: "medium",
    parentThinking: "medium",
    surface: "pane-1",
    artifactDir: "/tmp/artifacts",
    sessionDir: "/tmp/sessions",
    subagentSessionFile: "/tmp/sessions/subagent.jsonl",
    effectiveCwd: "/tmp/project",
    effectiveAutoExit: true,
    effectiveInteractive: false,
    inheritsConversationContext: true,
    taskDelivery: "direct",
    subagentsDir: "/path/to/subagents",
    shellQuote: (s: string) => `'${s.replace(/'/g, "'\\''")}'`,
    ...overrides,
  };
}

describe("Harness Drivers Registry", () => {
  it("resolves default built-in drivers by id case-insensitively", () => {
    assert.equal(getHarnessDriver("pi").id, "pi");
    assert.equal(getHarnessDriver("PI").id, "pi");
    assert.equal(getHarnessDriver("claude").id, "claude");
    assert.equal(getHarnessDriver("CLAUDE").id, "claude");
    assert.equal(getHarnessDriver("opencode").id, "opencode");
    assert.equal(getHarnessDriver("OpenCode").id, "opencode");
    assert.equal(getHarnessDriver("codex").id, "codex");
    assert.equal(getHarnessDriver("CODEX").id, "codex");
    assert.equal(getHarnessDriver("grok").id, "grok");
    assert.equal(getHarnessDriver("GROK").id, "grok");
  });

  it("defaults to Pi harness when cli is undefined or empty", () => {
    assert.equal(getHarnessDriver(undefined).id, "pi");
    assert.equal(getHarnessDriver("").id, "pi");
    assert.equal(getHarnessDriver("   ").id, "pi");
  });

  it("returns a GenericHarnessDriver for unlisted CLI names", () => {
    const driver = getHarnessDriver("aider");
    assert.equal(driver.id, "aider");
    assert.equal(driver.name, "aider");
    assert.ok(driver instanceof GenericHarnessDriver);
  });

  it("allows registering custom harness drivers", () => {
    const customDriver = new GenericHarnessDriver("custom-agent", "Custom Agent Engine");
    registerHarnessDriver(customDriver);
    const resolved = getHarnessDriver("custom-agent");
    assert.equal(resolved.id, "custom-agent");
    assert.equal(resolved.name, "Custom Agent Engine");
  });
});

describe("Pi Harness Driver", () => {
  const driver = new PiHarnessDriver();

  it("formats model using full provider/model reference", () => {
    assert.equal(
      driver.formatModel({ provider: "anthropic", modelId: "claude-sonnet-4-5", model: "anthropic/claude-sonnet-4-5" }),
      "anthropic/claude-sonnet-4-5",
    );
  });

  it("supports turn interrupts and live activity snapshots", () => {
    assert.equal(driver.supportsTurnInterrupt, true);
    assert.equal(driver.hasActivitySnapshots, true);
  });

  it("builds correct pi invocation command", () => {
    const ctx = createMockLaunchContext({
      effectiveModel: "anthropic/claude-sonnet-4-5",
      effectiveThinking: "high",
    });
    const built = driver.buildCommand(ctx);

    assert.equal(built.cli, "pi");
    assert.ok(built.command.includes("pi --session '/tmp/sessions/subagent.jsonl'"));
    assert.ok(built.command.includes("--model 'anthropic/claude-sonnet-4-5'"));
    assert.ok(built.command.includes("--thinking 'high'"));
    assert.ok(built.command.includes("echo '__SUBAGENT_DONE_'$?'__'"));
  });
});

describe("OpenCode Harness Driver", () => {
  const driver = new OpenCodeHarnessDriver();

  it("formats model using provider-qualified model reference", () => {
    assert.equal(
      driver.formatModel({ provider: "anthropic", modelId: "claude-3-5-sonnet", model: "anthropic/claude-3-5-sonnet" }),
      "anthropic/claude-3-5-sonnet",
    );
  });

  it("builds correct opencode run command", () => {
    const ctx = createMockLaunchContext({
      effectiveModel: "anthropic/claude-3-5-sonnet",
    });
    const built = driver.buildCommand(ctx);

    assert.equal(built.cli, "opencode");
    assert.ok(built.command.startsWith("cd '/tmp/project' && opencode run --model 'anthropic/claude-3-5-sonnet'"));
    assert.ok(built.command.includes("echo '__SUBAGENT_DONE_'$?'__'"));
  });

  it("extracts output from terminal pane buffer", async () => {
    const result = await driver.extractResult({
      running: {
        id: "1",
        name: "test",
        task: "task",
        surface: "s1",
        startTime: Date.now(),
        sessionFile: "f",
        interactive: false,
      },
      completionResult: { reason: "done", exitCode: 0 },
      surface: "s1",
      readPane: () => "Finished repository inspection!\n__SUBAGENT_DONE_0__\n",
      closePane: () => {},
      artifactDir: "/tmp",
    });

    assert.ok(result);
    assert.equal(result.summary, "Finished repository inspection!");
  });
});

describe("Codex Harness Driver", () => {
  const driver = new CodexHarnessDriver();

  it("formats model using bare modelId", () => {
    assert.equal(
      driver.formatModel({ provider: "openai", modelId: "o3-mini", model: "openai/o3-mini" }),
      "o3-mini",
    );
  });

  it("builds codex command with reasoning effort when supported", () => {
    const ctx = createMockLaunchContext({
      effectiveModel: "o3-mini",
      effectiveThinking: "high",
    });
    const built = driver.buildCommand(ctx);

    assert.equal(built.cli, "codex");
    assert.ok(built.command.startsWith("cd '/tmp/project' && codex --model 'o3-mini' --reasoning-effort 'high'"));
    assert.ok(built.command.includes("echo '__SUBAGENT_DONE_'$?'__'"));
  });
});

describe("Grok Harness Driver", () => {
  const driver = new GrokHarnessDriver();

  it("formats model using bare modelId", () => {
    assert.equal(
      driver.formatModel({ provider: "xai", modelId: "grok-3", model: "xai/grok-3" }),
      "grok-3",
    );
  });

  it("builds grok execution command", () => {
    const ctx = createMockLaunchContext({
      effectiveModel: "grok-3",
    });
    const built = driver.buildCommand(ctx);

    assert.equal(built.cli, "grok");
    assert.ok(built.command.startsWith("cd '/tmp/project' && grok --model 'grok-3'"));
    assert.ok(built.command.includes("echo '__SUBAGENT_DONE_'$?'__'"));
  });
});

describe("Claude Harness Driver", () => {
  const driver = new ClaudeHarnessDriver();

  it("formats model using bare modelId / alias", () => {
    assert.equal(
      driver.formatModel({ provider: "anthropic", modelId: "opus", model: "anthropic/opus" }),
      "opus",
    );
  });

  it("rejects thinking-level overrides for Claude CLI subagents", () => {
    assert.throws(
      () => driver.validateRuntimePlan({
        provider: "anthropic",
        modelId: "sonnet",
        model: "anthropic/sonnet",
        thinking: "high",
        modelSource: "request",
        thinkingSource: "request",
      }, "medium"),
      /Thinking-level overrides are not supported for Claude CLI subagents/,
    );
  });

  it("allows inherited parent thinking for Claude CLI subagents", () => {
    assert.doesNotThrow(() => driver.validateRuntimePlan({
      provider: "anthropic",
      modelId: "sonnet",
      model: "anthropic/sonnet",
      thinking: "medium",
      modelSource: "request",
      thinkingSource: "parent",
    }, "medium"));
  });
});

describe("Generic Harness Driver & Templates", () => {
  it("interpolates commandTemplate variables", () => {
    const driver = new GenericHarnessDriver("custom");
    const ctx = createMockLaunchContext({
      effectiveModel: "gemini-2.5-pro",
      effectiveCwd: "/workspace/my-app",
      agentDefs: {
        name: "custom",
        commandTemplate: "gemini run --model {model} --prompt {task} --dir {cwd}",
      },
    });

    const built = driver.buildCommand(ctx);
    assert.ok(built.command.includes("gemini run --model 'gemini-2.5-pro' --prompt 'Analyze the repository structure' --dir '/workspace/my-app'"));
    assert.ok(built.command.includes("echo '__SUBAGENT_DONE_'$?'__'"));
  });

  it("falls back to bare binary execution when no commandTemplate is provided", () => {
    const driver = new GenericHarnessDriver("aider");
    const ctx = createMockLaunchContext({
      effectiveModel: "gpt-4o",
    });

    const built = driver.buildCommand(ctx);
    assert.ok(built.command.startsWith("cd '/tmp/project' && aider --model 'gpt-4o'"));
  });
});
