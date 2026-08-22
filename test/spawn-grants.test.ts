import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiHarnessDriver } from "../pi-extension/subagents/harness/index.ts";
import type { SubagentLaunchContext } from "../pi-extension/subagents/harness/types.ts";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

const testApi = (subagentsModule as any).__test__;
const SPAWNING_TOOLS = [...testApi.SPAWNING_TOOLS as Set<string>].sort();

function createMockLaunchContext(overrides?: Partial<SubagentLaunchContext>): SubagentLaunchContext {
  return {
    params: {
      id: "abc12345",
      name: "worker",
      task: "Analyze the repository structure",
    },
    runtimePlan: {
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      model: "anthropic/claude-sonnet-4-5",
      thinking: "medium",
      modelSource: "request",
      thinkingSource: "request",
    },
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

describe("resolveDenyTools — deny-by-default spawn grants", () => {
  it("denies all spawning tools by default (no agent defs, bare spawn)", () => {
    const denied = testApi.resolveDenyTools(null);
    for (const tool of SPAWNING_TOOLS) assert.equal(denied.has(tool), true, `expected ${tool} denied`);
  });

  it("denies all spawning tools when frontmatter omits `spawning`", () => {
    const denied = testApi.resolveDenyTools({ name: "worker" });
    for (const tool of SPAWNING_TOOLS) assert.equal(denied.has(tool), true);
  });

  it("denies all spawning tools when frontmatter sets spawning:false", () => {
    const denied = testApi.resolveDenyTools({ spawning: false });
    for (const tool of SPAWNING_TOOLS) assert.equal(denied.has(tool), true);
  });

  it("grants spawning tools only with explicit spawning:true and remaining depth", () => {
    const granted = testApi.resolveDenyTools({ spawning: true }, null);
    for (const tool of SPAWNING_TOOLS) assert.equal(granted.has(tool), false);
    assert.equal(testApi.resolveDenyTools({ spawning: true }, 3).size, 0);
  });

  it("remaining 0 denies spawning despite a frontmatter grant", () => {
    const denied = testApi.resolveDenyTools({ spawning: true }, 0);
    for (const tool of SPAWNING_TOOLS) assert.equal(denied.has(tool), true);
  });

  it("deny-tools additions stack on top of grants and denials", () => {
    // Granted agent with extra denials
    const grantedWithExtra = testApi.resolveDenyTools(
      { spawning: true, denyTools: "bash, read" },
      null,
    );
    assert.deepEqual([...grantedWithExtra].sort(), ["bash", "read"]);

    // Denied-by-default agent stacking an unrelated denial
    const deniedWithExtra = testApi.resolveDenyTools({ denyTools: "write" });
    for (const tool of SPAWNING_TOOLS) assert.equal(deniedWithExtra.has(tool), true);
    assert.equal(deniedWithExtra.has("write"), true);

    // Redundant listing of a spawning tool changes nothing
    assert.equal(testApi.resolveDenyTools({ spawning: true, denyTools: "subagent" }, 2).has("subagent"), true);

    // Empty / junk entries are ignored
    assert.equal(testApi.resolveDenyTools({ spawning: true, denyTools: " , ," }, 1).size, 0);
  });
});

describe("spawn depth math", () => {
  it("parseSpawnDepth reads PI_SUBAGENT_SPAWN_DEPTH conservatively", () => {
    assert.equal(testApi.parseSpawnDepth(undefined), null); // unset → unlimited (grant still required)
    assert.equal(testApi.parseSpawnDepth(""), null);
    assert.equal(testApi.parseSpawnDepth("  "), null);
    assert.equal(testApi.parseSpawnDepth("junk"), null);
    assert.equal(testApi.parseSpawnDepth("-1"), null);
    assert.equal(testApi.parseSpawnDepth("0"), 0);
    assert.equal(testApi.parseSpawnDepth("7"), 7);
    assert.equal(testApi.parseSpawnDepth(" 3 "), 3);
  });

  it("decrementSpawnDepth never rises and clamps at zero", () => {
    assert.equal(testApi.decrementSpawnDepth(null), null); // unlimited stays unlimited
    assert.equal(testApi.decrementSpawnDepth(5), 4);
    assert.equal(testApi.decrementSpawnDepth(1), 0);
    assert.equal(testApi.decrementSpawnDepth(0), 0);
  });
});

describe("Pi harness driver emits depth + deny env", () => {
  const driver = new PiHarnessDriver();

  it("emits PI_DENY_TOOLS including spawning tools and PI_SUBAGENT_SPAWN_DEPTH=<remaining>", () => {
    const denySet = new Set<string>(SPAWNING_TOOLS);
    const built = driver.buildCommand(createMockLaunchContext({ denySet, childSpawnDepth: 2 }));

    assert.match(built.command, /PI_DENY_TOOLS='[^']*subagent[^']*'/);
    for (const tool of SPAWNING_TOOLS) {
      assert.ok(built.command.includes(`'${tool}'`) || built.command.includes(tool),
        `expected ${tool} in PI_DENY_TOOLS`);
    }
    assert.ok(built.command.includes("PI_SUBAGENT_SPAWN_DEPTH=2"));
  });

  it("emits PI_SUBAGENT_SPAWN_DEPTH=0 at exhaustion (explicit, not absent)", () => {
    const built = driver.buildCommand(createMockLaunchContext({ childSpawnDepth: 0 }));
    assert.ok(built.command.includes("PI_SUBAGENT_SPAWN_DEPTH=0"));
  });

  it("omits PI_SUBAGENT_SPAWN_DEPTH when unlimited (no ceiling configured)", () => {
    const built = driver.buildCommand(createMockLaunchContext({ childSpawnDepth: null }));
    assert.equal(built.command.includes("PI_SUBAGENT_SPAWN_DEPTH="), false);

    const legacyBuilt = driver.buildCommand(createMockLaunchContext());
    assert.equal(legacyBuilt.command.includes("PI_SUBAGENT_SPAWN_DEPTH="), false);
  });
});

describe("resume clamp — first-launch metadata wins", () => {
  it("missing/corrupt metadata resolves to 0 (deny)", () => {
    assert.deepEqual(testApi.clampResumeSpawn(undefined, 9), { maySpawn: false, childEnvDepth: 0 });
    assert.deepEqual(testApi.clampResumeSpawn(null, 9), { maySpawn: false, childEnvDepth: 0 });
    assert.deepEqual(testApi.clampResumeSpawn({}, 9), { maySpawn: false, childEnvDepth: 0 });
    assert.deepEqual(testApi.clampResumeSpawn({ allowance: "3" }, 9), { maySpawn: false, childEnvDepth: 0 });
    assert.deepEqual(testApi.clampResumeSpawn({ allowance: -2 }, 9), { maySpawn: false, childEnvDepth: 0 });
  });

  it("clamps to min(recorded allowance, requested)", () => {
    // recorded 3, environment would allow 5 → 3, child gets 2
    assert.deepEqual(testApi.clampResumeSpawn({ allowance: 3 }, 5), { maySpawn: true, childEnvDepth: 2 });
    // recorded 3, environment allows 1 → 1, child gets 0
    assert.deepEqual(testApi.clampResumeSpawn({ allowance: 3 }, 1), { maySpawn: true, childEnvDepth: 0 });
    // recorded 3, no ceiling in environment → recorded 3 stands
    assert.deepEqual(testApi.clampResumeSpawn({ allowance: 3 }, null), { maySpawn: true, childEnvDepth: 2 });
    // exhausted at first launch → resume cannot revive
    assert.deepEqual(testApi.clampResumeSpawn({ allowance: 0 }, 9), { maySpawn: false, childEnvDepth: 0 });
  });

  it("recorded unlimited stays bounded by the requesting environment only", () => {
    assert.deepEqual(testApi.clampResumeSpawn({ allowance: null }, 4), { maySpawn: true, childEnvDepth: 3 });
    assert.deepEqual(testApi.clampResumeSpawn({ allowance: null }, null), { maySpawn: true, childEnvDepth: null });
  });

  it("readSpawnMetadata returns null on missing or corrupt sidecar files", () => {
    const dir = mkdtempSync(join(tmpdir(), "spawn-grants-test-"));
    try {
      assert.equal(testApi.readSpawnMetadata(join(dir, "missing.jsonl")), null);

      const sessionFile = join(dir, "session.jsonl");
      writeFileSync(`${sessionFile}.spawn.json`, JSON.stringify({ allowance: 4 }), "utf8");
      assert.deepEqual(testApi.readSpawnMetadata(sessionFile), { allowance: 4 });

      writeFileSync(`${sessionFile}.spawn.json`, "{not json", "utf8");
      assert.equal(testApi.readSpawnMetadata(sessionFile), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("termination regression", () => {
  it("A-spawns-B-spawns-A terminates: depth decrements every generation until denial", () => {
    const grantedDefs = { spawning: true };
    let allowance: number | null = 3;
    let spawnerIsA = true;
    let spawns = 0;

    while (true) {
      const denied = testApi.resolveDenyTools(grantedDefs, allowance);
      if (denied.has("subagent")) break;
      allowance = testApi.decrementSpawnDepth(allowance);
      spawns++;
      spawnerIsA = !spawnerIsA;
      assert.ok(spawns <= 10, "mutual spawning must terminate");
    }

    // ceiling 3 → A, B, A each spawn once; B's fourth attempt is denied
    assert.equal(spawns, 3);
    assert.equal(spawnerIsA, false);
  });

  it("keeps the same-agent respawn guard working regardless of depth", () => {
    assert.equal(testApi.blockedSelfSpawn("planner", "planner"), true);
    assert.equal(testApi.blockedSelfSpawn("planner", "scout"), false);
    assert.equal(testApi.blockedSelfSpawn(undefined, "scout"), false);
    assert.equal(testApi.blockedSelfSpawn("scout", undefined), false);
  });
});
