# Interrupt a child turn

A user stops a Pi child's current turn while leaving its pane, process, and session available for further interaction.

## Sub-features

- `interrupt-tool`: target a running child by exact ID or unique name.
- `interrupt-survival`: child becomes open/interrupted rather than closing.
- `interrupt-no-completion`: interruption alone does not produce a fake completion result.

## How to get to it (user POV)

- Ask the parent to call `subagent_interrupt` with the child's ID or exact name.
- Open the child's herdr tab and press Escape directly in Pi.

## Driving it with control-subagents

Preconditions: healthy baseline; Pi-backed child actively executing a long task. The seed has no running child, so launch one first.

- **Start long work.** Run `"$CONTROL" send "$EVIDENCE" 'Call subagent with name InterruptWorker, agent verify-worker, interactive true, task Run bash: echo STARTED > interrupt-start.txt; sleep 90; echo FINISHED > interrupt-finish.txt. End your turn after spawning.'`. Wait until `interrupt-start.txt` exists in scratch and the child pane/session shows a live bash call. Capture before interruption. If the task has already finished, fail this attempt and restart with a fresh run.
- **Tool interrupt.** Run `"$CONTROL" send "$EVIDENCE" 'Call subagent_interrupt with name InterruptWorker. Do not close its pane or send Ctrl+C.'`. Require a successful interrupt acknowledgment in the tool result. Capture using `"$CONTROL" capture "$EVIDENCE"` and read the exact child pane with `herdr pane read "$CHILD" --source visible --lines 200`. Require Pi to be idle/open, `herdr pane get "$CHILD"` to succeed, no finished marker, and no `subagent_result` caused solely by interruption.
- **Prove surviving interaction.** Use `herdr pane run "$CHILD" 'Reply exactly INTERRUPT_SURVIVED and do not call tools.'`. Capture the child response and pane metadata into evidence. A surviving shell alone is insufficient.
- **Direct Escape variant (fresh run).** Repeat long work, then `herdr pane send-keys "$CHILD" Escape`. Apply the same survival, marker, and no-false-completion assertions. Capture both actions and both child states.

## Gotchas

- A shell sleep interrupted with Ctrl+C does not prove `subagent_interrupt`. Do not replace the real Pi task with that stand-in.
- The helper's generic `send` does not wait; capture only after checking the real active-task precondition.
- Escape interrupts the Pi turn; it does not promise to roll back already completed file writes or external work. Record observed side effects, including the STARTED marker.
- This tool supports Pi-backed children, not Claude or arbitrary CLI children. Name ambiguity is an error; use the returned exact child ID if necessary.
- Interactive tracking intentionally suppresses parent completion/stall notifications. Observe the child directly and clean up the owned workspace afterward.
