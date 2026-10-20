import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import subagentDoneExtension, {
  resolveAutoExit,
} from "../pi-extension/subagents/subagent-done.ts";

// L-95 — auto-exit hardening: operator input / Escape permanently disarms,
// /auto-exit re-arms for exactly one completion. Child-side only.

interface Notification {
  message: string;
  type?: string;
}

function createExtensionApi() {
  const eventHandlers = new Map<string, Array<Function>>();
  const registeredCommands: Array<{ name: string; handler: Function }> = [];
  return {
    eventHandlers,
    registeredCommands,
    api: {
      on(event: string, handler: Function) {
        const handlers = eventHandlers.get(event) ?? [];
        handlers.push(handler);
        eventHandlers.set(event, handlers);
      },
      registerTool() {},
      registerCommand(name: string, command: any) {
        registeredCommands.push({ name, ...command });
      },
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

const origAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
const origSession = process.env.PI_SUBAGENT_SESSION;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("subagent-done auto-exit hardening (L-95)", () => {
  let dir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "l95-autoexit-"));
  });

  afterEach(() => {
    restoreEnv("PI_SUBAGENT_AUTO_EXIT", origAutoExit);
    restoreEnv("PI_SUBAGENT_SESSION", origSession);
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function boot(opts: { autoExit?: boolean; withSessionFile?: boolean } = {}) {
    const autoExit = opts.autoExit ?? true;
    if (autoExit) process.env.PI_SUBAGENT_AUTO_EXIT = "1";
    else delete process.env.PI_SUBAGENT_AUTO_EXIT;

    let sessionFile: string | undefined;
    if (opts.withSessionFile !== false) {
      sessionFile = join(dir!, "child.jsonl");
      process.env.PI_SUBAGENT_SESSION = sessionFile;
    } else {
      delete process.env.PI_SUBAGENT_SESSION;
    }

    const { api, eventHandlers, registeredCommands } = createExtensionApi();
    subagentDoneExtension(api);

    const notifications: Notification[] = [];
    const ctx: any = {
      shutdowns: 0,
      ui: {
        notify(message: string, type?: string) {
          notifications.push({ message, type });
        },
        setWidget() {},
      },
      shutdown() {
        ctx.shutdowns += 1;
      },
    };

    return {
      ctx,
      notifications,
      sessionFile,
      registeredCommands,
      fire(event: string, payload: any = {}) {
        for (const handler of eventHandlers.get(event) ?? []) handler(payload, ctx);
      },
      // agent_end + agent_settled: mirrors how Pi settles a finished turn.
      settle(messages: any[]) {
        this.fire("agent_end", { messages });
        this.fire("agent_settled", { type: "agent_settled" });
      },
      async runCommand(name: string, args = "") {
        const command = registeredCommands.find((c) => c.name === name);
        assert.ok(command, `command /${name} must be registered`);
        await command.handler(args, ctx);
      },
    };
  }

  function sidecarOf(child: ReturnType<typeof boot>): any | null {
    if (!child.sessionFile || !existsSync(`${child.sessionFile}.exit`)) return null;
    return JSON.parse(readFileSync(`${child.sessionFile}.exit`, "utf8"));
  }

  describe("resolveAutoExit decision table", () => {
    // [disarmed, oneShotReArm, stopReason, expected]
    const cases: Array<[boolean, boolean, string | undefined, boolean]> = [
      // Armed (never disarmed): identical to v0.2.0 — terminal stop or error
      // exits, aborted stays open.
      [false, false, "stop", true],
      [false, false, "error", true],
      [false, false, "aborted", false],
      [false, false, undefined, true],
      // Disarmed: never exits, whatever happened.
      [true, false, "stop", false],
      [true, false, "error", false],
      [true, false, "aborted", false],
      [true, false, undefined, false],
      // One-shot re-arm via /auto-exit: one more terminal stop or error may
      // exit; an aborted turn still stays open.
      [true, true, "stop", true],
      [true, true, "error", true],
      [true, true, "aborted", false],
      // Re-arm while armed cannot occur via CLI but is harmless.
      [false, true, "stop", true],
    ];

    for (const [disarmed, reArm, reason, expected] of cases) {
      it(`disarmed=${disarmed} reArm=${reArm} stop=${reason} -> ${expected}`, () => {
        assert.equal(resolveAutoExit({ disarmed, oneShotReArm: reArm }, reason), expected);
      });
    }
  });

  it("ignores the initial task input before the first agent run", () => {
    const child = boot();
    child.fire("input", { type: "input", text: "do the whole task" });
    child.settle([{ role: "assistant", stopReason: "stop" }]);
    assert.equal(child.ctx.shutdowns, 1, "zero-real-input child still exits");
    assert.deepEqual(sidecarOf(child), { type: "done" });
    assert.equal(child.notifications.length, 0, "no warning for the injected task");
  });

  it("operator input disarms auto-exit persistently across settled turns", () => {
    const child = boot();
    child.fire("agent_start", {});
    child.fire("input", { type: "input", text: "hold on, steer this way" });
    for (let i = 0; i < 3; i++) {
      child.settle([{ role: "assistant", stopReason: "stop" }]);
    }
    assert.equal(child.ctx.shutdowns, 0, "disarm survives settled turns (no reset)");
    assert.equal(sidecarOf(child), null, "no done sidecar after disarm");
  });

  it("warns exactly once when input first disarms auto-exit", () => {
    const child = boot();
    child.fire("agent_start", {});
    child.fire("input", { type: "input", text: "first takeover" });
    child.fire("input", { type: "input", text: "second takeover" });
    child.fire("input", { type: "input", text: "third takeover" });
    child.settle([{ role: "assistant", stopReason: "aborted" }]);
    const warnings = child.notifications.filter((n) => n.type === "warning");
    assert.equal(warnings.length, 1, "exactly one warning despite repeated inputs");
    assert.match(warnings[0].message, /auto-exit/i);
  });

  it("Escape-triggered abort disarms auto-exit and keeps the session open", () => {
    const child = boot();
    child.settle([{ role: "assistant", stopReason: "aborted" }]);
    assert.equal(child.ctx.shutdowns, 0, "aborted run does not exit");
    assert.equal(
      child.notifications.filter((n) => n.type === "warning").length,
      1,
      "one takeover warning for the Escape abort",
    );
    // Session stays open and disarmed: a later normal completion must not exit.
    child.settle([{ role: "assistant", stopReason: "stop" }]);
    assert.equal(child.ctx.shutdowns, 0);
  });

  it("/auto-exit re-arms for exactly one completion, then disarms again", async () => {
    const child = boot();
    child.fire("agent_start", {});
    child.fire("input", { type: "input", text: "taking over" });
    child.settle([{ role: "assistant", stopReason: "stop" }]);
    assert.equal(child.ctx.shutdowns, 0);

    // Double invocation must not stack two completions.
    await child.runCommand("auto-exit");
    await child.runCommand("auto-exit");

    child.settle([{ role: "assistant", stopReason: "stop" }]);
    assert.equal(child.ctx.shutdowns, 1, "re-armed child exits on next completion");
    assert.deepEqual(sidecarOf(child), { type: "done" }, "done sidecar written");

    // One-shot consumed: another settled completion does not exit again.
    child.settle([{ role: "assistant", stopReason: "stop" }]);
    assert.equal(child.ctx.shutdowns, 1, "auto-exit is disarmed again after one-shot exit");
  });

  it("/auto-exit is a no-op while auto-exit is still armed", async () => {
    const child = boot();
    await child.runCommand("auto-exit");
    child.settle([{ role: "assistant", stopReason: "stop" }]);
    assert.equal(child.ctx.shutdowns, 1, "plain armed behavior unchanged");
  });

  it("background regression: zero-input child behaves byte-for-byte like v0.2.0", () => {
    const child = boot();
    child.fire("session_start", {});
    child.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
    assert.equal(child.ctx.shutdowns, 0, "no shutdown before agent_settled");
    assert.equal(existsSync(`${child.sessionFile}.exit`), false);
    child.fire("agent_settled", { type: "agent_settled" });
    assert.equal(child.ctx.shutdowns, 1);
    assert.deepEqual(sidecarOf(child), { type: "done" });
    assert.equal(child.notifications.length, 0, "silent for background children");

    const failing = boot();
    failing.settle([
      { role: "assistant", stopReason: "error", errorMessage: "529 overloaded" },
    ]);
    assert.equal(failing.ctx.shutdowns, 1, "error stopReason still wakes the parent");
    assert.deepEqual(sidecarOf(failing), {
      type: "error",
      errorMessage: "529 overloaded",
      stopReason: "error",
    });
  });

  it("non-auto-exit sessions never warn and ignore /auto-exit state changes", async () => {
    const child = boot({ autoExit: false });
    child.fire("agent_start", {});
    child.fire("input", { type: "input", text: "interactive use" });
    child.settle([{ role: "assistant", stopReason: "stop" }]);
    child.settle([{ role: "assistant", stopReason: "aborted" }]);
    await child.runCommand("auto-exit");
    assert.equal(child.ctx.shutdowns, 0, "interactive child never auto-exits");
    assert.equal(
      child.notifications.filter((n) => n.type === "warning").length,
      0,
      "nothing to disarm, so no takeover warning",
    );
  });
});
