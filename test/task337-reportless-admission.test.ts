/**
 * TASK-337 — reject or classify reportless subagent completion before
 * admitting `completed`.
 *
 * Confirmed defect (TASK-236 AC1 diagnosis, parent session bebb6cee:513/773):
 * a child that calls `subagent_done` with no report and exits 0 was admitted
 * as `completed` and rendered to the parent as
 *
 *   Sub-agent "general" completed (3m 48s). ...
 *   Sub-agent exited without output
 *
 * because `watchSubagent` chose the lifecycle from `result.exitCode` alone.
 * These fixtures drive the REAL production watcher against a real
 * `<session>.exit` sidecar and assert:
 *   AC1  a reportless completion is NOT admitted as completed; it carries an
 *        explicit failure kind naming the absence.
 *   AC2  a same-message final text report or a `subagent_done` report argument
 *        is still admitted exactly as today, with that text as the summary.
 *   AC4  the new reportless failure carries the captured stderr tail and the
 *        persisted pane-scrollback reference when available.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import subagentsExtension, { REPORTLESS_COMPLETION_SUMMARY } from "../pi-extension/subagents/index.ts";
import { createLifecycle } from "../pi-extension/subagents/lifecycle.ts";
import { getHarnessDriver, registerHarnessDriver } from "../pi-extension/subagents/harness/index.ts";

const testApi = (subagentsModule as any).__test__;

const createdDirs: string[] = [];
function createDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "subagents-t337-"));
  createdDirs.push(dir);
  return dir;
}

// Keep the watcher isolated from inherited parent/child identity variables.
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
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

/** The exact parent-visible shape observed in the two 2026-09-17 incidents. */
const REPORTLESS_ASSISTANT = {
  type: "message",
  id: "assistant-reportless",
  parentId: "root",
  timestamp: "2026-09-17T21:13:00.000Z",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "done" },
      { type: "toolCall", toolName: "subagent_done", toolCallId: "tc-done", arguments: {} },
    ],
    stopReason: "toolUse",
  },
};

const REPORT_TEXT_ASSISTANT = {
  type: "message",
  id: "assistant-text",
  parentId: "root",
  timestamp: "2026-09-17T21:13:00.000Z",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "Task complete: wrote the report." },
      { type: "toolCall", toolName: "subagent_done", toolCallId: "tc-done", arguments: {} },
    ],
    stopReason: "toolUse",
  },
};

const REPORT_ARG_ASSISTANT = {
  type: "message",
  id: "assistant-arg",
  parentId: "root",
  timestamp: "2026-09-17T21:13:00.000Z",
  message: {
    role: "assistant",
    content: [
      { type: "toolCall", toolName: "subagent_done", toolCallId: "tc-done", arguments: { report: "Report via arg" } },
    ],
    stopReason: "toolUse",
  },
};

interface WatchOptions {
  entries: object[];
  stderrFile?: string;
  artifactDir?: string;
  paneScrollback?: any;
  /** TASK-337: entries before this offset belong to the pre-resume transcript. */
  resumeFromEntryCount?: number;
}

async function runWatcher(dir: string, options: WatchOptions) {
  const sessionFile = join(dir, "child.jsonl");
  writeFileSync(sessionFile, options.entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  // A clean `done` sidecar with no error message: exitCode 0, nothing else.
  writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
  const startTime = Date.now() - 3_000;
  return await testApi.watchSubagent(
    {
      id: "t337-child",
      name: "general",
      task: "t337",
      surface: "pane-t337",
      startTime,
      sessionFile,
      ...(options.stderrFile ? { stderrFile: options.stderrFile } : {}),
      ...(options.artifactDir ? { artifactDir: options.artifactDir } : {}),
      ...(options.paneScrollback ? { paneScrollback: options.paneScrollback } : {}),
      interactive: false,
      lifecycle: createLifecycle(startTime),
    },
    new AbortController().signal,
    options.resumeFromEntryCount ?? 0,
  );
}

describe("TASK-337 reportless completion admission", () => {
  it("does NOT admit a reportless done as completed and names the absence (red-first parent-visible shape)", async () => {
    const dir = createDir();
    const result = await runWatcher(dir, { entries: [REPORTLESS_ASSISTANT] });
    const presentation = testApi.resolveResultPresentation(result, "general");

    // The exact incident string must never be produced by an admitted-completed path.
    assert.doesNotMatch(
      presentation,
      /completed \(3s\)\.\n\nSub-agent exited without output/,
      "reportless completion must not render as completed + 'exited without output'",
    );
    assert.equal(result.failureKind, "reportless");
    assert.match(presentation, /without a terminal report/i);
    assert.match(presentation, /no assistant final text/i);
    assert.doesNotMatch(presentation, /\bcompleted\b/i);
  });

  it("preserves a same-message final text report as an admitted completion", async () => {
    const dir = createDir();
    const result = await runWatcher(dir, { entries: [REPORT_TEXT_ASSISTANT] });
    assert.equal(result.failureKind, undefined);
    assert.equal(result.summary, "Task complete: wrote the report.");
    const presentation = testApi.resolveResultPresentation(result, "general");
    assert.match(presentation, /completed \(3s\)\.\n\nTask complete: wrote the report\./);
  });

  it("preserves a subagent_done report argument as an admitted completion", async () => {
    const dir = createDir();
    const result = await runWatcher(dir, { entries: [REPORT_ARG_ASSISTANT] });
    assert.equal(result.failureKind, undefined);
    assert.equal(result.summary, "Report via arg");
    const presentation = testApi.resolveResultPresentation(result, "general");
    assert.match(presentation, /completed \(3s\)\.\n\nReport via arg/);
  });

  it("treats a whitespace-only report with no other text as reportless", async () => {
    const dir = createDir();
    const whitespace = {
      type: "message",
      id: "assistant-ws",
      parentId: "root",
      timestamp: "2026-09-17T21:13:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", toolName: "subagent_done", toolCallId: "tc-done", arguments: { report: "   " } },
        ],
        stopReason: "toolUse",
      },
    };
    const result = await runWatcher(dir, { entries: [whitespace] });
    assert.equal(result.failureKind, "reportless");
    const presentation = testApi.resolveResultPresentation(result, "general");
    assert.doesNotMatch(presentation, /\bcompleted\b/i);
  });

  it("classifies an exit-0 done with no session file as reportless, not completed", async () => {
    const dir = createDir();
    const sessionFile = join(dir, "never-created.jsonl");
    writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
    const startTime = Date.now() - 3_000;
    const result = await testApi.watchSubagent(
      {
        id: "t337-missing",
        name: "general",
        task: "t337",
        surface: "pane-t337",
        startTime,
        sessionFile,
        interactive: false,
        lifecycle: createLifecycle(startTime),
      },
      new AbortController().signal,
    );
    assert.equal(result.failureKind, "reportless");
    const presentation = testApi.resolveResultPresentation(result, "general");
    assert.doesNotMatch(presentation, /\bcompleted\b/i);
    assert.match(presentation, /without a terminal report/i);
  });

  it("attaches the captured stderr tail on a reportless failure", async () => {
    const dir = createDir();
    const stderrFile = join(dir, "child.stderr.log");
    writeFileSync(stderrFile, "Error: Failed to load extension /missing/subagent-done.ts\n");
    const result = await runWatcher(dir, { entries: [REPORTLESS_ASSISTANT], stderrFile });
    assert.equal(result.failureKind, "reportless");
    assert.equal(result.stderr.tail, "Error: Failed to load extension /missing/subagent-done.ts\n");
    const presentation = testApi.resolveResultPresentation(result, "general");
    assert.match(presentation, /Child stderr/);
    assert.match(presentation, /Failed to load extension/);
  });

  it("attaches the persisted pane-scrollback reference on a reportless failure", async () => {
    const dir = createDir();
    const ref = {
      path: join(dir, "pane-scrollback", "t337-child-pane-t337.log"),
      bytes: 42,
      sha256: "a".repeat(64),
      source: "recent-unwrapped",
      readLines: 10_000,
      truncated: false,
    };
    const result = await runWatcher(dir, { entries: [REPORTLESS_ASSISTANT], paneScrollback: ref });
    assert.equal(result.failureKind, "reportless");
    const presentation = testApi.resolveResultPresentation(result, "general");
    assert.match(presentation, /Pane scrollback persisted:/);
    assert.match(presentation, new RegExp(ref.sha256));
  });

  it("labels a reportless exit-0 completion as failed (no report) in the message renderer", () => {
    const registeredMessageRenderers: Array<any> = [];
    const api = {
      on() {},
      registerTool() {},
      registerCommand() {},
      registerMessageRenderer(name: string, renderer: any) {
        registeredMessageRenderers.push({ name, renderer });
      },
      registerShortcut() {},
      sendUserMessage() {},
      sendMessage() {},
      getAllTools() {
        return [];
      },
    } as any;
    subagentsExtension(api);
    const entry = registeredMessageRenderers.find((e) => e.name === "subagent_result");
    assert.ok(entry, "expected the subagent_result renderer to be registered");
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const rendered = entry.renderer(
      {
        customType: "subagent_result",
        content:
          'Sub-agent "general" exited without a terminal report after 3s.\n\n' +
          "Sub-agent exited successfully but produced no terminal report.",
        details: {
          name: "general",
          exitCode: 0,
          elapsed: 3,
          failureKind: "reportless",
          sessionFile: "/tmp/child.jsonl",
        },
      },
      { expanded: true },
      theme,
    );
    const text = rendered.render(80).join("\n");
    assert.match(text, /failed \(no report\)/);
    assert.doesNotMatch(text, /completed/);
  });

  it("does not classify a ping as reportless", async () => {
    const dir = createDir();
    const sessionFile = join(dir, "child.jsonl");
    writeFileSync(sessionFile, JSON.stringify(REPORTLESS_ASSISTANT) + "\n");
    writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "ping", name: "general", message: "need help" }));
    const startTime = Date.now() - 3_000;
    const result = await testApi.watchSubagent(
      {
        id: "t337-ping",
        name: "general",
        task: "t337",
        surface: "pane-t337",
        startTime,
        sessionFile,
        interactive: false,
        lifecycle: createLifecycle(startTime),
      },
      new AbortController().signal,
    );
    assert.equal(result.failureKind, undefined);
    assert.ok(result.ping);
  });
});

/**
 * TASK-337 gap 1 — resumed-session render path.
 *
 * `watchSubagent` reads the whole session file (including the pre-resume
 * transcript), so a resume that exits 0 without writing anything new used to
 * be admitted as completed and rendered to the parent as
 *
 *   Sub-agent "general" completed (3s).
 *   Resumed session exited without new output
 *
 * The resume delivery callback now classifies from ONLY the post-resume
 * entries. These fixtures drive that exact production helper
 * (`classifyResumeCompletion`) and the same `resolveResultPresentation`
 * renderer the parent sees.
 */
describe("TASK-337 gap 1: resumed-session completion uses only post-resume evidence", () => {
  const classify = testApi.classifyResumeCompletion as (
    entries: object[],
    result: { exitCode: number; errorMessage?: string; failureKind?: string; ping?: boolean },
  ) => { failureKind: string | undefined; summary: string };

  it("does NOT render a no-new-output resume as completed (red-first parent-visible shape)", () => {
    // New-entries list is empty: the resume wrote no new terminal output. The
    // pre-resume report that exists in the full session is deliberately not
    // passed, so it cannot stand in for this run's report.
    const { failureKind, summary } = classify([], { exitCode: 0 });
    const presentation = testApi.resolveResultPresentation(
      { summary, exitCode: 0, elapsed: 3, failureKind, sessionFile: "/tmp/child.jsonl" },
      "general",
    );

    assert.equal(failureKind, "reportless");
    assert.equal(summary, REPORTLESS_COMPLETION_SUMMARY);
    assert.doesNotMatch(
      presentation,
      /completed \(3s\)\.\n\nResumed session exited without new output/,
      "a reportless resume must not render as completed + 'Resumed session exited without new output'",
    );
    assert.doesNotMatch(presentation, /\bcompleted\b/i);
    assert.match(presentation, /without a terminal report/i);
  });

  it("does NOT admit a resumed run with no new terminal output as completed (watcher lifecycle)", async () => {
    const dir = createDir();
    // The full session already holds a terminal report from the OLD run; only
    // entries after offset 1 belong to the resumed run, which wrote nothing.
    const result = await runWatcher(dir, {
      entries: [REPORT_TEXT_ASSISTANT],
      resumeFromEntryCount: 1,
    });
    assert.equal(result.failureKind, "reportless");
    const presentation = testApi.resolveResultPresentation(result, "general");
    assert.doesNotMatch(presentation, /\bcompleted\b/i);
    assert.match(presentation, /without a terminal report/i);
  });

  it("still admits a resumed run that writes a new terminal report (watcher lifecycle)", async () => {
    const dir = createDir();
    // Entry 0 is the old run's report; the resumed run writes a new one.
    const result = await runWatcher(dir, {
      entries: [REPORT_TEXT_ASSISTANT, REPORT_ARG_ASSISTANT],
      resumeFromEntryCount: 1,
    });
    assert.equal(result.failureKind, undefined);
    assert.equal(result.summary, "Report via arg");
  });

  it("classifies a resume whose only new assistant turn has no report as reportless", () => {
    const { failureKind, summary } = classify([REPORTLESS_ASSISTANT], { exitCode: 0 });
    assert.equal(failureKind, "reportless");
    assert.equal(summary, REPORTLESS_COMPLETION_SUMMARY);
    const presentation = testApi.resolveResultPresentation(
      { summary, exitCode: 0, elapsed: 3, failureKind, sessionFile: "/tmp/child.jsonl" },
      "general",
    );
    assert.doesNotMatch(presentation, /\bcompleted\b/i);
  });

  it("still admits a resume that writes a new terminal report", () => {
    const { failureKind, summary } = classify([REPORT_TEXT_ASSISTANT], { exitCode: 0 });
    assert.notEqual(failureKind, "reportless");
    assert.equal(summary, "Task complete: wrote the report.");
    const presentation = testApi.resolveResultPresentation(
      { summary, exitCode: 0, elapsed: 3, failureKind, sessionFile: "/tmp/child.jsonl" },
      "general",
    );
    assert.match(presentation, /completed \(3s\)\.\n\nTask complete: wrote the report\./);
  });

  it("preserves a watcher-assigned lifecycle kind on a resumed run", () => {
    const { failureKind } = classify([], { exitCode: 130, failureKind: "interrupted" });
    assert.equal(failureKind, "interrupted");
  });

  it("keeps the exit-code summary for a resumed run that exits non-zero", () => {
    const { failureKind, summary } = classify([], { exitCode: 7 });
    assert.equal(failureKind, "no-result");
    assert.equal(summary, "Resumed session exited with code 7");
  });
});

/**
 * TASK-337 gap 2 — external-harness driver path.
 *
 * The `driver.extractResult` branch admitted `completed` on exit 0 without
 * re-checking a terminal report. Every non-Pi driver synthesizes its summary
 * through `extractPaneSummary`, whose fallback names the absence rather than
 * returning "" — but that synthesized literal is the ABSENCE NAMED, not
 * substantive evidence. The admission boundary now treats the synthesized
 * literal as null evidence and reuses the Pi reportless rule, so a genuinely
 * silent external run classifies `reportless` instead of `completed`.
 *
 * These fixtures drive the REAL driver extractResult through the REAL
 * `watchSubagent` admission boundary (with the pane read pinned empty) for
 * every registered external driver, keep the assertion that the absence text
 * is still synthesized, and add the positive control that real pane content at
 * exit 0 is still admitted `completed`.
 */
describe("TASK-337 gap 2: external drivers treat a synthesized pane absence as reportless", () => {
  const externalDrivers = [
    { cli: "claude", name: "Claude Code" },
    { cli: "opencode", name: "OpenCode" },
    { cli: "codex", name: "Codex" },
    { cli: "grok", name: "Grok" },
    { cli: "aider", name: "aider" },
  ];

  /** Register a driver whose real extractResult reads a pinned pane text. */
  function registerPaneDriver(cli: string, paneText: string): string {
    const real = getHarnessDriver(cli);
    const id = `t337-pane-${cli}`;
    registerHarnessDriver({
      id,
      name: real.name,
      extractResult: (ctx: any) => real.extractResult!({ ...ctx, readPane: () => paneText }),
    } as any);
    return id;
  }

  async function runDriverWatcher(dir: string, cli: string) {
    const sessionFile = join(dir, "driver-child.jsonl");
    writeFileSync(sessionFile, "");
    writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
    const startTime = Date.now() - 3_000;
    return await testApi.watchSubagent(
      {
        id: "t337-driver",
        name: "general",
        task: "t337",
        surface: "pane-t337-driver",
        startTime,
        sessionFile,
        cli,
        interactive: false,
        lifecycle: createLifecycle(startTime),
      },
      new AbortController().signal,
    );
  }

  for (const { cli, name } of externalDrivers) {
    it(`${cli}: exit-0 with an empty pane classifies reportless, not completed`, async () => {
      // The driver's own extractResult still synthesizes the absence literal
      // (used for non-zero exits and display), never an empty string.
      const driver = getHarnessDriver(cli);
      assert.ok(driver.extractResult, `${cli} driver must expose extractResult`);
      const extracted = await driver.extractResult!({
        running: {
          id: "g2",
          name: "general",
          task: "g2",
          surface: "pane-g2",
          startTime: Date.now(),
          sessionFile: "n/a",
          interactive: false,
        },
        completionResult: { reason: "done", exitCode: 0 },
        surface: "pane-g2",
        readPane: () => "",
        closePane: () => {},
        artifactDir: "/tmp",
      });
      assert.ok(extracted, "extractResult must return a result object, not null");
      assert.notEqual(extracted.summary.trim(), "", "summary must never be empty");
      assert.equal(extracted.summary, `${name} exited without output`);

      // Through the real admission boundary that literal is null evidence.
      const id = registerPaneDriver(cli, "");
      const dir = createDir();
      const result = await runDriverWatcher(dir, id);
      const presentation = testApi.resolveResultPresentation(result, "general");
      assert.equal(result.failureKind, "reportless");
      assert.doesNotMatch(presentation, /\bcompleted\b/i);
      assert.match(presentation, /without a terminal report/i);
      // The absence text is still named in the admitted summary.
      assert.match(result.summary, /no terminal report/i);
      assert.match(result.summary, /exited without output/);
    });
  }

  it("positive control: non-empty pane content at exit 0 is still admitted completed", async () => {
    const id = registerPaneDriver("claude", "Task complete: real pane report");
    const dir = createDir();
    const result = await runDriverWatcher(dir, id);
    assert.equal(result.failureKind, undefined);
    assert.equal(result.summary, "Task complete: real pane report");
    const presentation = testApi.resolveResultPresentation(result, "general");
    assert.match(presentation, /completed \(3s\)\.\n\nTask complete: real pane report/);
  });
});
