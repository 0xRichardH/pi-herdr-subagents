import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import { DEFAULT_ACTIVE_TOOL_STALL_MS, parseActiveToolStallMs } from "../pi-extension/subagents/recovery.ts";
import {
  createLifecycle,
  lifecycleTransition,
  observeActivity,
  observePaneInspection,
  projectLifecycle,
} from "../pi-extension/subagents/lifecycle.ts";

const delays = [30_000, 60_000, 90_000] as const;

function makeRunning(overrides: Record<string, unknown> = {}) {
  return {
    id: "child-1",
    name: "Worker",
    task: "Run the hung tool",
    surface: "pane-1",
    startTime: 0,
    sessionFile: "/tmp/worker.jsonl",
    interactive: false,
    lifecycle: createLifecycle(0),
    ...overrides,
  };
}

function toolActivity(observedAt: number, sequence = 1) {
  return {
    ok: true as const,
    activity: {
      version: 1 as const,
      runningChildId: "child-1",
      createdAt: 0,
      updatedAt: observedAt,
      sequence,
      latestEvent: "tool_execution_start" as const,
      phase: "active" as const,
      agentActive: true,
      turnActive: true,
      providerActive: false,
      toolActive: true,
      activeScope: "tool" as const,
      activeSince: observedAt,
      toolName: "bash",
      toolStartedAt: observedAt,
    },
  };
}

function scopeActivity(scope: "provider" | "streaming" | "agent", observedAt: number) {
  return {
    ok: true as const,
    activity: {
      version: 1 as const,
      runningChildId: "child-1",
      createdAt: 0,
      updatedAt: observedAt,
      sequence: 1,
      latestEvent: "agent_start" as const,
      phase: "active" as const,
      agentActive: true,
      turnActive: true,
      providerActive: scope === "provider",
      toolActive: false,
      activeScope: scope,
      activeSince: observedAt,
    },
  };
}

/** Lifecycle whose turn is active on a tool-scope detail observed at `observedAt`. */
function activeToolLifecycle(observedAt: number, sequence = 1) {
  let lifecycle = createLifecycle(0);
  lifecycle = observePaneInspection(lifecycle, {
    kind: "present",
    observedAt,
    agentStatus: "working",
  }, observedAt);
  return observeActivity(lifecycle, toolActivity(observedAt, sequence), observedAt);
}

describe("active tool stall parsing", () => {
  it("defaults for missing/malformed values, honors non-negative ints, and treats 0 as disabled", () => {
    for (const [raw, expected] of [
      [undefined, DEFAULT_ACTIVE_TOOL_STALL_MS],
      ["", DEFAULT_ACTIVE_TOOL_STALL_MS],
      ["   ", DEFAULT_ACTIVE_TOOL_STALL_MS],
      ["wat", DEFAULT_ACTIVE_TOOL_STALL_MS],
      ["-1", DEFAULT_ACTIVE_TOOL_STALL_MS],
      ["1.5", DEFAULT_ACTIVE_TOOL_STALL_MS],
      ["0", 0],
      [" 120000 ", 120_000],
      ["123456", 123_456],
    ] as const) {
      assert.equal(parseActiveToolStallMs(raw), expected, String(raw));
    }
  });
});

describe("stale tool-scope projection", () => {
  it("projects stalled once tool silence reaches the window, with duration equal to silence", () => {
    const stall = 600_000;
    const lifecycle = activeToolLifecycle(1000);
    const fresh = projectLifecycle(lifecycle, 1000 + stall - 1);
    assert.equal(fresh.kind, "active");
    assert.equal(fresh.label, "bash");

    const stale = projectLifecycle(lifecycle, 1000 + stall);
    assert.deepEqual(stale, { kind: "stalled", stateDurationSince: 1000 });
  });

  it("omitted opts defaults to the enabled 600000ms window", () => {
    const lifecycle = activeToolLifecycle(0);
    assert.equal(projectLifecycle(lifecycle, 599_999).kind, "active");
    assert.equal(projectLifecycle(lifecycle, 600_000).kind, "stalled");
  });

  it("threshold 0 disables stale-stalling entirely", () => {
    const lifecycle = activeToolLifecycle(0);
    const projection = projectLifecycle(lifecycle, Number.MAX_SAFE_INTEGER / 2, { activeToolStallMs: 0 });
    assert.equal(projection.kind, "active");
  });

  it("provider, streaming, and agent scopes never stale-stall regardless of age", () => {
    for (const scope of ["provider", "streaming", "agent"] as const) {
      let lifecycle = createLifecycle(0);
      lifecycle = observePaneInspection(lifecycle, {
        kind: "present",
        observedAt: 0,
        agentStatus: "working",
      }, 0);
      lifecycle = observeActivity(lifecycle, scopeActivity(scope, 0), 0);
      const projection = projectLifecycle(lifecycle, DEFAULT_ACTIVE_TOOL_STALL_MS * 10);
      assert.equal(projection.kind, "active", scope);
    }
  });

  it("fresh tool activity after a stalled projection emits a recovered transition", () => {
    let lifecycle = activeToolLifecycle(0);
    assert.equal(projectLifecycle(lifecycle, 600_000).kind, "stalled");

    lifecycle = observeActivity(lifecycle, toolActivity(600_500, 2), 600_500);
    const next = projectLifecycle(lifecycle, 600_501);
    assert.equal(next.kind, "active");
    assert.equal(lifecycleTransition("stalled", next.kind), "recovered");
  });
});

describe("stale tool child drives the recovery ladder", () => {
  it("nudges after delays[0] and kills after delays[2] using fake-clock ticks", () => {
    const testApi = (subagentsModule as any).__test__;
    const running = makeRunning();
    let nudges = 0;
    let closes = 0;
    let aborts = 0;
    const operations = {
      interruptPane() {
        nudges += 1;
      },
      closePane() {
        closes += 1;
      },
      abortWatcher() {
        aborts += 1;
      },
    };

    // Child enters a bash call at t=1000 and the activity file goes silent.
    running.lifecycle = activeToolLifecycle(1000);
    const tick = (now: number) => {
      const projection = projectLifecycle(running.lifecycle, now);
      return testApi.advanceRunningRecovery(running, projection, now, delays, operations);
    };

    assert.equal(tick(1000).action, null, "fresh tool activity must not arm the ladder");
    assert.equal(running.recovery, undefined);

    const stalledAt = 1000 + 600_000;
    assert.equal(tick(stalledAt).state?.stage, "waiting", "silence past the window arms the ladder");
    assert.equal(tick(stalledAt + 30_000 - 1).action, null, "below delays[0] must not nudge");
    assert.equal(tick(stalledAt + delays[0]).action, "nudge");
    assert.equal(tick(stalledAt + delays[0] + delays[1]).action, "escalate");
    assert.equal(tick(stalledAt + delays[0] + delays[1] + delays[2] - 1).action, null);
    const killTick = tick(stalledAt + delays[0] + delays[1] + delays[2]);
    assert.equal(killTick.action, "kill");
    assert.equal(nudges, 1);
    assert.equal(closes, 1);
    assert.equal(aborts, 1);
    assert.match(running.lifecycle.process.error, /recovery-kill after 781s/);
  });
});
