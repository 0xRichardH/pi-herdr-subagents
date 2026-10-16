# Fork and plan

A user carries parent context into a focused child session or starts the bundled planning workflow from Pi.

## Sub-features

- `fork-tool`: explicit full-context fork with parent linkage.
- `fork-iterate`: `/iterate` starts an interactive full-context child.
- `plan-command`: `/plan` starts the repository's planning workflow for a concrete request.

## How to get to it (user POV)

- Ask Pi to call `subagent` with `fork: true`.
- Type `/iterate` with a focused task, or without arguments to request hands-on work.
- Type `/plan` with a build request. Bare `/plan` shows usage rather than starting planning.

## Driving it with control-subagents

Preconditions: healthy baseline. For fork verification, first establish parent context with `"$CONTROL" send "$EVIDENCE" 'Remember this verification token: FORK_CONTEXT_CEDAR. Reply ACK without tools.'`. Require the actual ACK before continuing.

- **Direct fork.** Run `"$CONTROL" send "$EVIDENCE" 'Call subagent with name ForkVerify, agent verify-worker, fork true, task Write the verification token from the parent conversation into fork-token.txt using bash. Do not repeat the token in the delegated task. End your turn after spawning.'`. Require an actual call with `fork: true`, child history containing the earlier token turn, parent session linkage, successful steering, and file content `FORK_CONTEXT_CEDAR`. Copy marker and child log into evidence and capture the parent.
- **Iterate command (fresh prepared run).** Run `"$CONTROL" send "$EVIDENCE" '/iterate Write the verification token from our earlier conversation to iterate-token.txt using bash, then wait for instructions.'`. Require the resulting call to include `fork: true`, `interactive: true`, and name `Iterate`. Inspect the child directly and capture the file, conversation history, surviving Pi process, and pane layout. The token should be `FORK_CONTEXT_CEDAR` without repeating it in the task.
- **Bare iterate (separate run).** Submit `"$CONTROL" send "$EVIDENCE" '/iterate'`. Require the same interactive full-context fork contract and a child ready for hands-on instructions. Send it a benign request and capture the response.
- **Planning request (separate fresh run).** Run `"$CONTROL" send "$EVIDENCE" '/plan Add a local greeting CLI to this disposable project; clarify requirements and propose a plan, but do not implement it.'`. Inspect the actual injected planning workflow and ensuing tools/child conversation. Require a planning response tied to the request, questions or an explicit scoped plan, and no unrequested implementation files. Capture parent and any child sessions plus a scratch file inventory.
- **Planning usage (separate run).** Submit `"$CONTROL" send "$EVIDENCE" '/plan'` and capture. Require the usage notification `Usage: /plan <what to build>` and no planner child created.

## Gotchas

- The default child is lineage-only, not a full-context fork. A parent linkage alone does not prove inherited conversation; the token journey does.
- `/iterate` is interactive, so a missing autonomous completion message is expected. A child that merely launches but never receives context is a failure.
- The bundled planner may inherit the parent model or a configured override. Capture the observed runtime; an unauthenticated override is a failed prerequisite, not a reason to skip planning silently.
- The empty seed project has no application requirements to discover. Ask for a scoped disposable feature as above; do not lower the planning journey to “a tab opened.”
- Planning can ask questions and remain open. Observe and answer in the owned child pane when needed; do not drive another user's planner session.
