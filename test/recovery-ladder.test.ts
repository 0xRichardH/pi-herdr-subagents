import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import {
  DEFAULT_RECOVERY_DELAYS,
  advanceRecoveryLadder,
  parseRecoveryDelays,
  type RecoveryState,
} from "../pi-extension/subagents/recovery.ts";
import {
  createLifecycle,
  observeActivity,
  observePaneInspection,
  projectLifecycle,
} from "../pi-extension/subagents/lifecycle.ts";

const delays = [30_000, 60_000, 90_000] as const;

function makeRunning(overrides: Record<string, unknown> = {}) {
  return {
    id: "child-1",
    name: "Worker",
    task: "Recover the provider failure",
    surface: "pane-1",
    startTime: 0,
    sessionFile: "/tmp/worker.jsonl",
    interactive: false,
    lifecycle: createLifecycle(0),
    ...overrides,
  };
}

describe("recovery delay parsing", () => {
  it("uses defaults for missing or malformed values and clamps short stages", () => {
    for (const [raw, expected] of [
      [undefined, DEFAULT_RECOVERY_DELAYS],
      ["", DEFAULT_RECOVERY_DELAYS],
      ["30000,60000", DEFAULT_RECOVERY_DELAYS],
      ["30000,wat,90000", DEFAULT_RECOVERY_DELAYS],
      ["30000,60000,90000,120000", DEFAULT_RECOVERY_DELAYS],
      ["30000,60000,90000.5", DEFAULT_RECOVERY_DELAYS],
      [" 12000, 22000, 32000 ", [12_000, 22_000, 32_000]],
      ["1,9999,-2", [10_000, 10_000, 10_000]],
    ] as const) {
      assert.deepEqual(parseRecoveryDelays(raw), expected, String(raw));
    }
  });
});

describe("recovery ladder", () => {
  it("advances wait, nudge, escalation, and kill from injected fake-clock ticks", () => {
    let now = 0;
    let state: RecoveryState | undefined;
    const tick = (nextNow: number, stalled = true, exempt = false) => {
      now = nextNow;
      const advance = advanceRecoveryLadder(state, { now, stalled, exempt, delays });
      state = advance.state;
      return advance;
    };

    assert.deepEqual(tick(0), { state: { stage: "waiting", stageSince: 0 }, action: null });
    assert.equal(tick(29_999).action, null);
    assert.deepEqual(tick(30_000), { state: { stage: "nudged", stageSince: 30_000 }, action: "nudge" });
    assert.equal(tick(30_001).action, null);
    assert.equal(tick(89_999).action, null);
    assert.deepEqual(tick(90_000), { state: { stage: "escalated", stageSince: 90_000 }, action: "escalate" });
    assert.equal(tick(179_999).action, null);
    assert.deepEqual(tick(180_000), { state: { stage: "killed", stageSince: 180_000 }, action: "kill" });
    assert.equal(tick(999_999).action, null, "terminal recovery state must be a no-op");
  });

  it("uses injected pane operations, tears down once, and reports recovery-kill as a failure", () => {
    const testApi = (subagentsModule as any).__test__;
    const running = makeRunning({
      abortController: {
        abort() {
          aborts += 1;
        },
      },
    });
    let nudges = 0;
    let closes = 0;
    let aborts = 0;
    const operations = {
      interruptPane(surface: string) {
        assert.equal(surface, "pane-1");
        nudges += 1;
      },
      closePane(surface: string) {
        assert.equal(surface, "pane-1");
        closes += 1;
      },
      abortWatcher() {
        assert.match(running.recoveryKilled?.errorMessage ?? "", /recovery-kill after 180s/);
        running.abortController.abort();
      },
    };

    for (const now of [0, 30_000, 90_000, 180_000]) {
      testApi.advanceRunningRecovery(running, { kind: "stalled" }, now, delays, operations);
    }

    assert.equal(nudges, 1);
    assert.equal(closes, 1);
    assert.equal(aborts, 1);
    assert.equal(running.recovery.stage, "killed");
    assert.equal(running.lifecycle.process.kind, "failed");
    assert.match(running.lifecycle.process.error, /recovery-kill after 180s/);

    const result = testApi.buildRecoveryKilledResult(running, 180_001);
    assert.equal(result.exitCode, 1);
    assert.equal(result.error, running.lifecycle.process.error);
    assert.match(result.errorMessage, /recovery-kill after 180s/);
    assert.match(result.summary, /recovery-kill/);
    assert.doesNotMatch(result.summary, /cancelled|wrap-up|completed/i);

    const presentation = testApi.resolveResultPresentation(result, running.name);
    assert.match(presentation, /failed/);
    assert.doesNotMatch(presentation, /completed/);

    const repeated = testApi.advanceRunningRecovery(running, { kind: "stalled" }, 999_999, delays, operations);
    assert.equal(repeated.action, null, "terminal recovery state must not produce a duplicate result");
    assert.equal(closes, 1, "repeated ticks must not close a pane twice");
    assert.equal(aborts, 1, "repeated ticks must not abort twice");
    running.lifecycle = { ...running.lifecycle, delivery: "delivered" };
    assert.equal(subagentsModule.shouldDeliverSubagentCompletion(running), false);
  });

  it("does not arm interactive or wrap-up children", () => {
    const testApi = (subagentsModule as any).__test__;
    for (const overrides of [{ interactive: true }, { wrapupPending: true }]) {
      const running = makeRunning(overrides);
      let paneCalls = 0;
      const advance = testApi.advanceRunningRecovery(
        running,
        { kind: "stalled" },
        1_000_000,
        delays,
        {
          interruptPane() {
            paneCalls += 1;
          },
          closePane() {
            paneCalls += 1;
          },
          abortWatcher() {
            paneCalls += 1;
          },
        },
      );
      assert.equal(advance.action, null);
      assert.equal(running.recovery, undefined);
      assert.equal(paneCalls, 0);
    }
  });

  it("never advances healthy tool, streaming, or provider activity despite long runtime", () => {
    const testApi = (subagentsModule as any).__test__;
    for (const scope of ["tool", "streaming", "provider"] as const) {
      const now = 1_000_000;
      let lifecycle = createLifecycle(0);
      lifecycle = observePaneInspection(lifecycle, {
        kind: "present",
        observedAt: now,
        agentStatus: "working",
      }, now);
      lifecycle = observeActivity(lifecycle, {
        ok: true,
        activity: {
          version: 1,
          runningChildId: "child-1",
          createdAt: 0,
          updatedAt: now,
          sequence: 1,
          latestEvent: "agent_start",
          phase: "active",
          agentActive: true,
          turnActive: true,
          providerActive: scope === "provider",
          toolActive: scope === "tool",
          activeScope: scope,
          activeSince: now,
          ...(scope === "tool" ? { toolName: "bash", toolStartedAt: now } : {}),
        },
      }, now);
      const projection = projectLifecycle(lifecycle, now + 1);
      assert.equal(projection.kind, "active", scope);

      const running = makeRunning({ lifecycle });
      const advance = testApi.advanceRunningRecovery(
        running,
        projection,
        now + delays[0] + delays[1] + delays[2] + 1,
        delays,
        {
          interruptPane() {
            throw new Error("healthy activity must not be nudged");
          },
          closePane() {
            throw new Error("healthy activity must not be killed");
          },
          abortWatcher() {
            throw new Error("healthy activity must not be aborted");
          },
        },
      );
      assert.equal(advance.action, null, scope);
      assert.equal(running.recovery, undefined, scope);
    }
  });
});
