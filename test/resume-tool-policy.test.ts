import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import register from "../pi-extension/subagents/index.ts";

test("Pi tool policy follows the saved session across repeated resumes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-resume-policy-"));
  const agentDir = join(root, "agent");
  const alias = join(root, "agent-link");
  symlinkSync(agentDir, alias, "dir");
  const observed = join(root, "child-env");
  const previousCwd = process.cwd();
  const fixtureEnv = {
    PI_CODING_AGENT_DIR: alias,
    PI_SUBAGENT_BACKEND: "herdr-core",
    PI_DENY_TOOLS: "",
    PI_SUBAGENT_ID: "",
    PI_SUBAGENT_AGENT: "",
    HC_TERMINAL_ID: "fixture-parent",
    HC_SOCKET: join(root, "core.sock"),
    PATH: `${root}:/usr/bin:/bin`,
    POLICY_LOG: observed,
  };
  const previous = Object.keys(fixtureEnv).map(key => [key, process.env[key]] as const);
  Object.assign(process.env, fixtureEnv);
  process.chdir(root);
  t.after(() => {
    process.chdir(previousCwd);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  writeFileSync(join(root, "hc"), `#!/bin/bash
set -eu
case "$1" in
  run) PI_DENY_TOOLS=fixture_terminal_only bash "\${!#}" > "$POLICY_LOG.run" 2>&1; echo '{"address":"fixture-child","state":"live"}' ;;
  get) echo '{"address":"fixture-child","state":"finished"}' ;;
  --version|ls|rm) exit 0 ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
  writeFileSync(join(root, "pi"), `#!/bin/sh
set -eu
printf '%s\\n' "\${PI_DENY_TOOLS-}" >> "$POLICY_LOG"
printf '%s\\n' "$PI_SUBAGENT_SESSION" >> "$POLICY_LOG.sessions"
allowlist=default
while [ "$#" -gt 0 ]; do
  if [ "$1" = --tools ]; then allowlist=$2; break; fi
  shift
done
printf '%s\\n' "$allowlist" >> "$POLICY_LOG.tools"
printf '{"type":"done"}' > "$PI_SUBAGENT_SESSION.exit"
`, { mode: 0o700 });

  const definitions = join(agentDir, "agents");
  mkdirSync(definitions, { recursive: true });
  const agent = join(definitions, "policy-fixture.md");
  writeFileSync(agent, "---\nname: policy-fixture\nsession-mode: lineage-only\ntools: read\ndeny-tools: fixture_read, fixture_write\n---\n");
  const parent = join(root, "parent.jsonl");
  writeFileSync(parent, '{"type":"session","version":3,"id":"parent"}\n');
  const ctx = {
    cwd: root,
    model: { provider: "fixture", id: "fixture" },
    modelRegistry: { find: () => null },
    sessionManager: { getSessionFile: () => parent, getSessionDir: () => root, getSessionId: () => "parent" },
  };
  const tools = new Map();
  let shutdown = () => {};
  const api = {
    registerTool(tool) { tools.set(tool.name, tool); },
    on(event, handler) { if (event === "session_shutdown") shutdown = () => handler({ reason: "quit" }); },
    getThinkingLevel: () => "off", registerCommand() {}, registerMessageRenderer() {}, sendMessage() {},
  };
  register(api as any);
  t.after(() => shutdown());
  const call = (name: string, params: object) => tools.get(name).execute("fixture", params, undefined, undefined, ctx);
  const first = await call("subagent", { name: "First", agent: "policy-fixture", task: "fixture" });
  const sessionPath = first.details.sessionFile;
  assert.ok(sessionPath);
  assert.ok(sessionPath.startsWith(`${agentDir}/sessions/`), "spawn returns the physical session path");
  assert.equal(readFileSync(`${observed}.run`, "utf8").trim(), "__SUBAGENT_DONE_0__");
  const override = await call("subagent", { name: "Override", agent: "policy-fixture", tools: "bash", task: "fixture" });
  rmSync(agent);
  shutdown();
  tools.clear();
  register(api as any);
  for (const path of [sessionPath, relative(root, sessionPath), join(alias, relative(agentDir, sessionPath))]) {
    const resumed = await call("subagent_resume", { name: "Renamed", sessionPath: path });
    assert.equal(resumed.details.status, "started");
  }
  const launches = () => readFileSync(observed, "utf8").split("\n").slice(0, -1)
    .map(line => line.split(",").filter(Boolean).sort());
  assert.deepEqual(launches(), Array(5).fill(["fixture_read", "fixture_write"]));
  assert.deepEqual(readFileSync(`${observed}.sessions`, "utf8").trimEnd().split("\n"), [sessionPath, override.details.sessionFile, sessionPath, sessionPath, sessionPath]);
  assert.equal((await call("subagent_resume", { sessionPath: override.details.sessionFile })).details.status, "started");
  const allowlists = () => readFileSync(`${observed}.tools`, "utf8").trimEnd().split("\n");
  const readOnly = "read,caller_ping,subagent_done";
  const bashOnly = "bash,caller_ping,subagent_done";
  assert.deepEqual(allowlists(), [readOnly, bashOnly, readOnly, readOnly, readOnly, bashOnly]);

  async function assertPolicyError(path: string) {
    const before = launches();
    const result = await call("subagent_resume", { sessionPath: path });
    assert.ok(result.details.error);
    assert.match(result.content[0].text, /policy/i);
    assert.deepEqual(launches(), before, "policy error must stop before a terminal is launched");
  }
  await assertPolicyError(parent);

  const unrestricted = await call("subagent", { name: "Unrestricted", task: "fixture", fork: true });
  assert.ok(unrestricted.details.sessionFile);
  const resumed = await call("subagent_resume", { sessionPath: unrestricted.details.sessionFile });
  assert.equal(resumed.details.status, "started");
  assert.deepEqual(launches().slice(-2), [[], []]);
  assert.deepEqual(allowlists().slice(-2), ["default", "default"]);

  process.env.PI_SUBAGENT_ID = "fixture-caller";
  process.env.PI_DENY_TOOLS = "fixture_current";
  const nested = await call("subagent_resume", { sessionPath });
  assert.equal(nested.details.status, "started");
  assert.deepEqual(launches().at(-1), ["fixture_current", "fixture_read", "fixture_write"]);

  writeFileSync(`${sessionPath}.tool-policy.json`, "{");
  await assertPolicyError(sessionPath);
  writeFileSync(`${sessionPath}.tool-policy.json`, JSON.stringify({ version: 1, sessionPath, denyTools: [] }));
  await assertPolicyError(sessionPath);
  writeFileSync(`${sessionPath}.tool-policy.json`, JSON.stringify({ version: 2, sessionPath, denyTools: [] }));
  await assertPolicyError(sessionPath);
});
