# Spawn and completion

A user delegates work to a child in its own herdr tab while the parent remains usable, then receives the child's real result without polling.

## Sub-features

- `spawn-tool`: named child launch and authenticated runtime selection.
- `spawn-command`: `/subagent` resolves the named agent and delegates the task.
- `spawn-async`: tool acknowledgment precedes completion; parent receives steering.
- `spawn-parallel`: two children run independently and both report results.
- `spawn-layout`: default tabs or opt-in right/down splits without focus theft.
- `spawn-keep-open`: a child that finishes with `subagent_done({ close: false })`, or any child under `behavior.closeOnDone: false`, keeps its pane and session after the result is delivered.

## How to get to it (user POV)

- Ask Pi to call `subagent` with an agent name and task.
- Type `/subagent verify-worker <task>` in Pi.
- Ask Pi to call `subagent` twice for parallel work.
- Set `PI_SUBAGENT_LAYOUT=split` or `split:down` before launching Pi to choose a split instead of a tab. `split:right` is an alias for `split`.
- Tell the child to finish with `subagent_done({ close: false })`, or set `behavior.closeOnDone` to `false` in the package-root `config.json`.

## Driving it with control-subagents

Preconditions: healthy fresh baseline; `verify-worker` has authenticated `PI_TEST_MODEL`; no spawn marker exists.

- **Tool path.** Run `"$CONTROL" drive-spawn "$EVIDENCE"`. Expect an actual `subagent` tool call, successful tool acknowledgment, child's bash write, exit code 0 in `subagent_result`, and the parent's `SPAWN_COMPLETE_…` response. `spawn-proof.json`, both session logs, marker copy, before/after transcripts, and pane inventories are the proof.
- **Command path (fresh run).** Run `"$CONTROL" send "$EVIDENCE" '/subagent verify-worker Write COMMAND_PASS to command-marker.txt using bash, then finish.'`. Observe the child tab and completion steering. Run `"$CONTROL" capture "$EVIDENCE"`. Read the scratch path from `state.json`; copy `command-marker.txt` into evidence and require content `COMMAND_PASS`. Inspect the parent's actual delegated call rather than assuming slash-command injection executed.
- **Parallel path (fresh run).** Run `"$CONTROL" send "$EVIDENCE" 'Call subagent twice without waiting: name ParallelA, agent verify-worker, task Write PARALLEL_A to parallel-a.txt using bash; name ParallelB, agent verify-worker, task Write PARALLEL_B to parallel-b.txt using bash. End your turn and await both steering results.'`. Capture two distinct child IDs/session paths, two matching markers in scratch, and two successful completion messages. Copy both markers and child logs into evidence. A single child completing is a failure for this path.
- **Layout variants.** Repeat a fresh launch and tool journey with `PI_SUBAGENT_LAYOUT=split`, then separately `PI_SUBAGENT_LAYOUT=split:down`, exported before `launch`. The helper forwards `PI_SUBAGENT_LAYOUT` and `PI_SUBAGENT_SHELL_READY_DELAY_MS` into `launch.sh`; a run without that line creates tabs and proves nothing. Capture pane layout using `herdr pane layout --pane "$ROOT"`, plus focused pane identity before/after using `herdr pane current`. Require the intended split direction and unchanged user focus. Default launch uses tabs unless the environment already opts into splits. A split falls back to a tab when no parent pane resolves, so report that fallback as an unmet precondition rather than a split pass.
- **Keep-open path (fresh run).** Run `"$CONTROL" send "$EVIDENCE" 'Call subagent with name KeepOpenWorker, agent verify-worker, task "Run bash: printf KEEPOPEN_PASS > keepopen.txt, then call subagent_done with close false." End your turn after spawning.'`. Require a `subagent` tool call, the marker, and a `subagent_result` whose content ends with `The pane stayed open for follow-up conversation.`. Assert the child pane from the completion details still exists with `herdr pane get <pane>`, and that `keepopen.txt` is in scratch. Copy the result text, the pane record, and the marker into evidence. The same run with `behavior.closeOnDone: false` in a temporary package-root `config.json` proves the config default; remove that file afterward.

## Gotchas

- `drive-spawn` proves only the tool entry, not slash commands, parallel work, or split layouts.
- A file alone does not prove who wrote it or whether the parent received completion. The helper checks the child session's actual bash call and the parent's steering record.
- Runtime fields must use exact authenticated model IDs. Named-agent calls should omit overrides unless testing overrides deliberately.
- Slow shell startup may drop injected commands; raise `PI_SUBAGENT_SHELL_READY_DELAY_MS` before launch and report readiness failures rather than counting an open shell as Pi.
- `interactive: true` suppresses stall and recovery status steers. It does not suppress the completion `subagent_result`, and it does not stop a named agent from auto-exiting; that comes from the agent's `auto-exit` frontmatter.
- A keep-open completion removes the child from the parent's tracking after delivery. A later turn in that pane produces no second `subagent_result`; use the pane directly or `subagent_resume`.
- With `environment.allowOutsideHerdr` enabled, the extension also runs outside a herdr pane. The helper cannot cover that path because `doctor` requires `HERDR_ENV=1`; report it as untested rather than passing it through another journey.
