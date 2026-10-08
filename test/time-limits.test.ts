import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import { interpretExitSidecar } from "../pi-extension/subagents/completion.ts";
import {
  REPORT_ONLY_WRAPUP_DIRECTIVE,
  consumeWrapupDirective,
  evalTimeLimit,
  writeWrapupDirective,
} from "../pi-extension/subagents/time-limits.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";

function withTempDir(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-time-limits-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeRunning(overrides: Record<string, unknown> = {}) {
  return {
    id: "child-1",
    name: "Worker",
    task: "Implement the feature",
    surface: "pane-1",
    startTime: 0,
    sessionFile: "/tmp/worker.jsonl",
    interactive: false,
    lifecycle: createLifecycle(0),
    timeLimit: { timeLimitSeconds: 100, timeoutWarnThreshold: 0.8 },
    ...overrides,
  };
}

function createMockExtensionApi() {
  const eventHandlers = new Map<string, Array<Function>>();
  const sentUserMessages: string[] = [];
  return {
    eventHandlers,
    sentUserMessages,
    api: {
      on(event: string, handler: Function) {
        const handlers = eventHandlers.get(event) ?? [];
        handlers.push(handler);
        eventHandlers.set(event, handlers);
      },
      registerShortcut() {},
      registerTool() {},
      registerCommand() {},
      registerMessageRenderer(name: string, renderer: Function) {
        this.renderers.push({ name, renderer });
      },
      renderers: [] as Array<{ name: string; renderer: Function }>,
      getAllTools() {
        return [];
      },
      sendUserMessage(message: string) {
        sentUserMessages.push(message);
      },
    } as any,
  };
}

function createTheme(calls: string[]) {
  return {
    fg(color: string, text: string) {
      calls.push(`fg:${color}`);
      return text;
    },
    bg(color: string, text: string) {
      calls.push(`bg:${color}`);
      return text;
    },
    bold(text: string) {
      return text;
    },
  };
}

describe("time-limit frontmatter", () => {
  it("parses valid values and ignores invalid or absent values", () => {
    const parse = (subagentsModule as any).__test__.parseAgentDefinition;
    const parseFields = (frontmatter: string) =>
      parse(`---\nname: worker\n${frontmatter}\n---\nWorker body`, "fallback");

    assert.deepEqual(
      {
        timeLimitSeconds: parseFields("time-limit: 120\nidle-timeout: 15\ntimeout-warn-threshold: 0.8").timeLimitSeconds,
        idleTimeoutSeconds: parseFields("time-limit: 120\nidle-timeout: 15\ntimeout-warn-threshold: 0.8").idleTimeoutSeconds,
        timeoutWarnThreshold: parseFields("time-limit: 120\nidle-timeout: 15\ntimeout-warn-threshold: 0.8").timeoutWarnThreshold,
      },
      { timeLimitSeconds: 120, idleTimeoutSeconds: 15, timeoutWarnThreshold: 0.8 },
    );

    for (const frontmatter of [
      "time-limit: 0",
      "time-limit: -1",
      "time-limit: 1.5",
      "time-limit: 1e3",
      "idle-timeout: nope",
      "idle-timeout: 0",
      "timeout-warn-threshold: 0",
      "timeout-warn-threshold: 1",
      "timeout-warn-threshold: 1.1",
      "timeout-warn-threshold: nope",
      "",
    ]) {
      const parsed = parseFields(frontmatter);
      assert.equal(parsed.timeLimitSeconds, undefined, frontmatter);
      assert.equal(parsed.idleTimeoutSeconds, undefined, frontmatter);
      assert.equal(parsed.timeoutWarnThreshold, undefined, frontmatter);
    }
  });
});

describe("evalTimeLimit", () => {
  it("uses an injected clock for no-limit, warn-only, hard-only, both, and idle cases", () => {
    const cases: Array<[
      string,
      number,
      number | undefined,
      { timeLimitSeconds?: number; idleTimeoutSeconds?: number; timeoutWarnThreshold?: number },
      boolean | undefined,
      "none" | "warn" | "hard-stop",
    ]> = [
      ["no limit", 999_999, undefined, {}, undefined, "none"],
      ["before whole-run warning", 79_999, undefined, { timeLimitSeconds: 100, timeoutWarnThreshold: 0.8 }, false, "none"],
      ["whole-run warning", 80_000, undefined, { timeLimitSeconds: 100, timeoutWarnThreshold: 0.8 }, false, "warn"],
      ["warning fires once", 81_000, undefined, { timeLimitSeconds: 100, timeoutWarnThreshold: 0.8 }, true, "none"],
      ["whole-run hard stop", 100_000, undefined, { timeLimitSeconds: 100, timeoutWarnThreshold: 0.8 }, true, "hard-stop"],
      ["hard-only before deadline", 99_999, undefined, { timeLimitSeconds: 100 }, false, "none"],
      ["hard-only at deadline", 100_000, undefined, { timeLimitSeconds: 100 }, false, "hard-stop"],
      ["idle warning uses activity timestamp", 57_999, 50_000, { idleTimeoutSeconds: 10, timeoutWarnThreshold: 0.8 }, false, "none"],
      ["idle warning at fraction", 58_000, 50_000, { idleTimeoutSeconds: 10, timeoutWarnThreshold: 0.8 }, false, "warn"],
      ["idle hard stop", 60_000, 50_000, { idleTimeoutSeconds: 10, timeoutWarnThreshold: 0.8 }, true, "hard-stop"],
      ["idle does not use wall clock without an activity snapshot", 100_000, undefined, { idleTimeoutSeconds: 10, timeoutWarnThreshold: 0.8 }, false, "none"],
      ["the earliest configured deadline wins", 60_000, 55_000, { timeLimitSeconds: 100, idleTimeoutSeconds: 5, timeoutWarnThreshold: 0.8 }, true, "hard-stop"],
    ];

    for (const [label, now, lastActivityAt, config, warned, expected] of cases) {
      assert.equal(evalTimeLimit(now, 0, lastActivityAt, config, warned), expected, label);
    }
  });
});

describe("parent time-limit actions", () => {
  it("writes one directive then only sends Escape for a warned wrap-up", () => {
    const testApi = (subagentsModule as any).__test__;
    const running = makeRunning();
    const calls: string[] = [];
    let typed = 0;
    const operations = {
      interruptPane(surface: string) {
        calls.push(`escape:${surface}`);
      },
      closePane() {
        calls.push("close");
      },
      abortWatcher() {
        calls.push("abort");
      },
      writeWrapup(sessionFile: string) {
        calls.push(`write:${sessionFile}.wrapup`);
      },
      removeWrapup(sessionFile: string) {
        calls.push(`remove:${sessionFile}.wrapup`);
      },
    };

    assert.equal(testApi.advanceRunningTimeLimit(running, 80_000, operations).action, "warn");
    assert.equal(running.wrapupPending, true);
    assert.equal(running.timeLimitWarned, true);
    assert.deepEqual(calls, ["write:/tmp/worker.jsonl.wrapup", "escape:pane-1"]);

    assert.equal(testApi.advanceRunningTimeLimit(running, 81_000, operations).action, null);
    assert.deepEqual(calls, ["write:/tmp/worker.jsonl.wrapup", "escape:pane-1"]);
    assert.equal(typed, 0, "the warning path must not type free text into the child pane");
  });

  it("pins the warned idle deadline, tears down once at hard stop, and reports a timed-out session tail", () => {
    withTempDir((dir) => {
      const testApi = (subagentsModule as any).__test__;
      const sessionFile = join(dir, "worker.jsonl");
      writeFileSync(sessionFile, `${JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Halfway through the migration." }] },
      })}\n`);
      const running = makeRunning({
        sessionFile,
        activity: { updatedAt: 50_000 },
        timeLimit: { idleTimeoutSeconds: 10, timeoutWarnThreshold: 0.8 },
      });
      let closes = 0;
      let aborts = 0;
      let removes = 0;
      const operations = {
        interruptPane() {},
        closePane() {
          closes += 1;
        },
        abortWatcher() {
          aborts += 1;
        },
        writeWrapup() {},
        removeWrapup() {
          removes += 1;
        },
      };

      assert.equal(testApi.advanceRunningTimeLimit(running, 58_000, operations).action, "warn");
      running.activity = { updatedAt: 59_999 };
      assert.equal(
        testApi.advanceRunningTimeLimit(running, 60_000, operations).action,
        "hard-stop",
        "the original idle deadline must stay pinned after the warning",
      );
      assert.equal(closes, 1);
      assert.equal(aborts, 1);
      assert.equal(removes, 1);
      assert.equal(running.wrapupPending, false);
      assert.equal(running.lifecycle.process.kind, "failed");

      const result = testApi.buildTimeLimitStoppedResult(running, 60_001);
      assert.deepEqual(
        { exitCode: result.exitCode, timeout: result.timeout, partial: result.partial },
        { exitCode: 1, timeout: "hard-stop", partial: undefined },
      );
      assert.match(result.summary, /timed out after 60s/i);
      assert.match(result.summary, /Halfway through the migration/);
      assert.match(testApi.resolveResultPresentation(result, running.name), /failed/);
      assert.doesNotMatch(testApi.resolveResultPresentation(result, running.name), /completed/);

      assert.equal(testApi.advanceRunningTimeLimit(running, 61_000, operations).action, null);
      assert.equal(closes, 1, "terminal hard-stop must not close twice");
      assert.equal(aborts, 1, "terminal hard-stop must not abort twice");
    });
  });

  it("keeps recovery, interactive, and resumed runs out of time-limit actions", () => {
    const testApi = (subagentsModule as any).__test__;
    const noPaneCalls = {
      interruptPane() { throw new Error("must not interrupt"); },
      closePane() { throw new Error("must not close"); },
      abortWatcher() { throw new Error("must not abort"); },
      writeWrapup() { throw new Error("must not write"); },
      removeWrapup() { throw new Error("must not remove"); },
    };

    assert.equal(
      testApi.advanceRunningTimeLimit(makeRunning({ interactive: true }), 100_000, noPaneCalls).action,
      null,
    );
    assert.equal(
      testApi.advanceRunningTimeLimit(makeRunning({ recoveryKilled: { errorMessage: "recovery-kill", killedAt: 1 } }), 100_000, noPaneCalls).action,
      null,
    );
    assert.equal(
      testApi.advanceRunningTimeLimit(makeRunning({ timeLimit: undefined }), 100_000, noPaneCalls).action,
      null,
      "a resume registration without re-specified frontmatter has no deadline",
    );

    assert.equal(
      testApi.resolveTimeLimitConfig(
        { timeLimitSeconds: 100, timeoutWarnThreshold: 0.8 },
        false,
        false,
      ).timeoutWarnThreshold,
      undefined,
      "non-Pi children retain a hard deadline but cannot promise a file-based report continuation",
    );

    const hardStopped = makeRunning({ timeLimitStopped: { errorMessage: "timed out", stoppedAt: 1 } });
    const recovery = testApi.advanceRunningRecovery(
      hardStopped,
      { kind: "stalled" },
      100_000,
      [1, 1, 1],
      noPaneCalls,
    );
    assert.equal(recovery.action, null);
    assert.equal(hardStopped.recovery, undefined);
  });
});

describe("completion classification", () => {
  it("keeps partial, timed-out, recovery-kill, and clean outcomes mutually exclusive", () => {
    const testApi = (subagentsModule as any).__test__;
    const partial = {
      name: "Worker",
      task: "Task",
      summary: "Partial report",
      exitCode: 0,
      elapsed: 80,
      partial: true,
      timeout: "warned-wrapup" as const,
    };
    const timedOut = testApi.buildTimeLimitStoppedResult(
      makeRunning({ timeLimitStopped: { errorMessage: "Subagent timed out after 100s.", stoppedAt: 100_000 } }),
      100_000,
    );
    const recovery = testApi.buildRecoveryKilledResult(
      makeRunning({ recoveryKilled: { errorMessage: "Subagent recovery-kill after 100s.", killedAt: 100_000 } }),
      100_000,
    );
    const clean = {
      name: "Worker",
      task: "Task",
      summary: "Completed",
      exitCode: 0,
      elapsed: 10,
    };

    const classify = (result: any) =>
      result.partial ? "partial" : result.timeout === "hard-stop" ? "timed-out" : result.errorMessage ? "recovery-kill" : "clean";
    assert.deepEqual(
      [partial, timedOut, recovery, clean].map(classify),
      ["partial", "timed-out", "recovery-kill", "clean"],
    );
    assert.match(testApi.resolveResultPresentation(partial, partial.name), /partial report/i);
    assert.match(testApi.resolveResultPresentation(timedOut, timedOut.name), /failed/i);
    assert.match(testApi.resolveResultPresentation(recovery, recovery.name), /failed/i);
    assert.match(testApi.resolveResultPresentation(clean, clean.name), /completed/i);
  });
});

describe("wrap-up directive and completion delivery", () => {
  it("is consumed once, starts a report-only continuation, and publishes a normal partial completion", () => {
    withTempDir((dir) => {
      const artifactDir = join(dir, "artifacts");
      mkdirSync(artifactDir);
      const sessionFile = join(artifactDir, "worker.jsonl");
      writeFileSync(sessionFile, "");
      writeWrapupDirective(sessionFile);
      assert.equal(readFileSync(`${sessionFile}.wrapup`, "utf8"), REPORT_ONLY_WRAPUP_DIRECTIVE);
      assert.equal(consumeWrapupDirective(sessionFile), REPORT_ONLY_WRAPUP_DIRECTIVE);
      assert.equal(consumeWrapupDirective(sessionFile), null, "a directive is consumed once");
      assert.equal(existsSync(`${sessionFile}.wrapup`), false);

      writeWrapupDirective(sessionFile);
      const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
      const previousSession = process.env.PI_SUBAGENT_SESSION;
      process.env.PI_SUBAGENT_AUTO_EXIT = "1";
      process.env.PI_SUBAGENT_SESSION = sessionFile;
      try {
        const { api, eventHandlers, sentUserMessages } = createMockExtensionApi();
        subagentDoneExtension(api);
        let shutdowns = 0;
        const ctx = { shutdown() { shutdowns += 1; } };
        const agentEnd = eventHandlers.get("agent_end")![0];
        const agentSettled = eventHandlers.get("agent_settled")![0];

        agentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] }, ctx);
        agentSettled({}, ctx);
        assert.deepEqual(sentUserMessages, [REPORT_ONLY_WRAPUP_DIRECTIVE]);
        assert.equal(shutdowns, 0);
        assert.equal(existsSync(`${sessionFile}.wrapup`), false);

        agentEnd({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
        agentSettled({}, ctx);
        assert.equal(shutdowns, 1);
        assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), {
          type: "done",
          wrapup: true,
        });
        assert.deepEqual(interpretExitSidecar({ type: "done", wrapup: true }), {
          reason: "done",
          exitCode: 0,
          wrapup: true,
        });
        assert.equal(existsSync(sessionFile), true, "the partial-report session remains resumable");
        assert.deepEqual(
          readdirSync(artifactDir).filter((file) => file.endsWith(".wrapup")),
          [],
          "cleanup leaves no stray wrap-up directives in the artifact directory",
        );
      } finally {
        if (previousAutoExit == null) delete process.env.PI_SUBAGENT_AUTO_EXIT;
        else process.env.PI_SUBAGENT_AUTO_EXIT = previousAutoExit;
        if (previousSession == null) delete process.env.PI_SUBAGENT_SESSION;
        else process.env.PI_SUBAGENT_SESSION = previousSession;
      }
    });
  });

  it("marks warned reports in details, presentation, and warning-styled rendering", () => {
    const testApi = (subagentsModule as any).__test__;
    const result = {
      name: "Worker",
      task: "Implement the feature",
      summary: "Implemented the parser; remaining tests need review.",
      sessionFile: "/tmp/worker.jsonl",
      exitCode: 0,
      elapsed: 80,
      partial: true,
      timeout: "warned-wrapup" as const,
    };
    assert.deepEqual(testApi.buildResultTimeoutDetails(result), {
      partial: true,
      timeout: "warned-wrapup",
    });

    const presentation = testApi.resolveResultPresentation(result, result.name);
    assert.match(presentation, /partial report under .*time limit/i);
    assert.doesNotMatch(presentation, /failed/);

    const { api } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const renderer = api.renderers.find((entry: any) => entry.name === "subagent_result")!.renderer;
    const calls: string[] = [];
    const rendered = renderer(
      {
        customType: "subagent_result",
        content: presentation,
        details: {
          name: result.name,
          exitCode: 0,
          elapsed: result.elapsed,
          partial: true,
          timeout: "warned-wrapup",
        },
      },
      { expanded: true },
      createTheme(calls),
    );
    assert.match(rendered.render(100).join("\n"), /partial report \(time limit\)/i);
    assert.ok(calls.includes("fg:warning"), "partial completion uses warning styling");
  });
});
