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

- The default child is standalone, not a full-context fork. A default child gets no seeded session file and no `parentSession` linkage. `lineage-only` is reachable only through agent frontmatter, and no bundled agent declares it. The token journey is what proves inherited conversation.
- `/iterate` sends the parent model an instruction to call `subagent` with `fork: true`, `interactive: true`, and name `Iterate`. Those values are prose, not an enforced contract, and the arguments are taken whole with no flag parsing. Inspect the actual tool call rather than trusting the command text.
- A direct `fork: true` spawn with the seeded worker stays autonomous, so its only steering is the async `subagent_result`. Only `/iterate` sets `interactive: true`.
- The bundled planner may inherit the parent model or a configured override. Capture the observed runtime; an unauthenticated override is a failed prerequisite, not a reason to skip planning silently.
- `/plan` injects the extension-bundled `pi-extension/subagents/plan-skill.md`, not a project skill, and strips its frontmatter before sending.
- The empty seed project has no application requirements to discover. Ask for a scoped disposable feature as above; do not lower the planning journey to “a tab opened.”
- Planning can ask questions and remain open. Observe and answer in the owned child pane when needed; do not drive another user's planner session.
