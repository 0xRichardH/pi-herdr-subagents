import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverOrphanedSubagents,
  formatOrphanRestoreReport,
  isRestorableOrphan,
  resumeOrphanedSubagents,
  type DiscoveredOrphan,
} from "../pi-extension/subagents/orphan-discovery.ts";
import { __test__ as subagentsTest } from "../pi-extension/subagents/index.ts";

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "f111-orphan-"));
}

function writeJsonl(path: string, entries: object[]): void {
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
}

function childHeader(parentSession: string, id: string) {
  return { type: "session", version: 3, id, timestamp: "2026-09-02T00:00:00.000Z", parentSession };
}

function spawnSidecar(parentSession: string, parentId: string, childSession: string, name: string, task: string) {
  writeFileSync(`${childSession}.spawn.json`, JSON.stringify({
    allowance: 2,
    parentSessionFile: parentSession,
    parentSessionId: parentId,
    childSessionFile: childSession,
    name,
    agent: "worker",
    task,
    launchedAt: "2026-09-02T00:00:00.000Z",
  }), "utf8");
}

function childReport(text: string) {
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

describe("F-111.1 orphan discovery", () => {
  it("deduplicates all disk sources and classifies the five-state matrix", () => {
    const root = fixtureDir();
    try {
      const parent = join(root, "parent.jsonl");
      writeJsonl(parent, [{ type: "session", version: 3, id: "parent-id", cwd: root }]);

      const delivered = join(root, "delivered.jsonl");
      writeJsonl(delivered, [childHeader(parent, "delivered-id"), childReport("delivered report")]);
      spawnSidecar(parent, "parent-id", delivered, "Delivered", "already delivered task");
      writeJsonl(parent, [{
        type: "session", version: 3, id: "parent-id", cwd: root,
      }, {
        type: "custom_message",
        customType: "subagent_result",
        content: "Subagent completed",
        details: { sessionFile: delivered },
      }]);

      const undelivered = join(root, "undelivered.jsonl");
      writeJsonl(undelivered, [childHeader(parent, "undelivered-id"), childReport("stored final report")]);
      writeFileSync(`${undelivered}.exit`, JSON.stringify({ type: "done" }), "utf8");
      spawnSidecar(parent, "parent-id", undelivered, "Undelivered", "report task");

      const interrupted = join(root, "interrupted.jsonl");
      writeJsonl(interrupted, [childHeader(parent, "interrupted-id"), {
        type: "message",
        id: "user-interrupted",
        message: { role: "user", content: [{ type: "text", text: "start work" }] },
      }]);
      spawnSidecar(parent, "parent-id", interrupted, "Interrupted", "resume task");

      const phantom = join(root, "phantom.jsonl");
      spawnSidecar(parent, "parent-id", phantom, "Phantom", "relaunch task");

      const stale = join(root, "stale.jsonl");
      writeJsonl(stale, [childHeader(parent, "stale-id"), {
        type: "message",
        id: "user-stale",
        message: { role: "user", content: [{ type: "text", text: "start stale" }] },
      }]);
      spawnSidecar(parent, "parent-id", stale, "Stale", "stale task");

      const found = discoverOrphanedSubagents(parent, {
        paneSessions: [{ paneId: "pane-stale", sessionPath: stale }],
      });
      assert.equal(found.length, 5);
      const byName = new Map(found.map((child) => [child.name, child]));
      assert.equal(byName.get("Delivered")?.classification, "completed-delivered");
      assert.equal(byName.get("Undelivered")?.classification, "completed-undelivered");
      assert.equal(byName.get("Undelivered")?.report, "stored final report");
      assert.equal(byName.get("Interrupted")?.classification, "interrupted");
      assert.equal(byName.get("Phantom")?.classification, "phantom");
      assert.equal(byName.get("Stale")?.classification, "stale-pane");
      assert.deepEqual(byName.get("Stale")?.stalePaneIds, ["pane-stale"]);
      assert.deepEqual(byName.get("Delivered")?.sources, ["sidecar", "session"]);
      assert.equal(isRestorableOrphan(byName.get("Delivered")!), false);
      assert.equal(isRestorableOrphan(byName.get("Interrupted")!), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not mistake copied fork context for a completed child", () => {
    const root = fixtureDir();
    try {
      const parent = join(root, "parent.jsonl");
      const parentEntries = [
        { type: "session", version: 3, id: "fork-parent", cwd: root },
        { type: "message", id: "parent-user", message: { role: "user", content: [{ type: "text", text: "parent work" }] } },
        { type: "message", id: "parent-assistant", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "parent answer" }] } },
      ];
      writeJsonl(parent, parentEntries);
      const child = join(root, "fork-child.jsonl");
      writeJsonl(child, [childHeader(parent, "fork-child-id"), ...parentEntries.slice(1)]);
      spawnSidecar(parent, "fork-parent", child, "Fork", "fork task");

      const [found] = discoverOrphanedSubagents(parent);
      assert.equal(found.classification, "interrupted");
      assert.equal(found.report, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses artifact launch scripts as a fallback and recovers task text", () => {
    const root = fixtureDir();
    try {
      const parent = join(root, "parent.jsonl");
      writeJsonl(parent, [{ type: "session", version: 3, id: "artifact-parent", cwd: root }]);
      const child = join(root, "other-sessions", "child.jsonl");
      mkdirSync(join(root, "artifacts", "artifact-parent", "subagent-scripts"), { recursive: true });
      mkdirSync(join(root, "other-sessions"), { recursive: true });
      writeJsonl(child, [childHeader(parent, "artifact-child"), {
        type: "message",
        id: "child-user",
        message: { role: "user", content: [{ type: "text", text: "work" }] },
      }]);
      const taskArtifact = join(root, "artifacts", "artifact-parent", "task.md");
      writeFileSync(taskArtifact, "Recover the child from its durable task artifact", "utf8");
      writeFileSync(
        join(root, "artifacts", "artifact-parent", "subagent-scripts", "worker.sh"),
        `#!/bin/bash\n# Subagent launch script for Worker\n# Session: ${child}\npi @${taskArtifact}\n`,
        "utf8",
      );

      const [found] = discoverOrphanedSubagents(parent);
      assert.equal(found.name, "Worker");
      assert.equal(found.sessionFile, child);
      assert.equal(found.task, "Recover the child from its durable task artifact");
      assert.equal(found.classification, "interrupted");
      assert.ok(found.sources.includes("artifact"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("survives malformed sidecars and truncated session tails conservatively", () => {
    const root = fixtureDir();
    try {
      const parent = join(root, "parent.jsonl");
      writeJsonl(parent, [{ type: "session", version: 3, id: "safe-parent", cwd: root }]);
      const child = join(root, "partial.jsonl");
      writeFileSync(
        child,
        `${JSON.stringify(childHeader(parent, "partial-child"))}\n{"type":"message","id":"partial","message":`,
        "utf8",
      );
      writeFileSync(`${child}.spawn.json`, "{\"parentSessionFile\":", "utf8");

      assert.doesNotThrow(() => discoverOrphanedSubagents(parent));
      const [found] = discoverOrphanedSubagents(parent);
      assert.equal(found.classification, "interrupted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes enriched spawn metadata atomically without leaving temp files", () => {
    const root = fixtureDir();
    try {
      const child = join(root, "child.jsonl");
      subagentsTest.writeSpawnMetadata(child, {
        allowance: 0,
        parentSessionFile: join(root, "parent.jsonl"),
        parentSessionId: "parent",
        childSessionFile: child,
        name: "Worker",
        task: "atomic task",
        launchedAt: "2026-09-02T00:00:00.000Z",
      });
      assert.deepEqual(JSON.parse(readFileSync(`${child}.spawn.json`, "utf8")), {
        allowance: 0,
        parentSessionFile: join(root, "parent.jsonl"),
        parentSessionId: "parent",
        childSessionFile: child,
        name: "Worker",
        task: "atomic task",
        launchedAt: "2026-09-02T00:00:00.000Z",
      });
      assert.deepEqual(readdirSync(root).filter((name) => name.endsWith(".tmp")), []);
      assert.equal(existsSync(`${child}.spawn.json`), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("F-111.2 restore orchestration primitives", () => {
  function child(classification: DiscoveredOrphan["classification"], paneIds: string[] = []): DiscoveredOrphan {
    return {
      sessionFile: `/sessions/${classification}.jsonl`,
      name: classification,
      task: `${classification} task`,
      classification,
      stalePaneIds: paneIds,
      handled: false,
      sources: ["sidecar"],
    };
  }

  it("closes only discovered stale panes before resuming, and relaunches phantoms", async () => {
    const calls: string[] = [];
    const outcomes = await resumeOrphanedSubagents([
      child("stale-pane", ["child-pane"]),
      child("interrupted"),
      child("phantom"),
      child("completed-undelivered"),
      { ...child("interrupted"), handled: true },
    ], {
      closePane: (paneId) => calls.push(`close:${paneId}`),
      resume: async (orphan) => { calls.push(`resume:${orphan.name}`); return orphan.sessionFile; },
      relaunch: async (orphan) => { calls.push(`relaunch:${orphan.name}`); return orphan.sessionFile; },
    });

    assert.deepEqual(calls, [
      "close:child-pane",
      "resume:stale-pane",
      "resume:interrupted",
      "relaunch:phantom",
    ]);
    assert.deepEqual(outcomes.map((outcome) => [outcome.action, outcome.ok]), [
      ["resume", true],
      ["resume", true],
      ["relaunch", true],
    ]);
  });

  it("formats a passive startup report with the restore contract and stored report", () => {
    const report = formatOrphanRestoreReport([
      { ...child("interrupted"), name: "Worker", agent: "worker", task: "finish the migration" },
      { ...child("completed-undelivered"), name: "Reviewer", task: "review changes", report: "Review is complete." },
      child("completed-delivered"),
    ]);
    assert.match(report, /Worker.*worker.*finish the migration/);
    assert.match(report, /Classification: interrupted/);
    assert.match(report, /Reviewer/);
    assert.match(report, /stored final report/i);
    assert.match(report, /Review is complete\./);
    assert.match(report, /when the user sends "resume"/);
    assert.doesNotMatch(report, /Classification: completed-delivered/);
  });
});
