---
name: verify-pi-resume-tool-policy
description: Verify that subagent_resume preserves a Pi helper's spawning and deny-tools restrictions on Herdr TUI and Core. Use when changing Pi launch, tool registration, or session resume.
---

# Verify Pi resume tool restrictions

## Doctor

From the repository root, install the locked dependencies with `npm ci`. Use Node 24 or later. Check `herdr status server --json` for `running: true`, then check `hc --version` or `herdr-core --version`. Choose an authenticated model from `pi --list-models` and set `PI_TEST_MODEL` to its `provider/model` ID. The parent and child Pi processes must load this checkout of the extension. Use an isolated Pi agent directory if another version is installed globally.

## Launch and drive

```bash
node --test test/resume-tool-policy.test.ts
export EVIDENCE="$(mktemp -d)"
node scripts/check-backends.ts --evidence="$EVIDENCE"
```

The first check needs no model or terminal service. It exercises allowlists from agent definitions and call overrides, repeated resumes through relative and symlinked paths, and empty, missing, or invalid policies.

The second check starts a real Pi parent in an owned Herdr workspace and then in a private Core session. Each parent must answer a readiness prompt. The runner uses the normal `subagent` and `subagent_resume` tools to continue the same session under a different display name. Each child runs a local script that records its session path, child ID, and `PI_DENY_TOOLS`. Both backends make model requests. For the user-facing steps, see the [spawn](../verify-pi-herdr-subagents/features/spawn.md) and [resume](../verify-pi-herdr-subagents/features/resume.md) recipes.

## Evidence and cleanup

For each backend, the runner checks the deny list passed to both processes and the native tools declared in the child transcript. `declaredTools` must contain exactly `bash`, `read`, `write`, `caller_ping`, and `subagent_done` before and after resume. It also checks that both processes used the original session and that the child ran each verification script.

The runner closes its terminals and removes its scratch project before writing `passed.json`. Inspect the retained results with:

```bash
for host in herdr-tui herdr-core; do
  cat "$EVIDENCE/$host/spawn-tool-policy.json" "$EVIDENCE/$host/resume-tool-policy.json"
  node -e 'const p = require(process.argv[1]); if (!p.toolPolicy || !p.cleanup) process.exit(1)' "$EVIDENCE/$host/passed.json" || exit 1
done
```

On failure, inspect the parent transcript and `ownership.json`. For a single-backend retry, pass `herdr-tui` or `herdr-core` before `--evidence` and choose a fresh directory. A single-backend run writes directly into that directory.
