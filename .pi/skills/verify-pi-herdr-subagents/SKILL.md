---
name: verify-pi-herdr-subagents
description: Load when proving pi-herdr-subagents behavior through real Pi terminal sessions in herdr, capturing spawn/completion, agent discovery, interruption, resume, or planning/fork evidence. For the full existing integration suite use run-integration-tests instead.
---

# Verify pi-herdr-subagents

Read [features/README.md](features/README.md), then the relevant feature recipe. The primary surface is the Pi TUI: tools, slash commands, child tabs, and async completion messages. Unit-testable modules are secondary; there is no web server, port, database, migration, or seed service.

## Launch

From the repository root, inside herdr:

```bash
npm ci
npm test
npm run lint
export PI_TEST_MODEL=0xdev/gemini-3-flash
export PI_TEST_TIMEOUT=180000
export CONTROL="$PWD/.pi/skills/verify-pi-herdr-subagents/scripts/control-subagents"
export EVIDENCE="$(git rev-parse --absolute-git-dir)/verification/$(date +%Y%m%d-%H%M%S)-$$"
"$CONTROL" launch "$EVIDENCE"
```

Node 24+, `pi`, `herdr`, `HERDR_ENV=1`, and `HERDR_WORKSPACE_ID` are required. Choose an **exact authenticated model** from `pi --list-models`; the model above worked on the generating host, not a portable credential promise. Runs make real model requests and can incur charges. Keep credentials in the existing Pi configuration; never copy auth files into evidence.

`launch` creates a unique empty scratch project, seeds `verify-worker`, and creates an unfocused **owned herdr workspace**. It starts the working-tree extension explicitly with `pi -e .../index.ts --no-mcp --no-skills --no-context-files --approve --session <evidence>/parent.jsonl --model "$PI_TEST_MODEL" --thinking off`. The exact quoted command is in `launch.sh`. Ready means an authenticated assistant reply matching the generated `VERIFY_READY_…` token, not merely a shell or an open pane. Launch runs doctor after readiness. A readiness failure captures diagnostics and cleans up.

Model providers on this host are extensions. Consequently discovery stays enabled: `-ne` removes the `0xdev` models and fails before Pi is usable. Existing lifecycle tests use `-ne`; their filtered spawn test timed out here for that reason. Do not call that test passing or weaken its assertions. Global auto-loaded extensions can affect the run; check `parent.jsonl` and installed packages if tool registrations differ. Do not install a second copy of this subagent extension. The generating host's DeepSeek models also returned HTTP 422 (`developer` role unsupported); select a working authenticated model or report the provider failure.

Independent evidence directories produce separate workspaces and scratch projects. They still share herdr's daemon, the user's provider configuration, and rate limits. Never send input to the user's current pane, change global settings, or run focus-sensitive mux tests concurrently with another UI driver. The helper never focuses its workspace.

## Doctor

```bash
"$CONTROL" doctor "$EVIDENCE"
```

This read-only app check verifies workspace ownership, a foreground Pi process, the working-tree entrypoint hash, and a completed authenticated readiness turn. It records versions and instance IDs in `doctor.json`. It makes no model request. Run it first when anything looks wrong; inspect the transcript on failure. Readiness establishes initial auth, not a guarantee against later provider errors. Restart after changing application source.

## Drive

Prove one mapped entry point:

```bash
"$CONTROL" drive-spawn "$EVIDENCE"
```

This sends a real user prompt through the Pi PTY, requires one actual `subagent` tool call, confirms a child bash action wrote the exact marker, waits for the async `subagent_result` and parent's acknowledgment, and captures both sessions and terminal state. A timeout or assertion failure captures diagnostics and cleans up. It does not treat a file alone as completion proof.

For the other mapped paths:

```bash
"$CONTROL" send "$EVIDENCE" 'Call subagents_list and report the available agents.'
"$CONTROL" capture "$EVIDENCE"
```

`send` submits literal user input with `herdr pane run`; it does **not** wait for the feature to finish. Follow the matching feature file, observe the real response, then capture. For asynchronous children, let the parent receive steering; do not prompt it to invent results. Use session messages and explicit pane IDs rather than coordinates or guessed delays.

## Evidence

Evidence stays in `$EVIDENCE` (under Git's metadata directory, outside scratch). Keep:

- `actions.jsonl`: submitted user actions with timestamps and target pane IDs.
- `parent.jsonl`, `child.jsonl`: actual tool calls, results, runtime, and completion steering; `child.jsonl` is copied by `drive-spawn`.
- `*-before-spawn*.txt`, `*-after-spawn*.txt`, `*-panes.json`: terminal state and owned pane inventory around the action.
- `spawn-marker.txt`, `spawn-proof.json`: exact persisted side effect and assertions.
- `launch.sh`, `state.json`, `doctor.json`, `cleanup.json`: reproducible launch, ownership, health, and teardown proof.

Proof must pair the action with the resulting visible state and persisted side effects. Inspect the child session as well as the parent; internal setters, mocked tools, or shell-only Escape tests do not prove the Pi feature. Use mocks only at an existing production boundary, and label them. This workflow is not a dry-run: it makes network requests, writes sessions and markers, and creates terminals. It does not intentionally modify Git refs or open a browser. Inspect `git status` before/after and report unexpected changes rather than assuming isolation prevents all effects.

For manual recipes, copy the exact child session identified in the tool result into `$EVIDENCE`, capture before/after state, and write a short result naming the feature ID, entry point, assertions, and any unmet precondition. Do not mark other entry points covered by a convenient successful path. Terminal text is proof of behavior, not proof of widget colors or layout; capture an actual screenshot separately when evaluating appearance.

Artifacts include prompts, local paths, and model output. Keep them private and redact before sharing. Child sessions also remain at the Pi-managed path recorded in the result; these are retained proof, not a process to kill.

## Cleanup

```bash
"$CONTROL" cleanup "$EVIDENCE"
node -e 'const fs=require("fs"),p=process.argv[1];for(const f of ["parent.jsonl","child.jsonl","spawn-proof.json","spawn-marker.txt","cleanup.json"]){if(!fs.statSync(p+"/"+f).size)throw Error(f);console.log(f,"preserved")}' "$EVIDENCE"
```

The final check applies to `drive-spawn`; for another feature check its named artifacts. Cleanup closes only the recorded owned workspace (including its children), verifies it disappeared, and removes its scratch project. It preserves evidence and is repeatable. Run cleanup after every manual failure too. If the workspace label changed, the helper refuses automatic closure: inspect `state.json` and `herdr workspace list`, then close only the workspace this run created. Never kill processes by name or close all herdr workspaces.

## Helpers

The executable helper is `scripts/control-subagents`; every invocation above uses `$CONTROL`. All commands take an explicit evidence directory; there is no shared “latest run” pointer. `launch`, `doctor`, `drive-spawn`, `send`, `capture`, and `cleanup` are the complete command set. It uses Node built-ins and the installed herdr CLI, following the same real-PTY interaction as `test/integration/harness.ts`.

For the broader suite, read `.pi/skills/run-integration-tests/SKILL.md` and account for the `-ne` provider limitation above. The existing no-LLM terminal suite is `node --test test/integration/mux-surface.test.ts`; it covers terminal transport, not Pi interruption semantics.

Maintain the feature map as commands change with `/maintain-verification-skill`.
