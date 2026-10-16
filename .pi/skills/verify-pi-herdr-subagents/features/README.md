# pi-herdr-subagents verification map

Read this index before choosing a journey. This is the maintained source for user-facing verification, not a claim that all listed paths have passed.

## Baseline preconditions

- Follow `../SKILL.md`: Node 24+, installed dependencies, real Pi and herdr, authenticated model.
- Launch a fresh owned workspace with `$CONTROL launch "$EVIDENCE"`. `$CONTROL` and `$EVIDENCE` are exported by the skill.
- Require `$CONTROL doctor "$EVIDENCE"` to pass. The disposable project contains `verify-worker`, pinned to `PI_TEST_MODEL`, with bash/read/write and auto-exit enabled.
- No global agent changes or port setup are needed. Existing provider extensions and credentials are shared, not seeded.
- For each independent entry point use a fresh run. A resume journey deliberately continues a successful spawn run before cleanup.

## Driving conventions

- Use `$CONTROL send "$EVIDENCE" '<literal user input>'` for real Pi input, then observe completion in the parent session and capture with `$CONTROL capture "$EVIDENCE"`.
- `send` only submits; wait for actual results. Do not replace user paths with calls to internal TypeScript functions.
- Load instance handles with the commands below. Child pane/session IDs come from actual tool results and `herdr pane list --workspace "$WORKSPACE"`, never the focused user pane. For child-directed recipes, set `CHILD` to the exact matching pane ID from that owned inventory; confirm its task/session with `herdr pane get "$CHILD"` before sending input.
- Parent and child agents may use codemode wrappers; inspect nested tool calls when evaluating manual journeys.
- Cleanup removes the owned workspace and scratch, not evidence. Capture before cleaning up.

```bash
export WORKSPACE=$(node -e 'console.log(require(process.argv[1]).workspaceId)' "$EVIDENCE/state.json")
export ROOT=$(node -e 'console.log(require(process.argv[1]).rootPaneId)' "$EVIDENCE/state.json")
export SCRATCH=$(node -e 'console.log(require(process.argv[1]).scratchDir)' "$EVIDENCE/state.json")
```

## Proof and failure reporting

Record feature ID and entry point, submitted action, visible result, tool result, and persisted side effect. CLI checks include command, output, and exit status. A provider failure, missing seed/precondition, refused tool call, or unavailable harness is a **failed or blocked journey**, not a pass through another path. Report untested entries separately. Interactive children must be observed directly because parent completion notifications are intentionally suppressed.

## Features

- [Spawn and completion](spawn.md): tool and `/subagent` entry points, background execution, parallel children, runtime selection, persisted marker, steering.
- [Agent discovery](discovery.md): list definitions, local precedence, hidden agents, slash-command resolution.
- [Interrupt a child turn](interrupt.md): real Pi tool interruption, surviving child process, no false completion.
- [Resume a child session](resume.md): resume tool, saved history, continuation and auto-exit choice.
- [Fork and plan](fork-plan.md): direct fork, `/iterate`, and `/plan` workflows.

Every feature file uses four H2 sections: sub-features, user entry points, harness recipe, gotchas. Additional terminal transport coverage lives in `test/integration/mux-surface.test.ts` and is not a substitute for these paths.
