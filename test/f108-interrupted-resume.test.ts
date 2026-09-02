import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
import { __test__ as subagentsTest } from "../pi-extension/subagents/index.ts";
import { waitForCompletion } from "../pi-extension/subagents/completion.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";

function createChildApi() {
  const eventHandlers = new Map<string, Function[]>();
  const commands: Array<{ name: string; handler: Function }> = [];
  return {
    eventHandlers,
    commands,
    api: {
      on(event: string, handler: Function) {
        eventHandlers.set(event, [...(eventHandlers.get(event) ?? []), handler]);
      },
      registerTool() {},
      registerCommand(name: string, command: any) {
        commands.push({ name, handler: command.handler });
      },
      registerMessageRenderer() {},
      registerShortcut() {},
      sendUserMessage() {},
      sendMessage() {},
      getAllTools() { return []; },
    } as any,
  };
}

const originalEnv = {
  autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
  rearm: process.env.PI_SUBAGENT_AUTO_EXIT_REARM,
  resumeInput: process.env.PI_SUBAGENT_RESUME_INPUT,
  session: process.env.PI_SUBAGENT_SESSION,
  interruptGrace: process.env.PI_SUBAGENT_INTERRUPT_GRACE_MS,
};
const tempDirs = new Set<string>();

function restoreEnv(name: string, value: string | undefined) {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnv("PI_SUBAGENT_AUTO_EXIT", originalEnv.autoExit);
  restoreEnv("PI_SUBAGENT_AUTO_EXIT_REARM", originalEnv.rearm);
  restoreEnv("PI_SUBAGENT_RESUME_INPUT", originalEnv.resumeInput);
  restoreEnv("PI_SUBAGENT_SESSION", originalEnv.session);
  restoreEnv("PI_SUBAGENT_INTERRUPT_GRACE_MS", originalEnv.interruptGrace);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
  const running = subagentsTest.runningSubagents as Map<string, any>;
  running.clear();
});

describe("F-108 interrupted delegation lifecycle", () => {
  function makeRunning(overrides: Record<string, unknown> = {}) {
    return {
      id: "child-1",
      name: "Worker",
      task: "bounded task",
      surface: "pane-1",
      startTime: Date.now(),
      sessionFile: join((() => {
        const dir = mkdtempSync(join(tmpdir(), "f108-session-"));
        tempDirs.add(dir);
        return dir;
      })(), "child.jsonl"),
      cli: "pi",
      interactive: false,
      lifecycle: createLifecycle(Date.now()),
      ...overrides,
    };
  }

  it("marks an interrupted autonomous child terminal and closes it only after grace", async () => {
    const testApi = subagentsTest;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let closes = 0;
    let aborts = 0;
    const running = makeRunning({
      abortController: { abort() { aborts += 1; } },
    });
    writeFileSync(running.sessionFile, "session remains resumable\n");
    runningMap.set(running.id, running);

    const result = testApi.handleSubagentInterrupt(
      { id: running.id },
      () => {},
      {
        graceMs: 10,
        closePane: () => { closes += 1; },
        abortWatcher: () => { aborts += 1; },
      },
    );

    assert.equal(result.details.status, "interrupt_requested");
    assert.equal(closes, 0, "the pane must remain during the grace window");
    assert.equal(running.lifecycle.turn.kind, "interrupted");

    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(closes, 1, "the pane closes after the bounded grace");
    assert.equal(aborts, 1, "the completion watcher is stopped after close");
    assert.equal(running.lifecycle.process.kind, "failed");
    assert.match(running.lifecycle.process.error, /interrupted/i);
    assert.equal(existsSync(running.sessionFile), true, "the session JSONL is retained");
    assert.equal(runningMap.has(running.id), true, "terminal row remains deliverable until watcher handoff");
  });

  it("keeps interactive takeover panes open", async () => {
    const testApi = subagentsTest;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let closes = 0;
    const running = makeRunning({
      interactive: true,
      abortController: { abort() {} },
    });
    runningMap.set(running.id, running);

    testApi.handleSubagentInterrupt(
      { id: running.id },
      () => {},
      { graceMs: 0, closePane: () => { closes += 1; }, abortWatcher: () => {} },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(closes, 0);
    assert.equal(running.lifecycle.turn.kind, "interrupted");
    assert.equal(running.lifecycle.process.kind, "starting");
  });
});

describe("F-108 resumed auto-exit", () => {
  function boot(opts: { rearm?: boolean; resumeInput?: boolean } = {}) {
    process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    if (opts.rearm) process.env.PI_SUBAGENT_AUTO_EXIT_REARM = "1";
    else delete process.env.PI_SUBAGENT_AUTO_EXIT_REARM;
    if (opts.resumeInput) process.env.PI_SUBAGENT_RESUME_INPUT = "1";
    else delete process.env.PI_SUBAGENT_RESUME_INPUT;
    const dir = mkdtempSync(join(tmpdir(), "f108-resume-"));
    tempDirs.add(dir);
    const sessionFile = join(dir, "child.jsonl");
    writeFileSync(sessionFile, "session header\n");
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    const { api, eventHandlers } = createChildApi();
    subagentDoneExtension(api);
    const ctx: any = {
      shutdowns: 0,
      ui: { notify() {}, setWidget() {} },
      shutdown() { ctx.shutdowns += 1; },
    };
    return {
      sessionFile,
      ctx,
      fire(event: string, payload: any = {}) {
        for (const handler of eventHandlers.get(event) ?? []) handler(payload, ctx);
      },
    };
  }

  it("keeps the normal one-shot close path unchanged", async () => {
    const child = boot();
    child.fire("agent_start");
    child.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
    child.fire("agent_settled");

    assert.equal(child.ctx.shutdowns, 1);
    assert.deepEqual(JSON.parse(readFileSync(`${child.sessionFile}.exit`, "utf8")), { type: "done" });
    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1,
      sessionFile: child.sessionFile,
      readTerminalTail: async () => "",
    });
    assert.deepEqual(result, { reason: "done", exitCode: 0 });
    assert.equal(existsSync(`${child.sessionFile}.exit`), false);
  });

  it("treats the resumed prompt as machine input and writes a fresh sidecar", async () => {
    const child = boot({ rearm: true, resumeInput: true });
    child.fire("agent_start");
    child.fire("input", { type: "input", text: "continue after the interrupt" });
    child.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
    child.fire("agent_settled");

    assert.equal(child.ctx.shutdowns, 1, "resume re-arms one-shot completion");
    assert.deepEqual(JSON.parse(readFileSync(`${child.sessionFile}.exit`, "utf8")), { type: "done" });

    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1,
      sessionFile: child.sessionFile,
      readTerminalTail: async () => "",
    });
    assert.deepEqual(result, { reason: "done", exitCode: 0 });
    assert.equal(existsSync(`${child.sessionFile}.exit`), false, "the fresh sidecar is consumed");
  });
});

describe("F-108 interrupt grace configuration", () => {
  it("marks autonomous resumes for one-shot auto-exit and prompt filtering", () => {
    assert.deepEqual(subagentsTest.buildResumeAutoExitEnv({ autoExit: true, hasMessage: true }), [
      "PI_SUBAGENT_AUTO_EXIT=1",
      "PI_SUBAGENT_AUTO_EXIT_REARM=1",
      "PI_SUBAGENT_RESUME_INPUT=1",
    ]);
    assert.deepEqual(subagentsTest.buildResumeAutoExitEnv({ autoExit: false, hasMessage: true }), []);
  });

  it("accepts a finite non-negative grace override and falls back safely", () => {
    const testApi = subagentsTest;
    assert.equal(testApi.parseInterruptGraceMs("1250"), 1250);
    assert.equal(testApi.parseInterruptGraceMs("0"), 0);
    assert.equal(testApi.parseInterruptGraceMs("not-a-number"), testApi.DEFAULT_INTERRUPT_GRACE_MS);
    assert.equal(testApi.parseInterruptGraceMs("-1"), testApi.DEFAULT_INTERRUPT_GRACE_MS);
  });
});
