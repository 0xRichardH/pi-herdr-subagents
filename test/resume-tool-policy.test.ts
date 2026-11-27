import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import register from "../pi-extension/subagents/index.ts";

test("Pi tool policy follows the saved session across repeated resumes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-resume-policy-"));
  const agentDir = join(root, "agent");
  const observed = join(root, "child-env");
  const fixtureEnv = {
    PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENT_BACKEND: "herdr-core", PI_DENY_TOOLS: "",
    PI_SUBAGENT_ID: "", PI_SUBAGENT_AGENT: "", HC_TERMINAL_ID: "fixture-parent",
    HC_SOCKET: join(root, "core.sock"), PATH: `${root}:/usr/bin:/bin`, POLICY_LOG: observed,
  };
  const previous = Object.keys(fixtureEnv).map(key => [key, process.env[key]] as const);
  Object.assign(process.env, fixtureEnv);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  writeFileSync(join(root, "hc"), `#!/bin/bash
set -eu
case "$1" in
  run) bash "\${!#}" > "$POLICY_LOG.run" 2>&1; echo '{"address":"fixture-child","state":"live"}' ;;
  get) echo '{"address":"fixture-child","state":"finished"}' ;;
  --version|ls|rm) exit 0 ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
  writeFileSync(join(root, "pi"), `#!/bin/sh
set -eu
printf '%s\\n' "\${PI_DENY_TOOLS-}" >> "$POLICY_LOG"
printf '{"type":"done"}' > "$PI_SUBAGENT_SESSION.exit"
`, { mode: 0o700 });

  const definitions = join(agentDir, "agents");
  mkdirSync(definitions, { recursive: true });
  const agent = join(definitions, "policy-fixture.md");
  writeFileSync(agent, "---\nname: policy-fixture\nsession-mode: lineage-only\ndeny-tools: fixture_read, fixture_write\n---\n");
  const parent = join(root, "parent.jsonl");
  writeFileSync(parent, '{"type":"session","version":3,"id":"parent"}\n');
  const ctx = {
    cwd: root, model: { provider: "fixture", id: "fixture" }, modelRegistry: { find: () => null },
    sessionManager: { getSessionFile: () => parent, getSessionDir: () => root, getSessionId: () => "parent" },
  };
  const tools = new Map();
  let shutdown = () => {};
  register({
    registerTool(tool) { tools.set(tool.name, tool); },
    on(event, handler) { if (event === "session_shutdown") shutdown = () => handler({ reason: "quit" }); },
    getThinkingLevel: () => "off", registerCommand() {}, registerMessageRenderer() {}, sendMessage() {},
  } as any);
  t.after(() => shutdown());
  const call = (name: string, params: object) => tools.get(name).execute("fixture", params, undefined, undefined, ctx);
  const first = await call("subagent", { name: "First", agent: "policy-fixture", task: "fixture" });
  const sessionPath = first.details.sessionFile;
  assert.ok(sessionPath);
  assert.equal(readFileSync(`${observed}.run`, "utf8").trim(), "__SUBAGENT_DONE_0__");
  rmSync(agent);
  for (const name of ["Renamed", "Again"]) {
    const resumed = await call("subagent_resume", { name, sessionPath });
    assert.equal(resumed.details.status, "started");
  }
  const lists = readFileSync(observed, "utf8").split("\n").slice(0, -1);
  assert.deepEqual(lists, Array(3).fill("fixture_read,fixture_write"));
});
