import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import subagentsExtension, { __test__ } from "../../pi-extension/subagents/index.ts";
import { cleanupTestEnv, createTestEnv, getAvailableBackends, shellQuote } from "./harness.ts";

// Real Herdr + real extension watcher/delivery, deterministic Claude stand-in.
// The stand-in stays at an editor after Stop, so a shell-exit sentinel cannot
// hide a broken completion hook. No LLM calls or credentials are needed.
const hook = fileURLToPath(new URL("../../pi-extension/subagents/plugin/hooks/on-stop.sh", import.meta.url));

describe("Claude resumed completion [herdr]", { skip: getAvailableBackends().length === 0 }, () => {
  it("delivers the final result to Pi and closes the child pane", { timeout: 15_000 }, async () => {
    const env = createTestEnv("herdr");
    const originalPath = process.env.PATH;
    const originalDelay = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    const originalCwd = process.cwd();
    const handlers = new Map<string, Function[]>();
    const tools: any[] = [];
    const messages: any[] = [];
    const transcriptName = `${env.workspaceId}-claude-completion-test.jsonl`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const bin = join(env.dir, "bin");
      mkdirSync(bin);
      const realHerdr = process.env.HERDR_BIN_PATH ?? execFileSync("which", ["herdr"], { encoding: "utf8" }).trim();
      // The Herdr server creates login shells from its own environment, not the
      // test process's PATH. Inject the stand-in PATH into the actual launch.
      writeFileSync(join(bin, "herdr"), `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "pane" && args[1] === "run") args[3] = ${JSON.stringify(`export PATH=${shellQuote(`${bin}:${originalPath}`)}; `)} + args[3];
const result = spawnSync(${JSON.stringify(realHerdr)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
      writeFileSync(join(bin, "claude"), `#!${process.execPath}
const { writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const transcript = ${JSON.stringify(join(env.dir, transcriptName))};
writeFileSync(transcript, [
  { type: "user", message: { content: "Historical task" } },
  { type: "user", message: { content: "Resumed task" } },
  { type: "assistant", message: { content: [{ type: "text", text: "RESUMED_COMPLETION_OK" }] } },
].map((entry) => JSON.stringify(entry)).join("\\n"));
const result = spawnSync("bash", [${JSON.stringify(hook)}], {
  input: JSON.stringify({ transcript_path: transcript, last_assistant_message: "RESUMED_COMPLETION_OK" }),
  env: process.env,
});
if (result.status !== 0) process.exit(result.status || 1);
setInterval(() => {}, 60000); // Simulate the Claude TUI remaining open after Stop.
`, { mode: 0o755 });
      writeFileSync(join(env.dir, ".pi", "agents", "test-claude-completion.md"), "---\nname: test-claude-completion\ncli: claude\nauto-exit: true\n---\nComplete the task.\n");
      const sessionFile = join(env.dir, "parent.jsonl");
      writeFileSync(sessionFile, "");
      process.env.PATH = `${bin}:${originalPath}`;
      process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "500";
      process.chdir(env.dir);
      const delivered = new Promise<any>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Claude Stop completion was not delivered to Pi")), 10_000);
        subagentsExtension({
          on(event: string, handler: Function) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
          registerTool(tool: any) { tools.push(tool); },
          registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
          getThinkingLevel() { return "medium"; },
          sendMessage(message: any, options: any) {
            messages.push({ message, options });
            if (message.customType === "subagent_result") resolve({ message, options });
          },
        } as any);
      });
      const model = { provider: "test", id: "model", reasoning: true };
      const ctx = {
        cwd: env.dir,
        model,
        modelRegistry: { find: (provider: string, id: string) => provider === "test" && id === "model" ? model : undefined, getAvailable: () => [model], hasConfiguredAuth: () => true },
        sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => env.workspaceId, getSessionDir: () => env.dir },
        hasUI: false,
        ui: { setWidget() {} },
      };
      for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
      const tool = tools.find((entry) => entry.name === "subagent");
      assert.ok(tool);
      await tool.execute("test-launch", {
        name: "Claude completion regression",
        agent: "test-claude-completion",
        model: "test/model",
        cwd: env.dir,
        task: "Finish the resumed task",
        resumeSessionId: "historical-session",
      }, new AbortController().signal, undefined, ctx);
      const child = [...__test__.runningSubagents.values()][0];
      assert.ok(child, "the async launch must initially be registered");
      const result = await delivered;
      assert.equal(result.message.details.exitCode, 0);
      assert.match(result.message.content, /RESUMED_COMPLETION_OK/);
      assert.deepEqual(result.options, { triggerTurn: true, deliverAs: "steer" });
      assert.equal(messages.filter((entry) => entry.message.customType === "subagent_result").length, 1);
      assert.equal(__test__.runningSubagents.size, 0);
      assert.throws(() => execFileSync("herdr", ["pane", "get", child.surface], { encoding: "utf8", stdio: "pipe" }), /Command failed/);
    } finally {
      if (timer) clearTimeout(timer);
      for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, {});
      process.chdir(originalCwd);
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalDelay === undefined) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = originalDelay;
      rmSync(join(process.env.HOME ?? "/tmp", ".pi", "agent", "sessions", "claude-code", transcriptName), { force: true });
      cleanupTestEnv(env);
    }
  });
});
