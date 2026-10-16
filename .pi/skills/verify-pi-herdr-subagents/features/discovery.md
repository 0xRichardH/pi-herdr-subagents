# Agent discovery

A user can see available agent definitions and launch the project-local definition rather than a same-named global or bundled one.

## Sub-features

- `discovery-list`: show local and bundled names and runtime defaults.
- `discovery-precedence`: project definitions override lower-priority definitions.
- `discovery-hidden`: hidden definitions stay off the model-visible list but remain directly loadable.

## How to get to it (user POV)

- Ask Pi to call `subagents_list`.
- Type `/subagent <agent> <task>` to select a known definition directly.
- Create an agent Markdown file under the project's `.pi/agents/` to customize available agents.

## Driving it with control-subagents

Preconditions: healthy baseline with seeded `verify-worker`; bundled agents include `planner` and `scout`.

- **List.** Run `"$CONTROL" send "$EVIDENCE" 'Call subagents_list once and report whether verify-worker, planner, and scout exist and which runtime verify-worker uses.'`. Capture after the real tool result appears with `"$CONTROL" capture "$EVIDENCE"`. Require the actual result to list all three and the seeded model, not just a model's prose claim.
- **Override.** In the scratch project named by `state.json`, copy `.pi/agents/verify-worker.md` to `.pi/agents/scout.md`, change frontmatter `name: verify-worker` to `name: scout` and description to `LOCAL_VERIFY_SCOUT`. Submit the same list prompt again. Require one local `scout` with that description. Capture the fixture file and tool result; leave bundled/global definitions untouched.
- **Hidden definition.** Add `disable-model-invocation: true` inside the scratch `scout.md` frontmatter. List again: require the local hidden scout to shadow the bundled scout without appearing in the list. Run `"$CONTROL" send "$EVIDENCE" '/subagent scout Write HIDDEN_SCOUT_PASS to hidden-scout.txt using bash.'`. Require a successful real child execution and the marker in scratch despite list invisibility. Copy marker and child log into evidence.

## Gotchas

- File names and frontmatter names need not match; route by the declared name. The override recipe explicitly sets both.
- Discovery refreshes tool guidance, but verify the real list and launch after fixture edits. Restart the owned Pi if its host version caches local resources and record that requirement.
- A hidden fixture is not in the launch seed. If the override or hidden journey is attempted without creating it, report the missing precondition as a failure; do not substitute `verify-worker` and claim coverage.
- This recipe mutates only disposable agent files. Never test precedence by overwriting a real global agent.
