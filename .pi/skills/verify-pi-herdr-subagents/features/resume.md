# Resume a child session

A user continues a saved child's work in a new herdr pane, with its previous conversation available.

## Sub-features

- `resume-history`: resume an actual child session path and retain context.
- `resume-message`: submit follow-up work on launch.
- `resume-mode`: choose autonomous auto-exit or an interactive session.

## How to get to it (user POV)

- Ask the parent to call `subagent_resume` with a prior child's `sessionPath`.
- Use the `pi --session <path>` command shown in completion output to open the conversation manually.

## Driving it with control-subagents

Preconditions: healthy owned run after successful `drive-spawn`, **before cleanup**. Read the exact child `sessionFile` from `spawn-proof.json`. The seed alone has no prior session; missing that path is a failed precondition.

- **Tool resume.** Extract `SESSION=$(node -e 'console.log(require(process.argv[1]).result.details.sessionFile)' "$EVIDENCE/spawn-proof.json")`. Run `"$CONTROL" send "$EVIDENCE" "Call subagent_resume with sessionPath \"$SESSION\", name \"VerifyResume\", message \"Read spawn-marker.txt and write its exact contents to resumed-marker.txt using bash\", autoExit true. End your turn after submitting and await steering."`. Require the resume tool acknowledgment, a new child pane, a successful completion result, and `resumed-marker.txt` in scratch matching `spawn-marker.txt` byte-for-byte. Capture the submitted resolved prompt, both marker copies, resumed child log, and parent transcript.
- **History.** Inspect the resumed conversation through the real Pi UI/session transcript: require the earlier marker-writing turn as well as the new continuation. A fresh worker creating the same file is not resume proof.
- **Interactive variant.** Repeat tool resume on a fresh prepared run with `autoExit false`. Observe the child accepting another real prompt after its first response. Capture the surviving Pi process and response; do not expect autonomous completion steering.
- **Manual session entry.** In a newly created tab inside the owned workspace, run `pi --session "$SESSION"` using the extracted path (the completion output prints this same command). Ask it to recall the marker task and create `manual-resume.txt` with `MANUAL_RESUME_PASS`. Capture the child conversation and persisted file. Only target the owned workspace, never a user's open tab.

## Gotchas

- The displayed session path is a file, not a guessed agent ID. Copy it from the successful spawn result.
- Cleanup removes the working directory, so continuing after cleanup changes the preconditions even if Pi retains the session file.
- Report tool resume and manual `pi --session` separately. The automated spawn proof does not cover either resume path.
- Keep copied child session proof before teardown; Pi-managed originals also remain at the paths recorded in completion details.
