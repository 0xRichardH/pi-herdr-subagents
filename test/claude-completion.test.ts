import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { waitForCompletion } from "../pi-extension/subagents/completion.ts";
import { ClaudeHarnessDriver } from "../pi-extension/subagents/harness/drivers/claude.ts";

const hook = fileURLToPath(new URL("../pi-extension/subagents/plugin/hooks/on-stop.sh", import.meta.url));
const user = (content: unknown) => ({ type: "user", message: { role: "user", content } });
const assistant = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });

function fixture(entries: unknown[], run: (paths: { dir: string; sentinel: string; transcript: string }) => void) {
  const dir = mkdtempSync(join(tmpdir(), "claude-completion-"));
  const transcript = join(dir, "transcript.jsonl");
  writeFileSync(transcript, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  try {
    run({ dir, sentinel: join(dir, "done"), transcript });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runHook(sentinel: string | undefined, payload: unknown, autoExit: string | undefined = "1") {
  const env = { ...process.env };
  delete env.PI_CLAUDE_SENTINEL;
  delete env.PI_CLAUDE_AUTO_EXIT;
  if (sentinel !== undefined) env.PI_CLAUDE_SENTINEL = sentinel;
  if (autoExit !== undefined) env.PI_CLAUDE_AUTO_EXIT = autoExit;
  const result = spawnSync("bash", [hook], { input: JSON.stringify(payload), env, encoding: "utf8", timeout: 5_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
}

describe("Claude Stop completion hook", () => {
  for (const [name, entries] of [
    ["a fresh autonomous session", [user("Initial task"), assistant("Finished")]],
    ["a resumed session with historical user messages", [user("Old task"), assistant("Old result"), user("Follow-up"), assistant("Finished")]],
    ["an autonomous session after additional user input", [user("Initial task"), user("Extra detail"), assistant("Finished")]],
    ["array-form human content and tool results", [user([{ type: "text", text: "Task" }]), user([{ type: "tool_result", content: "output" }]), assistant("Finished")]],
  ] as const) {
    it(`publishes the final result for ${name}`, () => {
      fixture([...entries], ({ dir, sentinel, transcript }) => {
        runHook(sentinel, { transcript_path: transcript, last_assistant_message: "Finished ✓\nAll tests pass." });
        assert.equal(readFileSync(sentinel, "utf8").trim(), "Finished ✓\nAll tests pass.");
        assert.equal(readFileSync(`${sentinel}.transcript`, "utf8").trim(), transcript);
        assert.deepEqual(readdirSync(dir).sort(), ["done", "done.transcript", "transcript.jsonl"]);
      });
    });
  }

  it("publishes the hook result even when the transcript is temporarily unavailable", () => {
    fixture([], ({ sentinel, dir }) => {
      runHook(sentinel, { transcript_path: join(dir, "missing.jsonl"), last_assistant_message: "Final result" });
      assert.equal(readFileSync(sentinel, "utf8").trim(), "Final result");
    });
  });

  it("publishes the hook result without a transcript path", () => {
    fixture([], ({ sentinel }) => {
      runHook(sentinel, { last_assistant_message: "Final result" });
      assert.equal(readFileSync(sentinel, "utf8").trim(), "Final result");
    });
  });

  it("falls back to the latest assistant text for older Claude hook payloads", () => {
    fixture([user("Task"), assistant("Earlier"), assistant("Final result")], ({ sentinel, transcript }) => {
      runHook(sentinel, { transcript_path: transcript });
      assert.equal(readFileSync(sentinel, "utf8").trim(), "Final result");
    });
  });

  it("tolerates malformed transcript entries during fallback", () => {
    fixture([null, {}, assistant("Final result")], ({ sentinel, transcript }) => {
      writeFileSync(transcript, readFileSync(transcript, "utf8") + '{"unfinished":');
      runHook(sentinel, { transcript_path: transcript });
      assert.equal(readFileSync(sentinel, "utf8").trim(), "Final result");
    });
  });

  it("replaces unpaired Unicode surrogates in hook results", () => {
    fixture([], ({ sentinel }) => {
      runHook(sentinel, { last_assistant_message: "Finished \ud800" });
      assert.equal(readFileSync(sentinel, "utf8"), "Finished ?");
    });
  });

  it("replaces unpaired Unicode surrogates in fallback transcript text", () => {
    fixture([assistant("Finished \ud800")], ({ sentinel, transcript }) => {
      runHook(sentinel, { transcript_path: transcript });
      assert.equal(readFileSync(sentinel, "utf8"), "Finished ?");
    });
  });

  it("does not lose completion for an invalid-Unicode optional transcript path", () => {
    fixture([], ({ sentinel }) => {
      runHook(sentinel, { transcript_path: "invalid-\ud800.jsonl", last_assistant_message: "Finished" });
      assert.equal(readFileSync(sentinel, "utf8"), "Finished");
    });
  });

  it("finds the final response in a large resumed transcript", () => {
    fixture([user("history".repeat(1_000_000)), assistant("Final result")], ({ sentinel, transcript }) => {
      runHook(sentinel, { transcript_path: transcript });
      assert.equal(readFileSync(sentinel, "utf8"), "Final result");
    });
  });

  it("still completes when the final transcript record exceeds the fallback bound", () => {
    fixture([assistant("huge".repeat(1_100_000))], ({ sentinel, transcript }) => {
      runHook(sentinel, { transcript_path: transcript });
      assert.ok(existsSync(sentinel));
    });
  });

  it("does not strand completion when neither summary source is available", () => {
    fixture([], ({ sentinel }) => {
      runHook(sentinel, {});
      assert.ok(existsSync(sentinel));
    });
  });

  it("keeps explicitly non-auto-exit sessions open but records their transcript", () => {
    fixture([user("Task"), assistant("Final result")], ({ sentinel, transcript }) => {
      runHook(sentinel, { transcript_path: transcript, last_assistant_message: "Final result" }, "0");
      assert.equal(existsSync(sentinel), false);
      assert.equal(readFileSync(`${sentinel}.transcript`, "utf8").trim(), transcript);
    });
  });

  it("ignores recursive Stop hooks", () => {
    fixture([user("Task")], ({ sentinel, transcript }) => {
      runHook(sentinel, { stop_hook_active: true, transcript_path: transcript, last_assistant_message: "Not settled" });
      assert.equal(existsSync(sentinel), false);
    });
  });

  it("does not act outside a Pi-spawned session", () => {
    fixture([user("Task")], ({ sentinel, transcript }) => {
      runHook(undefined, { transcript_path: transcript, last_assistant_message: "Result" });
      assert.equal(existsSync(sentinel), false);
    });
  });

  it("supports existing launch scripts without the new auto-exit flag", () => {
    fixture([user("Old task"), user("Follow-up")], ({ sentinel, transcript }) => {
      runHook(sentinel, { transcript_path: transcript, last_assistant_message: "Result" }, undefined);
      assert.equal(readFileSync(sentinel, "utf8").trim(), "Result");
    });
  });

  it("lets the watcher extract a complete resumed result without terminal output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-handoff-"));
    const sentinel = join(dir, "done");
    const transcript = join(dir, `${basename(dir)}.jsonl`);
    writeFileSync(transcript, [user("Old task"), user("Follow-up"), assistant("Completed follow-up")].map((entry) => JSON.stringify(entry)).join("\n"));
    try {
      runHook(sentinel, { transcript_path: transcript, last_assistant_message: "Completed follow-up" });
      const completion = await waitForCompletion(AbortSignal.timeout(2_000), {
        intervalMs: 5,
        sentinelFile: sentinel,
        readTerminalTail: async () => { throw new Error("No terminal output available"); },
      });
      assert.deepEqual(completion, { reason: "sentinel", exitCode: 0 });
      const driver = new ClaudeHarnessDriver();
      const result = await driver.extractResult({
        running: { id: "test", name: "test", task: "Follow-up", surface: "test-pane", startTime: Date.now(), sessionFile: join(dir, "unused.jsonl"), interactive: false, sentinelFile: sentinel },
        completionResult: completion,
        surface: "test-pane",
        readPane: () => { throw new Error("Must not fall back to the pane"); },
        closePane: () => {},
        artifactDir: dir,
      });
      assert.equal(result?.summary, "Completed follow-up");
      assert.equal(existsSync(sentinel), false);
      assert.equal(existsSync(`${sentinel}.transcript`), false);
      assert.equal(result?.sessionId, basename(transcript));
    } finally {
      rmSync(join(process.env.HOME ?? "/tmp", ".pi", "agent", "sessions", "claude-code", basename(transcript)), { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
