import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import subagentsExtension, { __test__ as subagentsTest } from "../pi-extension/subagents/index.ts";
import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";

const originalEnv = new Map([
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
  "PATH",
  "PI_CODING_AGENT_DIR",
  "PI_SUBAGENT_ID",
  "PI_DENY_TOOLS",
  "PI_SUBAGENT_SHELL_READY_DELAY_MS",
  "HERDR_LOG",
  "HERDR_PANES",
].map((name) => [name, process.env[name]]));
const tempRoots = new Set<string>();

beforeEach(() => {
  delete process.env.PI_SUBAGENT_ID;
  delete process.env.PI_DENY_TOOLS;
});

function restoreEnv(): void {
  for (const [name, value] of originalEnv) {
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
}

afterEach(() => {
  restoreEnv();
  subagentsTest.runningSubagents.clear();
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

function writeJsonl(path: string, entries: object[]): void {
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

function header(id: string, cwd: string, parentSession?: string): object {
  return {
    type: "session",
    version: 3,
    id,
    timestamp: "2026-09-02T00:00:00.000Z",
    cwd,
    ...(parentSession ? { parentSession } : {}),
  };
}

function report(text: string): object {
  return {
    type: "message",
    id: `assistant-${text}`,
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text }],
    },
  };
}

function sidecar(parent: string, parentId: string, child: string, name: string, task: string): void {
  writeFileSync(`${child}.spawn.json`, JSON.stringify({
    allowance: 0,
    parentSessionFile: parent,
    parentSessionId: parentId,
    childSessionFile: child,
    name,
    agent: "worker",
    task,
    launchedAt: "2026-09-02T00:00:00.000Z",
  }), "utf8");
}

function fakeHerdr(root: string, panes: object[]): { bin: string; log: string } {
  const bin = join(root, "bin");
  const command = join(bin, "herdr");
  const log = join(root, "herdr.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(command, `#!/usr/bin/env python3
import json, os, re, shlex, sys
args = sys.argv[1:]
with open(os.environ["HERDR_LOG"], "a", encoding="utf-8") as f:
    f.write(" ".join(args) + "\\n")
if args[:2] == ["pane", "list"]:
    print(json.dumps({"result": {"type": "pane_list", "panes": json.loads(os.environ.get("HERDR_PANES", "[]"))}}))
elif args[:2] == ["pane", "current"]:
    print(json.dumps({"result": {"pane": {"pane_id": "parent-pane", "tab_id": "parent-tab", "workspace_id": "parent-workspace"}}}))
elif args[:2] == ["tab", "create"]:
    print(json.dumps({"result": {"root_pane": {"pane_id": "new-pane-" + str(os.getpid())}}}))
elif args[:2] == ["pane", "get"]:
    print(json.dumps({"result": {"pane": {"pane_id": args[2], "agent_status": "done"}}}))
elif args[:2] in (["pane", "rename"], ["pane", "report-metadata"], ["pane", "close"]):
    pass
elif args[:2] == ["pane", "read"]:
    print("")
elif args[:2] == ["pane", "run"]:
    script = args[3] if len(args) > 3 else ""
    try:
        script_path = shlex.split(script)[1]
        text = open(script_path, encoding="utf-8").read()
        match = re.search(r"PI_SUBAGENT_SESSION='([^']+)'", text)
        if not match:
            match = re.search(r"--session '([^']+)'", text)
        if match:
            session = match.group(1)
            os.makedirs(os.path.dirname(session), exist_ok=True)
            if not os.path.exists(session):
                with open(session, "w", encoding="utf-8") as f:
                    json.dump({"type": "session", "version": 3, "id": "fake-child", "cwd": os.path.dirname(session)}, f)
                    f.write("\\n")
            with open(session, "a", encoding="utf-8") as f:
                json.dump({"type": "message", "id": "fake-report", "message": {"role": "assistant", "stopReason": "stop", "content": [{"type": "text", "text": "restored child report"}]}}, f)
                f.write("\\n")
            with open(session + ".exit", "w", encoding="utf-8") as f:
                json.dump({"type": "done"}, f)
    except Exception as error:
        with open(os.environ["HERDR_LOG"], "a", encoding="utf-8") as f:
            f.write("fake-error:" + repr(error) + "\\n")
`, "utf8");
  chmodSync(command, 0o755);
  writeFileSync(log, "", "utf8");
  process.env.HERDR_LOG = log;
  process.env.HERDR_PANES = JSON.stringify(panes);
  process.env.PATH = `${bin}:${originalEnv.get("PATH") ?? ""}`;
  return { bin, log };
}

function createApi(parentSession: string, entries: object[]) {
  const handlers = new Map<string, Function[]>();
  const tools: any[] = [];
  const messages: any[] = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const append = (entry: object) => {
    entries.push(entry);
    writeFileSync(parentSession, entries.map((value) => JSON.stringify(value)).join("\n") + "\n", "utf8");
  };
  const api = {
    on(event: string, handler: Function) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(tool: any) { tools.push(tool); },
    registerCommand() {},
    registerMessageRenderer() {},
    registerShortcut() {},
    getAllTools() { return []; },
    getThinkingLevel() { return "medium"; },
    sendUserMessage() {},
    sendMessage(message: any) {
      messages.push(message);
      append({
        type: "custom_message",
        id: `custom-${messages.length}`,
        customType: message.customType,
        content: message.content,
        display: message.display,
        details: message.details,
      });
    },
    appendEntry(type: string, data: object) {
      append({ type: "custom", id: `entry-${entries.length}`, customType: type, data });
    },
  } as any;
  return {
    api,
    handlers,
    tools,
    messages,
    notifications,
    ctx: {
      cwd: process.cwd(),
      hasUI: true,
      mode: "tui",
      model: { provider: "fake", id: "parent" },
      modelRegistry: {
        find: (provider: string, id: string) => ({ provider, id, reasoning: true }),
        getAvailable: () => [],
        hasConfiguredAuth: () => true,
      },
      sessionManager: {
        getSessionFile: () => parentSession,
        getSessionId: () => "parent-id",
        getSessionDir: () => process.cwd(),
      },
      ui: {
        notify(message: string, type?: string) { notifications.push({ message, type }); },
        setWidget() {},
      },
    } as any,
  };
}

function contextFor(parent: string, root: string, entries: object[]) {
  const built = createApi(parent, entries);
  built.ctx.cwd = root;
  built.ctx.sessionManager.getSessionDir = () => root;
  return built;
}

describe("F-111.2 restore flow", () => {
  it("injects the startup report, closes only the matching stale pane, resumes children, and is idempotent", async () => {
    const root = mkdtempSync(join(tmpdir(), "f111-flow-"));
    tempRoots.add(root);
    const parent = join(root, "parent.jsonl");
    const entries: object[] = [header("parent-id", root)];
    writeJsonl(parent, entries);
    const stale = join(root, "stale.jsonl");
    const interrupted = join(root, "interrupted.jsonl");
    const undelivered = join(root, "undelivered.jsonl");
    for (const [path, id, name, task] of [
      [stale, "stale-id", "Stale worker", "stale task"],
      [interrupted, "interrupted-id", "Interrupted worker", "interrupted task"],
      [undelivered, "undelivered-id", "Reviewer", "review task"],
    ] as const) {
      writeJsonl(path, [header(id, root, parent)]);
      sidecar(parent, "parent-id", path, name, task);
    }
    writeJsonl(undelivered, [header("undelivered-id", root, parent), report("stored reviewer report")]);
    writeFileSync(`${undelivered}.exit`, JSON.stringify({ type: "done" }), "utf8");

    const { log } = fakeHerdr(root, [
      { pane_id: "stale-pane", agent_session: { kind: "path", value: stale } },
      { pane_id: "crew-pane", agent_session: { kind: "path", value: join(root, "crew.jsonl") } },
    ]);
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
    process.env.HERDR_TAB_ID = "parent-tab";
    process.env.HERDR_WORKSPACE_ID = "parent-workspace";
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    __herdrTest__.clearCommandAvailability();

    const first = contextFor(parent, root, entries);
    subagentsExtension(first.api);
    const start = first.handlers.get("session_start")?.[0];
    assert.ok(start);
    start({}, first.ctx);
    assert.equal(first.messages.length, 1);
    const startupReport = first.messages[0].content as string;
    for (const text of ["Stale worker", "Interrupted worker", "Reviewer", "stored reviewer report", "stale-pane", "completed-undelivered"]) {
      assert.match(startupReport, new RegExp(text.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
    }

    const input = first.handlers.get("input")?.[0];
    assert.ok(input);
    const inputResult = await input({ text: "resume", source: "interactive" }, first.ctx);
    assert.deepEqual(inputResult, { action: "handled" });
    const logText = readFileSync(log, "utf8");
    assert.match(logText, /pane close stale-pane/);
    assert.doesNotMatch(logText, /pane close crew-pane/);
    assert.match(logText, /pane run/);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const delivered = first.messages.filter((message) => message.customType === "subagent_result");
    assert.equal(delivered.length, 2, "both resumed children should auto-deliver results");

    const second = contextFor(parent, root, entries);
    subagentsExtension(second.api);
    const secondStart = second.handlers.get("session_start")?.[0];
    assert.ok(secondStart);
    secondStart({}, second.ctx);
    assert.equal(second.messages.length, 0, "handled children must not be reported on restart");
  });

  it("relaunches a phantom through subagent with its recorded task", async () => {
    const root = mkdtempSync(join(tmpdir(), "f111-phantom-flow-"));
    tempRoots.add(root);
    const parent = join(root, "parent.jsonl");
    const entries: object[] = [header("parent-id", root)];
    writeJsonl(parent, entries);
    const phantom = join(root, "phantom.jsonl");
    sidecar(parent, "parent-id", phantom, "Phantom", "relaunch this exact task");

    const { log } = fakeHerdr(root, []);
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
    process.env.HERDR_TAB_ID = "parent-tab";
    process.env.HERDR_WORKSPACE_ID = "parent-workspace";
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
    __herdrTest__.clearCommandAvailability();

    const built = contextFor(parent, root, entries);
    subagentsExtension(built.api);
    const start = built.handlers.get("session_start")?.[0];
    assert.ok(start);
    start({}, built.ctx);
    assert.match(built.messages[0].content, /relaunch this exact task/);

    const input = built.handlers.get("input")?.[0];
    assert.ok(input);
    assert.deepEqual(await input({ text: "resume", source: "interactive" }, built.ctx), { action: "handled" });
    const scripts = readdirSync(join(root, "artifacts", "parent-id", "subagent-scripts"));
    assert.equal(scripts.length, 1);
    const launchScript = readFileSync(join(root, "artifacts", "parent-id", "subagent-scripts", scripts[0]), "utf8");
    assert.match(launchScript, /Subagent launch script/);
    assert.doesNotMatch(launchScript, /Subagent resume script/);
    const contextFiles = readdirSync(join(root, "artifacts", "parent-id", "context"));
    assert.ok(contextFiles.some((file) => readFileSync(join(root, "artifacts", "parent-id", "context", file), "utf8").includes("relaunch this exact task")));
    assert.match(readFileSync(log, "utf8"), /pane run/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(phantom), false, "the original phantom path is not materialized by resume");
  });
});
