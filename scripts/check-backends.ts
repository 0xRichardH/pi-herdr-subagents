import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const host = args.find((arg) => arg === "herdr-core" || arg === "herdr-tui");
const transportOnly = args.includes("--transport-only");
if (!transportOnly && !process.env.PI_TEST_MODEL) throw new Error("Set PI_TEST_MODEL to an authenticated provider/model for the real Pi checks");
const evidenceArg = args.find((arg) => arg.startsWith("--evidence="))?.slice(11);
const evidence = evidenceArg ? resolve(evidenceArg) : mkdtempSync(join(tmpdir(), "pi-backends-"));
if (existsSync(join(evidence, "ownership.json")) || existsSync(join(evidence, "passed.json"))) throw new Error("Choose a fresh evidence directory");
mkdirSync(evidence, { recursive: true });

if (!host) {
  const failures: Error[] = [];
  for (const backend of ["herdr-tui", "herdr-core"]) {
    try {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url), backend, `--evidence=${join(evidence, backend)}`, ...(transportOnly ? ["--transport-only"] : [])], { stdio: "inherit", env: process.env });
    } catch (error) {
      failures.push(error as Error);
    }
  }
  if (failures.length) throw new AggregateError(failures, `Backend checks failed. Evidence retained at ${evidence}`);
  console.log(`Both backends passed. Evidence retained at ${evidence}`);
} else {
  await checkHost(host);
}

async function checkHost(host: string): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "pi-backend-system-"));
  const timeout = Number(process.env.PI_TEST_TIMEOUT || 180000);
  const model = process.env.PI_TEST_MODEL;
  const owned = new Set<string>();
  const run = (bin: string, argv: string[]) => execFileSync(bin, argv, { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
  const json = (bin: string, argv: string[]) => JSON.parse(run(bin, argv));
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  let coreBin = "hc";
  let coreStarted = false;
  let workspace: { workspace_id: string; label: string } | undefined;
  const label = `pi-system-${Date.now()}-${process.pid}`;
  const coreSocket = join(scratch, "core.sock");
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(check: () => boolean | Promise<boolean>, name: string): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await check()) return;
      await sleep(250);
    }
    throw new Error(`Timed out waiting for ${name}`);
  }
  const state = () => writeFileSync(join(evidence, "ownership.json"), JSON.stringify({ host, scratch, workspace, session: process.env.HC_SESSION, owned: [...owned] }, null, 2));

  try {
    process.env.PI_SUBAGENT_BACKEND = host;
    if (host === "herdr-core") {
      try { run(coreBin, ["--version"]); } catch { coreBin = "herdr-core"; run(coreBin, ["--version"]); }
      delete process.env.HC_TERMINAL_ID;
      process.env.HC_SESSION = label;
      process.env.HC_SOCKET = coreSocket;
      assert(!existsSync(coreSocket));
      for (const [key, path] of Object.entries({ XDG_RUNTIME_DIR: "runtime", XDG_STATE_HOME: "state", XDG_CACHE_HOME: "cache", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data" })) {
        process.env[key] = join(scratch, path);
        mkdirSync(process.env[key]!, { recursive: true, mode: 0o700 });
      }
      run(coreBin, ["server", "start"]);
      coreStarted = true;
      const anchor = json(coreBin, ["run", "--json", "--bg", "--no-notify", "--no-parent", "--label", `system-check=${label}`, "sleep", "3600"]);
      assert.equal(typeof anchor.address, "string");
      owned.add(anchor.address);
      process.env.HC_TERMINAL_ID = anchor.address;
    } else {
      const result = json("herdr", ["workspace", "create", "--cwd", scratch, "--label", label, "--no-focus"]).result;
      workspace = result.workspace;
      process.env.HERDR_ENV = "1";
      process.env.HERDR_WORKSPACE_ID = workspace!.workspace_id;
      process.env.HERDR_PANE_ID = result.root_pane.pane_id;
      delete process.env.HERDR_TAB_ID;
    }
    state();
    const terminal = await import("../pi-extension/subagents/terminal.ts");
    assert.equal(terminal.getTerminalBackend().kind, host);
    assert(terminal.isTerminalAvailable(), `${host} must be reachable`);
    async function launch(name: string, command: string, preamble?: string): Promise<string> {
      const pane = await terminal.launchSubagentTerminal({ name, task: name, command, preamble, cwd: scratch, layout: "right", scriptPath: join(evidence, `${name}.sh`) });
      owned.add(pane);
      state();
      return pane;
    }
    const probeFile = join(scratch, "probe.mjs");
    writeFileSync(probeFile, `process.stdin.setRawMode(true);process.stdin.resume();console.log('PROBE_READY '+process.env.PI_SUBAGENT_BACKEND+' '+process.env.PI_SUBAGENT_SURFACE);let input='';process.stdin.on('data',data=>{input+=data.toString();if(input.includes('production-input')){console.log('INPUT_OK');input='';}if(data.includes(27))console.log('ESC_OK');});\n`);
    const probe = await launch("transport", `${quote(process.execPath)} ${quote(probeFile)}`);
    const screen = () => terminal.readPaneAsync(probe, 100);
    await until(async () => (await screen()).includes(`PROBE_READY ${host} ${probe}`), "production launch and runtime identity");
    const inspection = await terminal.inspectPane(probe);
    assert.equal(inspection.kind, "present");
    terminal.setPaneTask(probe, "Owned system check input and Escape");
    terminal.runInPane(probe, "production-input");
    await until(async () => (await screen()).includes("INPUT_OK"), "production input");
    terminal.interruptPane(probe);
    await until(async () => (await screen()).includes("ESC_OK"), "exact Escape delivery");
    assert(terminal.readPane(probe, 100).includes("INPUT_OK"));
    writeFileSync(join(evidence, "transport.txt"), await screen());
    writeFileSync(join(evidence, "inspection.json"), JSON.stringify(inspection, null, 2));
    terminal.closePane(probe);
    terminal.closePane(probe);
    assert.equal((await terminal.inspectPane(probe)).kind, "missing");
    owned.delete(probe);
    if (host === "herdr-core") {
      const lifetimeFile = join(scratch, "lifetime-child.txt");
      const lifetimeDriver = join(scratch, "lifetime.mjs");
      const lifetimeRequest = { name: "lifetime-child", task: "survive launcher exit", command: "sleep 3600", cwd: scratch, layout: "tab", scriptPath: join(evidence, "lifetime-child.sh") };
      writeFileSync(lifetimeDriver, `import { writeFileSync } from 'node:fs';\nimport { launchSubagentTerminal } from ${JSON.stringify(join(repo, "pi-extension/subagents/terminal.ts"))};\nwriteFileSync(${JSON.stringify(lifetimeFile)}, await launchSubagentTerminal(${JSON.stringify(lifetimeRequest)}));\n`);
      const launcher = await launch("lifetime-parent", `${quote(process.execPath)} ${quote(lifetimeDriver)}`);
      await until(async () => { const record = await terminal.inspectPane(launcher); return existsSync(lifetimeFile) && record.kind === "present" && record.ended === true; }, "core launcher exit");
      const survivor = readFileSync(lifetimeFile, "utf8");
      owned.add(survivor);
      state();
      const survivorRecord = json(coreBin, ["get", survivor, "--json"]);
      assert.equal(survivorRecord.parent, null);
      assert.equal(survivorRecord.die_with_parent, false);
      assert.equal(survivorRecord.state, "live");
      writeFileSync(join(evidence, "independent-lifetime.json"), JSON.stringify(survivorRecord, null, 2));
      terminal.closePane(survivor);
      terminal.closePane(launcher);
      owned.delete(survivor);
      owned.delete(launcher);
      const ended = await launch("finished-without-evidence", "true");
      await until(async () => { const record = await terminal.inspectPane(ended); return record.kind === "present" && record.ended === true; }, "finished core record");
      writeFileSync(join(evidence, "finished.json"), run(coreBin, ["get", ended, "--json"]));
      const { waitForCompletion } = await import("../pi-extension/subagents/completion.ts");
      const result = await waitForCompletion(new AbortController().signal, { intervalMs: 50, readTerminalTail: () => terminal.readPaneAsync(ended), inspectPane: () => terminal.inspectPane(ended) });
      assert.equal(result.reason, "error");
      assert.match(result.errorMessage!, /program ended/);
      writeFileSync(join(evidence, "finished-completion.json"), JSON.stringify(result, null, 2));
      terminal.closePane(ended);
      owned.delete(ended);
    }
    if (!transportOnly) {
      const agents = join(scratch, ".pi/agents");
      mkdirSync(agents, { recursive: true });
      writeFileSync(join(agents, "verify-worker.md"), `---\nname: verify-worker\ndescription: Disposable system verification worker\nmodel: ${model}\ntools: bash, read, write\nspawning: false\nauto-exit: true\n---\nExecute the requested task immediately. Use bash to write requested marker files.\n`);
      const session = join(evidence, "parent.jsonl");
      const sessionEntries = (file: string) => existsSync(file) ? readFileSync(file, "utf8").split("\n").flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }) : [];
      const entries = () => sessionEntries(session);
      const assistantSaid = (token: string) => {
        const events = entries();
        const failed = events.find((entry) => entry.message?.role === "assistant" && entry.message.stopReason === "error");
        if (failed) throw new Error(`Pi provider failed: ${failed.message.errorMessage}`);
        return events.some((entry) => entry.message?.role === "assistant" && entry.message.content?.some?.((content: any) => content.type === "text" && content.text.trim() === token));
      };
      const ready = `READY_${label}`;
      const extension = join(repo, "pi-extension/subagents/index.ts");
      const preamble = host === "herdr-tui" ? `export HERDR_WORKSPACE_ID=${quote(workspace!.workspace_id)}\nexport HERDR_PANE_ID="$PI_SUBAGENT_SURFACE"\nunset HERDR_TAB_ID` : undefined;
      const parent = await launch("parent", ["pi", "-e", extension, "--no-mcp", "--no-skills", "--no-context-files", "--approve", "--session", session, "--model", model, "--thinking", "off", `Reply with exactly ${ready}. Do not call tools.`].map(quote).join(" "), preamble);
      await until(() => assistantSaid(ready), "authenticated real Pi readiness");
      const marker = join(scratch, "child-marker.txt");
      const token = `CHILD_${label}`;
      const acknowledgment = `ACK_${label}`;
      terminal.runInPane(parent, `Call subagent once with name "VerifyWorker", agent "verify-worker", task "Run bash: printf '${token}\\n' > '${marker}'". Do not write the file yourself. End your turn after spawning. After the async subagent_result arrives, reply exactly ${acknowledgment}.`);
      await until(() => existsSync(marker) && readFileSync(marker, "utf8").trim() === token, "real child action");
      await until(() => entries().some((entry) => entry.customType === "subagent_result") && assistantSaid(acknowledgment), "async completion steering and parent acknowledgment");
      const events = entries();
      const calls = events.flatMap((entry) => entry.message?.role === "assistant" ? entry.message.content || [] : []).filter((content) => content.type === "toolCall" && content.name === "subagent");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].arguments?.agent, "verify-worker");
      const result = events.find((entry) => entry.customType === "subagent_result");
      assert.equal(result.details?.exitCode, 0);
      assert(!result.details?.error);
      const child = readFileSync(result.details.sessionFile, "utf8");
      const childEntries = child.trim().split("\n").map((line) => JSON.parse(line));
      assert(childEntries.some((entry) => entry.message?.role === "assistant" && entry.message.content?.some?.((content: any) => content.type === "toolCall" && content.name === "bash" && content.arguments?.command?.includes(marker))));
      writeFileSync(join(evidence, "child.jsonl"), child);
      writeFileSync(join(evidence, "parent.txt"), await terminal.readPaneAsync(parent, 200));
      writeFileSync(join(evidence, "spawn-proof.json"), JSON.stringify({ host, model, toolCall: calls[0], result, parentAcknowledged: true, markerMatched: true }, null, 2));
      writeFileSync(join(evidence, "child-marker.txt"), readFileSync(marker));
      const resumeMarker = join(scratch, "resume-marker.txt");
      const resumeSurface = join(scratch, "resume-surface.txt");
      const resumeAction = join(scratch, "resume-action.sh");
      writeFileSync(resumeAction, `printf '%s' ${quote(token)} > ${quote(resumeMarker)}\nprintf '%s' "$PI_SUBAGENT_SURFACE" > ${quote(resumeSurface)}\n`);
      const resumeAck = `RESUMED_${label}`;
      const resumeTask = `Run bash ${resumeAction}. Then call subagent_done with close false to keep this session open.`;
      terminal.runInPane(parent, `Call subagent_resume once with sessionPath ${JSON.stringify(result.details.sessionFile)}, name "VerifyResume", autoExit false, and message ${JSON.stringify(resumeTask)}. End your turn after resuming. After its async subagent_result arrives, reply exactly ${resumeAck}.`);
      await until(() => existsSync(resumeMarker) && existsSync(resumeSurface), "resumed child action and runtime identity");
      await until(() => entries().filter((entry) => entry.customType === "subagent_result").length === 2 && assistantSaid(resumeAck), "resumed completion and parent acknowledgment");
      assert.equal(readFileSync(resumeMarker, "utf8"), token);
      const resumed = readFileSync(resumeSurface, "utf8").trim();
      assert(resumed && resumed !== parent);
      owned.add(resumed);
      state();
      const resumeResult = entries().filter((entry) => entry.customType === "subagent_result")[1];
      assert.equal(resumeResult.details?.exitCode, 0);
      assert.match(resumeResult.content, /pane stayed open/);
      assert.equal((await terminal.inspectPane(resumed)).kind, "present");
      const followMarker = join(scratch, "follow-marker.txt");
      const followAck = `FOLLOW_${label}`;
      terminal.runInPane(resumed, `Use bash to run printf '${token}' > '${followMarker}'. Then reply exactly ${followAck}.`);
      await until(() => existsSync(followMarker) && readFileSync(followMarker, "utf8") === token && sessionEntries(result.details.sessionFile).some((entry) => entry.message?.role === "assistant" && entry.message.content?.some?.((content: any) => content.type === "text" && content.text.trim() === followAck)), "follow-up in the kept-open resumed session");
      const resumeCalls = entries().flatMap((entry) => entry.message?.role === "assistant" ? entry.message.content || [] : []).filter((content) => content.type === "toolCall" && content.name === "subagent_resume");
      assert.equal(resumeCalls.length, 1);
      assert.equal(resumeCalls[0].arguments.sessionPath, result.details.sessionFile);
      writeFileSync(join(evidence, "resume-proof.json"), JSON.stringify({ host, toolCall: resumeCalls[0], result: resumeResult, surface: resumed, followUpMatched: true }, null, 2));
      writeFileSync(join(evidence, "resumed-child.jsonl"), readFileSync(result.details.sessionFile));
      writeFileSync(join(evidence, "resume-marker.txt"), readFileSync(resumeMarker));
      writeFileSync(join(evidence, "follow-marker.txt"), readFileSync(followMarker));
      writeFileSync(join(evidence, "resumed-child.txt"), await terminal.readPaneAsync(resumed, 200));
      terminal.closePane(resumed);
      owned.delete(resumed);
      terminal.closePane(parent);
      owned.delete(parent);
    }
  } finally {
    state();
    try {
      if (host === "herdr-core" && coreStarted) {
        for (const address of owned) writeFileSync(join(evidence, `final-${address}.txt`), run(coreBin, ["read", address, "--lines", "200"]));
      } else if (workspace) {
        writeFileSync(join(evidence, "final-panes.json"), run("herdr", ["pane", "list", "--workspace", workspace.workspace_id]));
      }
    } catch {}
    if (workspace) {
      const current = json("herdr", ["workspace", "list"]).result.workspaces.find((item: any) => item.workspace_id === workspace!.workspace_id);
      if (current) {
        assert.equal(current.label, label, "Refusing cleanup after owned workspace label changed");
        run("herdr", ["workspace", "close", workspace.workspace_id]);
      }
    }
    if (coreStarted) {
      assert.equal(process.env.HC_SESSION, label);
      assert.equal(process.env.HC_SOCKET, coreSocket);
      const terminal = await import("../pi-extension/subagents/terminal.ts");
      const records = json(coreBin, ["ls", "--json", "--all"]).terminals;
      assert(Array.isArray(records));
      for (const record of records) {
        const address = record.address;
        assert.equal(typeof address, "string");
        terminal.closePane(address);
      }
      const remaining = json(coreBin, ["ls", "--json", "--all"]);
      writeFileSync(join(evidence, "core-cleanup.json"), JSON.stringify(remaining, null, 2));
      assert.equal(remaining.terminals.length, 0);
      run(coreBin, ["server", "stop"]);
    }
    rmSync(scratch, { recursive: true, force: true });
  }
  writeFileSync(join(evidence, "passed.json"), JSON.stringify({ host, transport: true, realPi: !transportOnly, resume: !transportOnly, keepOpenFollowUp: !transportOnly, cleanup: true }, null, 2));
  console.log(`${host} passed. Evidence retained at ${evidence}`);
}
