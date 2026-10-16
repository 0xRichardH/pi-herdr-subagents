# Spawn and completion

A user delegates work to a child in its own herdr tab while the parent remains usable, then receives the child's real result without polling.

## Sub-features

- `spawn-tool`: named child launch and authenticated runtime selection.
- `spawn-command`: `/subagent` resolves the named agent and delegates the task.
- `spawn-async`: tool acknowledgment precedes completion; parent receives steering.
- `spawn-parallel`: two children run independently and both report results.
- `spawn-layout`: default tabs or opt-in right/down splits without focus theft.

## How to get to it (user POV)

- Ask Pi to call `subagent` with an agent name and task.
- Type `/subagent verify-worker <task>` in Pi.
- Ask Pi to call `subagent` twice for parallel work.
- Set `PI_SUBAGENT_LAYOUT=split` or `split:down` before launching Pi to choose a split instead of a tab.

## Driving it with control-subagents

Preconditions: healthy fresh baseline; `verify-worker` has authenticated `PI_TEST_MODEL`; no spawn marker exists.

- **Tool path.** Run `"$CONTROL" drive-spawn "$EVIDENCE"`. Expect an actual `subagent` tool call, successful tool acknowledgment, child's bash write, exit code 0 in `subagent_result`, and the parent's `SPAWN_COMPLETE_…` response. `spawn-proof.json`, both session logs, marker copy, before/after transcripts, and pane inventories are the proof.
- **Command path (fresh run).** Run `"$CONTROL" send "$EVIDENCE" '/subagent verify-worker Write COMMAND_PASS to command-marker.txt using bash, then finish.'`. Observe the child tab and completion steering. Run `"$CONTROL" capture "$EVIDENCE"`. Read the scratch path from `state.json`; copy `command-marker.txt` into evidence and require content `COMMAND_PASS`. Inspect the parent's actual delegated call rather than assuming slash-command injection executed.
- **Parallel path (fresh run).** Run `"$CONTROL" send "$EVIDENCE" 'Call subagent twice without waiting: name ParallelA, agent verify-worker, task Write PARALLEL_A to parallel-a.txt using bash; name ParallelB, agent verify-worker, task Write PARALLEL_B to parallel-b.txt using bash. End your turn and await both steering results.'`. Capture two distinct child IDs/session paths, two matching markers in scratch, and two successful completion messages. Copy both markers and child logs into evidence. A single child completing is a failure for this path.
- **Layout variants.** Repeat a fresh launch and tool journey with `PI_SUBAGENT_LAYOUT=split`, then separately `PI_SUBAGENT_LAYOUT=split:down`, exported before `launch`. Capture pane layout using `herdr pane layout --pane "$ROOT"`, plus focused pane identity before/after using `herdr pane current`. Require the intended split direction and unchanged user focus. Default launch uses tabs unless the environment already opts into splits.

## Gotchas

- `drive-spawn` proves only the tool entry, not slash commands, parallel work, or split layouts.
- A file alone does not prove who wrote it or whether the parent received completion. The helper checks the child session's actual bash call and the parent's steering record.
- Runtime fields must use exact authenticated model IDs. Named-agent calls should omit overrides unless testing overrides deliberately.
- Slow shell startup may drop injected commands; raise `PI_SUBAGENT_SHELL_READY_DELAY_MS` before launch and report readiness failures rather than counting an open shell as Pi.
- `interactive: true` suppresses parent completion notifications; this automated journey uses the autonomous fixture instead.
