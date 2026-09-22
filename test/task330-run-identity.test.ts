/**
 * TASK-330 — conflate-proof subagent run identity and truthful exit sidecars.
 *
 * Covers the three in-repo acceptance criteria:
 *   AC1  subagent_resume refuses while a run already owns the session.
 *   AC2  every sidecar carries run identity; consumeExitSidecar drops a
 *        payload whose run identity does not match the watched run; the old
 *        constant crash string is never emitted.
 *   AC3  a process-start / no-result failure carries the child stderr tail
 *        (>= last 4 KiB) or an explicit "stderr not captured: <reason>".
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import {
  isForeignSidecarIdentity,
  waitForCompletion,
} from "../pi-extension/subagents/completion.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";

const testApi = (subagentsModule as any).__test__;

function createMockExtensionApi() {
  const registeredTools: Array<any> = [];
  const eventHandlers = new Map<string, Array<Function>>();
  return {
    registeredTools,
    eventHandlers,
    api: {
      on(event: string, handler: Function) {
        eventHandlers.set(event, [...(eventHandlers.get(event) ?? []), handler]);
      },
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand() {},
      registerMessageRenderer() {},
      registerShortcut() {},
      sendUserMessage() {},
      sendMessage() {},
      getAllTools() {
        return [];
      },
    } as any,
  };
}

// Keep the child sidecar shape deterministic and stop the recorder from
// writing into a real session's activity file when the test process inherits
// the parent/child identity variables.
const inheritedSubagentId = process.env.PI_SUBAGENT_ID;
const inheritedDenyTools = process.env.PI_DENY_TOOLS;
const inheritedActivityFile = process.env.PI_SUBAGENT_ACTIVITY_FILE;
before(() => {
  delete process.env.PI_SUBAGENT_ID;
  delete process.env.PI_DENY_TOOLS;
  delete process.env.PI_SUBAGENT_ACTIVITY_FILE;
});
after(() => {
  if (inheritedSubagentId == null) delete process.env.PI_SUBAGENT_ID;
  else process.env.PI_SUBAGENT_ID = inheritedSubagentId;
  if (inheritedDenyTools == null) delete process.env.PI_DENY_TOOLS;
  else process.env.PI_DENY_TOOLS = inheritedDenyTools;
  if (inheritedActivityFile == null) delete process.env.PI_SUBAGENT_ACTIVITY_FILE;
  else process.env.PI_SUBAGENT_ACTIVITY_FILE = inheritedActivityFile;
});

const createdDirs: string[] = [];
function createDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "t330-identity-"));
  createdDirs.push(dir);
  return dir;
}
afterEach(() => {
  (testApi.runningSubagents as Map<string, any>).clear();
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
  createdDirs.length = 0;
});

describe("TASK-330 AC1 resume-while-active refusal", () => {
  it("findActiveSessionRun reports the run that owns a session file", () => {
    const sessionFile = join(createDir(), "child.jsonl");
    const agents = new Map([
      ["run-1", { id: "run-1", name: "Worker", sessionFile }],
    ]);
    assert.deepEqual(
      testApi.findActiveSessionRun(sessionFile, agents, new Set()),
      { id: "run-1", name: "Worker" },
    );
    assert.equal(
      testApi.findActiveSessionRun(join(createDir(), "other.jsonl"), agents, new Set()),
      undefined,
    );
  });

  it("findActiveSessionRun also sees an in-flight resume reservation", () => {
    const sessionFile = join(createDir(), "child.jsonl");
    assert.deepEqual(
      testApi.findActiveSessionRun(sessionFile, new Map(), new Set([sessionFile])),
      { id: "(pending)", name: "resume" },
    );
  });

  it("subagent_resume refuses instead of spawning a second pi on an active session", async () => {
    const sessionFile = join(createDir(), "child.jsonl");
    writeFileSync(sessionFile, "");
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.set("active-run", {
      id: "active-run",
      name: "Worker",
      task: "already running",
      surface: "pane-x",
      startTime: Date.now(),
      sessionFile,
      interactive: false,
      lifecycle: createLifecycle(Date.now()),
      runtimePlan: undefined,
    });

    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const resumeTool = registeredTools.find((tool: any) => tool.name === "subagent_resume");
    assert.ok(resumeTool, "subagent_resume must be registered");

    const result = await resumeTool.execute(
      "call-1",
      { sessionPath: sessionFile },
      new AbortController().signal,
      undefined,
      {
        cwd: createDir(),
        sessionManager: {
          getSessionId: () => "parent",
          getSessionDir: () => createDir(),
          getSessionFile: () => sessionFile,
        },
      },
    );

    assert.equal(result.details.status, "refused");
    assert.equal(result.details.error, "session already active");
    assert.match(result.content[0].text, /active run/i);
    assert.equal(runningMap.size, 1, "no second run may be registered");
    // The refusal happens before any pane or sidecar mutation.
    assert.equal(existsSync(`${sessionFile}.exit`), false);
  });
});

describe("TASK-330 AC2 run-identity sidecar filter", () => {
  it("treats a mismatched runId as foreign and a matching runId as owned", () => {
    const expected = { runId: "run-a", pid: 10, startTime: 20 };
    assert.equal(
      isForeignSidecarIdentity({ runId: "run-b", workerPid: 10, workerStartTime: 20 }, expected),
      true,
      "a different run on the same session must be rejected",
    );
    assert.equal(
      isForeignSidecarIdentity({ runId: "run-a", workerPid: 10, workerStartTime: 20 }, expected),
      false,
    );
    assert.equal(
      isForeignSidecarIdentity({ workerPid: 10, workerStartTime: 20 }, expected),
      false,
      "legacy unstamped-identity payloads are accepted (accept-when-unknown)",
    );
    assert.equal(
      isForeignSidecarIdentity({ runId: "run-b" }, undefined),
      false,
      "without an expected writer every payload passes through",
    );
  });

  it("keeps waiting when a second run publishes on the shared session exit path", async () => {
    const dir = createDir();
    const sessionFile = join(dir, "child.jsonl");
    const exitFile = `${sessionFile}.exit`;
    let reads = 0;
    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1,
      sessionFile,
      expectedSidecarWriter: { runId: "run-a" },
      readTerminalTail: async () => {
        reads += 1;
        if (reads === 1) {
          writeFileSync(exitFile, JSON.stringify({
            type: "error",
            errorMessage: "second run crashed",
            runId: "run-b",
            workerPid: 999,
            workerStartTime: 1,
          }));
        }
        return reads >= 3 ? "__SUBAGENT_DONE_0__" : "";
      },
    });
    assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });
    assert.equal(existsSync(exitFile), false, "the foreign payload must be deleted, not consumed");
  });

  it("consumes a sidecar stamped with the watched runId", async () => {
    const dir = createDir();
    const sessionFile = join(dir, "child.jsonl");
    const exitFile = `${sessionFile}.exit`;
    writeFileSync(exitFile, JSON.stringify({
      type: "error",
      errorMessage: "provider exhausted",
      stopReason: "error",
      runId: "run-a",
      workerPid: 42,
      workerStartTime: 7,
    }));
    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1,
      sessionFile,
      expectedSidecarWriter: { runId: "run-a" },
      readTerminalTail: async () => "",
    });
    assert.equal(result.reason, "error");
    assert.equal(result.errorMessage, "provider exhausted");
    assert.equal(existsSync(exitFile), false);
  });

  it("writes a truthful exit-code crash message instead of a constant", () => {
    const dir = createDir();
    const sessionFile = join(dir, "child.jsonl");
    const exitFile = `${sessionFile}.exit`;
    const priorExit = process.listeners("exit");
    const priorUncaught = process.listeners("uncaughtException");
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    try {
      let hooks: { registerCrashHooks: (argv?: readonly string[]) => void } | undefined;
      const { api } = createMockExtensionApi();
      subagentDoneExtension(api, { onReady: (h) => { hooks = h; } });
      hooks!.registerCrashHooks(["node", "pi", "--session", sessionFile]);
      const exitHandler = process.listeners("exit").find((h) => !priorExit.includes(h));
      assert.ok(exitHandler, "the guarded argv must arm the exit hook");
      (exitHandler as (code: number) => void)(7);
      const written = JSON.parse(readFileSync(exitFile, "utf8"));
      assert.equal(written.type, "error");
      assert.equal(written.exitCode, 7);
      assert.equal(written.errorMessage, written.message);
      assert.match(written.message, /exit code 7/);
      assert.doesNotMatch(written.message, /exited unexpectedly/i);
    } finally {
      for (const handler of process.listeners("exit")) {
        if (!priorExit.includes(handler)) process.off("exit", handler as () => void);
      }
      for (const handler of process.listeners("uncaughtException")) {
        if (!priorUncaught.includes(handler)) {
          process.off("uncaughtException", handler as (error: Error) => void);
        }
      }
      delete process.env.PI_SUBAGENT_AUTO_EXIT;
      delete process.env.PI_SUBAGENT_SESSION;
    }
  });
});

describe("TASK-330 AC3 stderr evidence on process-start / no-result failure", () => {
  it("returns the last 4 KiB of a captured stderr file", () => {
    const dir = createDir();
    const file = join(dir, "child.stderr.log");
    writeFileSync(file, "x".repeat(6000) + "TAIL-MARKER");
    const capture = testApi.captureStderrTail(file);
    assert.equal(capture.reason, undefined);
    assert.equal(capture.tail.length, 4096);
    assert.match(capture.tail, /TAIL-MARKER$/);
  });

  it("names why stderr was not captured", () => {
    assert.match(testApi.captureStderrTail(undefined).reason, /no stderr file/);
    const dir = createDir();
    assert.match(testApi.captureStderrTail(join(dir, "missing.log")).reason, /not found/);
    const empty = join(dir, "empty.log");
    writeFileSync(empty, "");
    assert.match(testApi.captureStderrTail(empty).reason, /empty/);
  });

  async function watchNoResult(sessionFile: string, stderrFile?: string) {
    writeFileSync(
      `${sessionFile}.exit`,
      JSON.stringify({ type: "error", errorMessage: "no session was created", stopReason: "error" }),
    );
    const startTime = Date.now() - 3_000;
    return await testApi.watchSubagent(
      {
        id: "t330-child",
        name: "Worker",
        task: "t330",
        surface: "pane-t330",
        startTime,
        sessionFile,
        stderrFile,
        interactive: false,
        lifecycle: createLifecycle(startTime),
      },
      new AbortController().signal,
    );
  }

  it("includes the captured stderr tail in the no-result parent report", async () => {
    const dir = createDir();
    const sessionFile = join(dir, "never-created.jsonl");
    const stderrFile = join(dir, "child.stderr.log");
    writeFileSync(stderrFile, "Error: Failed to load extension /missing/subagent-done.ts\n");
    const result = await watchNoResult(sessionFile, stderrFile);
    assert.equal(result.failureKind, "no-result");
    assert.equal(result.stderr.tail, "Error: Failed to load extension /missing/subagent-done.ts\n");
    const presentation = testApi.resolveResultPresentation(result, "Worker");
    assert.match(presentation, /Child stderr/);
    assert.match(presentation, /Failed to load extension/);
  });

  it("emits an explicit stderr-not-captured marker when no file exists", async () => {
    const dir = createDir();
    const sessionFile = join(dir, "never-created.jsonl");
    const result = await watchNoResult(sessionFile);
    assert.equal(result.failureKind, "no-result");
    assert.match(result.stderr.reason, /no stderr file/);
    const presentation = testApi.resolveResultPresentation(result, "Worker");
    assert.match(presentation, /stderr not captured: no stderr file/);
  });
});
