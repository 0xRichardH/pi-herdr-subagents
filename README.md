# pi-herdr-subagents

Async subagents for [pi](https://github.com/earendil-works/pi) in [herdr-tui](https://herdr.dev) and herdr-core. Subagents run in dedicated TUI tabs or panes, or independent core terminals. The parent keeps working while results arrive asynchronously.

## How It Works

Call `subagent()` and it **returns immediately**. The sub-agent runs in its own terminal pane. A live widget above the input shows all tracked agents with their projected state — for example `starting`, `active`, `waiting`, `interrupted`, `stalled`, `running`, or `finalizing`. The header summarizes **active** (processing) vs **open** (not processing). When every tracked subagent is open, the border switches to amber. When a sub-agent finishes, its result is **steered back** into the main session as an async notification — triggering a new turn so the agent can process it.

```
╭─ Subagents ──────────────────── 1 active · 1 open ─╮
│ 00:23  Scout: Auth (scout)        active · bash 7m │
│ 00:45  Scout: DB (scout)                waiting 2m │
╰────────────────────────────────────────────────────╯
```

For parallel execution, just call `subagent` multiple times — they all run concurrently:

```typescript
subagent({ name: "Scout: Auth", agent: "scout", task: "Analyze auth module" });
subagent({ name: "Scout: DB", agent: "scout", task: "Map database schema" });
// Both return immediately, results steer back independently
```

## Development

Run unit tests and lint locally:

```bash
npm test
npm run lint
```

Run the dual-host system check with both CLIs installed and a reachable herdr-tui server. Set `PI_TEST_MODEL` to an authenticated `provider/model` from your Pi catalog. Provider extensions remain enabled.

```bash
PI_TEST_MODEL="your-provider/your-model" npm run test:system -- --evidence=/tmp/pi-dual-host-proof
```

To check one host or skip authenticated Pi calls:

```bash
PI_TEST_MODEL="your-provider/your-model" npm run test:system -- herdr-core --evidence=/tmp/pi-core-proof
npm run test:system -- herdr-tui --transport-only --evidence=/tmp/pi-tui-transport
```

Add `--mixed-identities` to provision both an owned TUI workspace and an isolated core server for each host check. Each real parent and selection probe receives its own host identity plus a live terminal identity from the other host, outside its process ancestry. Both CLIs and a reachable TUI server are required in this mode, even when checking only one host.

```bash
npm run test:system -- --mixed-identities --transport-only --evidence=/tmp/pi-mixed-transport
PI_TEST_MODEL="your-provider/your-model" npm run test:system -- --mixed-identities --evidence=/tmp/pi-mixed-pi
```

Use a fresh evidence directory for each run. `PI_TEST_MODEL` selects the model for both parent and child and is required for authenticated checks. Transport checks run without a model. `PI_TEST_TIMEOUT` sets each wait deadline in milliseconds, defaulting to `180000`.

The system check first verifies automatic backend selection inside a real host terminal with `PI_SUBAGENT_BACKEND` unset. It saves `selection.json` with the selected kind and runtime identities. Mixed mode also records both live process records and the probe's ancestry. Real Pi parents likewise unset the override and save `parent-selection.json` before Pi starts. The system check uses the production launch, input, read, inspection, Escape, and cleanup operations. It then proves a real Pi parent tool call, the child's bash action, asynchronous completion steering, and the parent's acknowledgment. It resumes that child session, requests completion with the terminal kept open, and sends a follow-up that writes another marker. Core also checks that an ended program without completion evidence fails after the bounded artifact grace.

TUI runs own an unfocused disposable workspace. Core runs use a fresh socket, an isolated `HC_SESSION`, and scratch XDG directories. The check stops its owned core server and removes scratch files after cleanup. Transcripts, markers, and ownership records remain in the evidence directory. The older integration suite remains TUI-only:

```bash
PI_TEST_MODEL="deepseek/deepseek-v4-flash" PI_TEST_TIMEOUT=180000 npm run test:integration
```

The full suite launches real Pi sessions and can take several minutes. `PI_TEST_TIMEOUT` is the per-test timeout in milliseconds; use at least `180000` for the lifecycle suite.

`PI_TEST_MODEL` is applied to both the parent Pi sessions and the project-local test subagents created by the harness.

## Install

Install the package from npm:

```bash
pi install npm:pi-herdr-subagents
```

This project does not install or load `HazAT/pi-interactive-subagents` automatically.

Changing the `package.json` version on `main` automatically creates a matching Git tag and GitHub Release, generates release notes, and publishes the package to npm. For authentication, versioning, verification, and troubleshooting, see [RELEASING.md](RELEASING.md).

Start herdr, then run pi inside it:

```bash
herdr
pi
```

Alternatively, start Pi in herdr-core with `hc run pi`. Either `hc` or `herdr-core` must be on `PATH`.

The extension detects its host automatically and selects the backend once. `HC_TERMINAL_ID` alone selects herdr-core. `HERDR_ENV=1` alone selects herdr-tui. When both identities are inherited, it checks which live host process owns the Pi session and selects the nearest owner. This handles nested hosts and inherited variables independently of terminal focus.

If process ownership cannot be resolved, `HC_TERMINAL_ID` takes precedence and selects herdr-core. Without either host marker, herdr-tui remains the default. `PI_SUBAGENT_BACKEND=herdr-core` or `PI_SUBAGENT_BACKEND=herdr-tui` is an optional manual override. It wins over automatic selection, and child launch scripts pin the selected backend.

Plain-terminal orchestration requires `environment.allowOutsideHerdr=true` in `config.json`, even with an explicit backend override. The selected CLI and server must be reachable. See [Configuration](#configuration).

Core starts the prepared script directly with `hc run --bg --no-notify --no-parent --outlive-parent`. Human names and tasks become labels. Core maps every layout request to an independent terminal that survives its launcher exiting. Use `hc attach <id>` to interact with it. Completion requires sidecar or sentinel evidence, including when core reports a finished record.

For herdr-tui, if your shell startup is slow and subagent commands sometimes get dropped before the prompt is ready, set `PI_SUBAGENT_SHELL_READY_DELAY_MS` to a higher value (defaults to `500`):

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500
```

On herdr-tui, each subagent runs in its **own new tab** by default. If you'd rather keep them
side-by-side with the orchestrator, set `PI_SUBAGENT_LAYOUT=split` (right-hand
split) or `PI_SUBAGENT_LAYOUT=split:down` (split below). Unset, empty, or any
other value keeps the default new-tab behavior:

```bash
export PI_SUBAGENT_LAYOUT=split        # right-hand split
# export PI_SUBAGENT_LAYOUT=split:down # split below
```

Subagent tabs and panes are created without stealing keyboard focus. Launch commands target child panes by explicit ID, so focus and command delivery are independent. Note: the `interactive` option controls parent status notifications, not terminal focus.

## What's Included

### Extensions

**Subagents** — 4 main-session tools + 3 commands, plus 1 subagent-only tool:

| Tool                 | Description                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `subagent`           | Spawn a sub-agent in a dedicated terminal (async — returns immediately)             |
| `subagent_interrupt` | Interrupt a running Pi-backed subagent's current turn                                       |
| `subagents_list`     | List available agent definitions                                                            |
| `subagent_resume`    | Resume a previous sub-agent session (async)                                                 |

| Command                    | Description                          |
| -------------------------- | ------------------------------------ |
| `/plan`                    | Start a full planning workflow       |
| `/iterate`                 | Fork into a subagent for quick fixes |
| `/subagent <agent> <task>` | Spawn a named agent directly         |

### Bundled Agents

| Agent             | Default runtime       | Role                                                                                     |
| ----------------- | --------------------- | ---------------------------------------------------------------------------------------- |
| **planner**       | Config, then parent   | Brainstorming — clarifies requirements, explores approaches, writes plans, creates todos |
| **scout**         | Config, then parent   | Fast codebase reconnaissance — maps files, patterns, conventions                         |
| **worker**        | Config, then parent   | Implements tasks from todos — writes code, runs tests, makes polished commits            |
| **reviewer**      | Config, then parent   | Reviews code for bugs, security issues, correctness                                      |
| **visual-tester** | Config, then parent   | Visual QA via Chrome CDP — screenshots, responsive testing, interaction testing          |

Bundled agents use model defaults from `config.json` when configured; otherwise they inherit the parent model. Thinking defaults still come from agent frontmatter or the parent level. For a named agent, callers should omit `model` and `thinking` so those configured defaults apply. Passing either field explicitly is a one-off override and takes precedence over agent frontmatter.

Agent discovery follows priority: **project-local** (`.pi/agents/`) > **global** (`~/.pi/agent/agents/`) > **package-bundled**. Override any bundled agent by placing your own version in the higher-priority location. The discovered names, descriptions, and runtime defaults are included in the subagent tool guidance so the orchestrator can select by role instead of treating one agent as a generic default.

### Supported Harness CLIs

Agents default to running with `pi`, but can run inside any supported harness CLI or custom CLI configured via agent frontmatter:

| Harness CLI | Frontmatter `cli:` | Model format | Notes |
| :--- | :--- | :--- | :--- |
| **Pi** (default) | `pi` (or omitted) | `provider/model` | Full support for thinking levels, turn interrupts, and live activity snapshots |
| **OpenCode** | `opencode` | `provider/model` | Runs `opencode run --model <model> <task>` |
| **Codex** | `codex` | bare model ID | Runs `codex --model <model>` with optional `--reasoning-effort` |
| **Claude Code** | `claude` | bare model ID | Runs `claude --model <model>` with autonomous completion hook |
| **Grok** | `grok` | bare model ID | Runs `grok --model <model> <task>` |
| **Custom / Generic** | any CLI name | bare model ID | Supports custom `command:` template (e.g. `command: "aider --model {model} --message {task}"`) |

Claude Code completion follows the resolved `auto-exit` setting. For autonomous
runs, its Stop hook publishes the final response even when `--resume` loads prior
user messages or additional input was sent during the task. Non-auto-exit runs
remain open until the Claude CLI exits; `interactive` separately controls parent
status notifications. The hook uses `last_assistant_message` when available and
falls back to the last 4 MiB of transcript text on older Claude versions. Completion is published
atomically, after saving the transcript pointer, so Pi cannot consume a partial
result. A temporarily missing transcript does not block completion.

---

## Async Subagent Flow

```
1. Agent calls subagent()          → returns immediately ("started")
2. Sub-agent runs in herdr pane    → widget shows live status
3. User keeps chatting             → main session fully interactive
4. Sub-agent finishes              → result steered back as a normal completion/failure
5. Main agent processes result     → continues with new context
```

Multiple subagents run concurrently — each steers its result back independently as it finishes. The live widget above the input tracks every agent still in flight:

```
╭─ Subagents ──────────────────── 1 active · 2 open ─╮
│ 01:23  Scout: Auth (scout)            active · write 7m │
│ 00:45  Researcher (researcher)               stalled 4m │
│ 00:12  Scout: DB (scout)                      starting… │
╰─────────────────────────────────────────────────────────╯
```

Completion messages render with a colored background and are expandable with `Ctrl+O` to show the full summary and session file path. Completed rows are removed from the widget as soon as their result is delivered or suppressed.

### In-progress status updates

The widget projects each sub-agent from a **process + turn lifecycle**:

- **Herdr pane inspection** is the coarse authority for whether the child process is present and whether Herdr reports it as idle, working, blocked, or done.
- **Child activity snapshots** enrich the label with Pi-only detail (tool name, streaming, etc.) when available.
- Session JSONL is still used for transcript, resume, lineage, and result extraction — not for liveness.

Projected labels include:

- `starting` — launched; pane/activity confirmation is still settling
- `active` — processing work (agent turn, provider request, streaming, or tool execution)
- `blocked` — Herdr reports the child as blocked
- `waiting` — turn finished; the process is intentionally open for more input or another stage
- `interrupted` — the current turn was cancelled (Escape / `subagent_interrupt`); the process stays open and is **not** treated as active processing
- `stalled` — pane inspection is unhealthy long enough that the parent can no longer trust the run
- `running` — fallback when only coarse process presence is known (e.g. non-Pi backends)
- `finalizing` — completion was observed and delivery is in progress; the process elapsed timer freezes here

The widget header counts **active** vs **open**:

- **active** — `active`, `starting`, `running`, or `blocked`
- **open** — everything else still tracked (`waiting`, `interrupted`, `stalled`, `finalizing`, …)

When `activeCount === 0` (every tracked row is open), the border uses an amber accent. Process elapsed time (`MM:SS` on the left) freezes when the process reaches finalizing/completed/failed. Interrupt does **not** freeze that process clock; the interrupted state shows its own duration on the right while the process remains open.

A fixed internal watchdog marks a run as `stalled` when pane inspection fails or the pane disappears without a completion sidecar; valid long-running `active` or `waiting` states do not become `stalled` just because time passes. When a run enters `stalled` or recovers from it, the parent agent receives a steer message so it can react. All other status transitions stay in the widget only.

**Interactive subagents stay silent.** Long-running user-driven subagents (e.g. `planner`, or any `/iterate` fork) do not wake the parent session on `stalled`/`recovered` transitions — the user is working directly in the subagent's pane, and a steer message there would just burn an orchestrator turn on a no-op "still waiting" ping. The widget still updates normally, and activity snapshots are still recorded/classified regardless of the `interactive` setting. By default, agents with `auto-exit: true` are treated as autonomous and get stall pings; agents without it are treated as interactive and stay quiet. Override per-agent with `interactive: true|false` in frontmatter, or per-spawn with `interactive: true|false` on the tool call.

#### Configuration

Status display is controlled by `config.json` in the extension directory. Copy `config.json.example` to get started:

```bash
cp config.json.example config.json
```

```json
{
  "status": {
    "enabled": true
  },
  "models": {
    "agents": {}
  },
  "environment": {
    "allowOutsideHerdr": false
  },
  "behavior": {
    "closeOnDone": true
  }
}
```

The copyable example is model-neutral, so it works without requiring credentials for a specific provider. To configure models, replace the empty section with exact IDs from your authenticated model catalog:

```json
{
  "models": {
    "default": "your-provider/your-default-model",
    "agents": {
      "scout": "your-provider/your-fast-model",
      "reviewer": "your-provider/your-review-model"
    }
  }
}
```

`models.default` sets the model for subagents that do not specify a model. `models.agents` sets per-agent defaults, keyed by the agent name passed to `subagent({ agent: ... })`. Explicit `model` tool arguments take precedence, followed by agent frontmatter, per-agent config, the global default, and finally the parent model. Model values must be exact authenticated `provider/model-id` references.

`environment.allowOutsideHerdr` permits orchestration outside the selected host and defaults to `false`. For TUI, the `herdr` CLI and `herdr workspace list` must respond. Tabs use the first workspace when the current pane cannot be resolved. Splits fall back to a new tab without a parent pane. For core, choose `PI_SUBAGENT_BACKEND=herdr-core`; the extension requires `hc` or `herdr-core` and a reachable core server. An override does not bypass this permission.

`behavior.closeOnDone` sets the default for what happens to a subagent's pane after its result is delivered. `true` closes the pane as before. `false` leaves the pane and its pi session open so you can continue the conversation in place. A subagent can override the default per call with `subagent_done({ close: false })` or `subagent_done({ close: true })`. The parent is told the pane stayed open so it can send a follow-up there instead of calling `subagent_resume`.

`config.json` is gitignored so local overrides don't get committed.

---

## Spawning Subagents

```typescript
// Named agent with defaults from agent definition or config.json
subagent({ name: "Scout", agent: "scout", task: "Analyze the codebase..." });

// Force a full-context fork for this spawn
subagent({ name: "Iterate", fork: true, task: "Fix the bug where..." });

// Agent defaults can choose a different session-mode via frontmatter
subagent({ name: "Planner", agent: "planner", task: "Work through the design with me" });

// Custom working directory
subagent({ name: "Designer", agent: "game-designer", cwd: "agents/game-designer", task: "..." });
```

### Parameters

| Parameter              | Type    | Default        | Description                                                                                       |
| ---------------------- | ------- | -------------- | ------------------------------------------------------------------------------------------------- |
| `name`                 | string  | required       | Display name (shown in widget and pane title)                                                     |
| `task`                 | string  | required       | Task prompt for the sub-agent                                                                     |
| `agent`                | string  | —              | Load defaults from agent definition                                                               |
| `fork`                 | boolean | `false`        | Force the full-context fork mode for this spawn, overriding any agent `session-mode` frontmatter  |
| `interactive`          | boolean | derived        | Mark this spawn as interactive (don't wake the parent on stall/recovery). Defaults to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit`. |
| `model`                | string  | agent, configured, or parent | Exact authenticated `provider/model-id`; resolution is tool argument → agent frontmatter → per-agent config → global config → parent |
| `thinking`             | string  | agent or parent | Pi thinking level (`off` through `max`); resolution is tool argument → agent frontmatter → parent |
| `systemPrompt`         | string  | —              | Append to system prompt                                                                           |
| `skills`               | string  | —              | Comma-separated skill names                                                                       |
| `tools`                | string  | —              | Comma-separated tool names                                                                        |
| `cwd`                  | string  | —              | Working directory for the sub-agent (see [Role Folders](#role-folders))                           |

---

## Interrupting a running subagent

Use `subagent_interrupt` to cancel the active turn of a running Pi-backed subagent:

```typescript
subagent_interrupt({ id: "abcd1234" });
// or
subagent_interrupt({ name: "Scout" });
```

This sends Escape to the child pane, cancelling the in-progress model turn. The subagent session stays alive — the pane, session file, and background polling all remain intact. After the interrupt, the widget immediately labels the child as `interrupted` (counted as **open**, not active processing). Stale pre-interrupt activity snapshots are ignored so a lagging Herdr/`active` reading cannot overwrite the interrupt. The process elapsed timer keeps running because the pane is still open; only the interrupted-state duration freezes relative to the interrupt request. If the child starts work later, newer observations return it to `active`; completion, failure, and `caller_ping` still flow through normally.

This is a turn-level interrupt, not a method for forcibly terminating a subagent session.

> **Note:** Only Pi-backed subagents are supported. Claude-backed runs will return an error.

---

## Keeping a subagent pane open after completion

A subagent finishes by calling `subagent_done`, and the parent closes its pane after delivering the result. To keep the pane and its session alive for a follow-up question, pass `close: false`:

```typescript
subagent_done({ close: false });
```

The result is still delivered to the parent as a steer message. The pane stays open and idle, so the next message can continue the same conversation in place. The orchestrator sees that the pane stayed open and can send a follow-up there instead of starting a new tab with `subagent_resume`. Omitting `close` uses `behavior.closeOnDone` from `config.json`, which defaults to `true`.

---

## caller_ping — Child-to-Parent Help Request

The `caller_ping` tool lets a subagent request help from its parent agent. When called, the child session **exits** and the parent receives a notification with the help message. The parent can then **resume** the child session with a response using `subagent_resume`.

**`caller_ping` parameters:**
- `message` (required): What you need help with

**`subagent_resume` parameters:**
- `sessionPath` (required): Path to the child session `.jsonl` file
- `name` (optional): Display name for the resumed pane (defaults to `Resume`)
- `message` (optional): Follow-up prompt to send after resuming
- `autoExit` (optional): Whether the resumed session should auto-exit after its next response. Defaults to `true` for autonomous follow-up work; set `false` when resuming for an interactive handoff.

**Interaction flow:**
1. Child calls `caller_ping({ message: "Not sure which schema to use" })`
2. Child session exits (like `subagent_done`)
3. Parent receives a steer notification: *"Sub-agent Worker needs help: Not sure which schema to use"*
4. Parent resumes the child session via `subagent_resume` with the response
5. Child picks up where it left off with the parent's guidance

**Example:**
```typescript
// Inside a worker subagent
await caller_ping({
  message: "Found two conflicting migration files — should I use v1 or v2?"
});
// Session exits here. Parent receives the ping, then resumes this session
// with guidance like "Use v2, v1 is deprecated"
```

> **Note:** `caller_ping` is only available inside subagent contexts. Calling it from a standalone pi session returns an error.

---

## The `/plan` Workflow

The `/plan` command orchestrates a full planning-to-implementation pipeline.

```
/plan Add a dark mode toggle to the settings page
```

```
Phase 1: Investigation    → Quick codebase scan
Phase 2: Planning         → Interactive planner subagent (user collaborates)
Phase 3: Review Plan      → Confirm todos, adjust if needed
Phase 4: Execute          → Scout + sequential workers implement todos
Phase 5: Review           → Reviewer subagent checks all changes
```

The parent workspace and tab names stay unchanged. Subagents are created in newly named tabs or panes for each phase.

---

## The `/iterate` Workflow

For quick, focused work without polluting the main session's context.

```
/iterate Fix the off-by-one error in the pagination logic
```

This always forks the current session into a subagent with full conversation context. It does not inherit an agent default `session-mode`. Make the fix, verify it, and exit to return. The main session gets a summary of what was done.

---

## Custom Agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Keep the filename and frontmatter `name` aligned (for example, `researcher.md` must declare `name: researcher`) so discovery and direct invocation agree:

```markdown
---
name: my-agent
description: Does something specific
model: anthropic/claude-sonnet-4-6
thinking: minimal
tools: read, bash, edit, write
session-mode: lineage-only
spawning: false
---

# My Agent

You are a specialized agent that does X...
```

### Frontmatter Reference

| Field         | Type    | Description                                                                                                                                                                                                                                                                 |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string  | Agent name (used in `agent: "my-agent"`)                                                                                                                                                                                                                                    |
| `description` | string  | Shown in `subagents_list` output                                                                                                                                                                                                                                            |
| `model`       | string  | Optional exact authenticated model default; omit to inherit the parent                                                                                                                                                                                                      |
| `thinking`    | string  | Optional Pi thinking default (`off` through `max`); omit to inherit the parent                                                                                                                                                                                                                                 |
| `tools`       | string  | Comma-separated **native pi tools only**: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`                                                                                                                                                                             |
| `skills`      | string  | Comma-separated skill names to auto-load                                                                                                                                                                                                                                    |
| `session-mode` | string | Default child-session mode: `standalone`, `lineage-only`, or `fork` |
| `spawning`    | boolean | Set `false` to deny all subagent-spawning tools                                                                                                                                                                                                                             |
| `deny-tools`  | string  | Comma-separated extension tool names to deny                                                                                                                                                                                                                                |
| `auto-exit`   | boolean | Automatically complete the run after a final response — no `subagent_done` call needed. Recommended for autonomous agents (scout, worker); not for interactive ones (planner). Claude uses its Stop hook; Pi uses its settled lifecycle. Also determines the default value of `interactive` (see below). |
| `interactive` | boolean | derived        | Override whether stall/recovery transitions wake the parent session. Defaults to the inverse of `auto-exit`: autonomous agents (`auto-exit: true`) are non-interactive and get stall pings; agents without `auto-exit` are interactive and stay quiet. Explicit values take precedence. |
| `cwd`         | string  | Default working directory (absolute or relative to project root)                                                                                                                                                                                                            |
| `disable-model-invocation` | boolean | Hide this agent from discovery surfaces like `subagents_list`. The agent still remains directly invokable by explicit name via `subagent({ agent: "name", ... })`. |

---

Discovery still resolves precedence before visibility filtering. If a project-local hidden agent has the same name as a visible global or bundled agent, the hidden project agent wins and the lower-precedence agent does not appear in `subagents_list`.

### `session-mode`

Choose how a subagent session starts:

- `standalone` — default fresh session with no lineage link to the caller
- `lineage-only` — fresh blank child session with `parentSession` linkage, but no copied turns from the caller
- `fork` — linked child session seeded with the caller's prior conversation context

`lineage-only` is useful when you want session discovery and fork lineage UX to show the relationship later, but you do **not** want the child to inherit the parent's turns.

`fork: true` on the tool call always forces the `fork` mode for that specific spawn. `/iterate` uses this explicit override on purpose.

```yaml
---
name: planner
session-mode: lineage-only
---
```

### `auto-exit`

When set to `true`, the agent session shuts down automatically as soon as the agent finishes its turn — no explicit `subagent_done` call is needed.

**Behavior:**

- Pi-backed sessions close after a normal final response once the run has settled; tool-use and aborted turns do not auto-exit
- Claude-backed sessions signal completion at the final Stop hook, regardless of historical or additional user messages; use `auto-exit: false` for a user-driven session
- The modeHint injected into the agent's task is adjusted accordingly: autonomous agents see "Complete your task autonomously." rather than instructions to call `subagent_done`

**When to use:**

- ✅ Autonomous agents (scout, worker, reviewer) that run to completion
- ❌ Interactive agents (planner, iterate) where the user drives the session

```yaml
---
name: scout
auto-exit: true
---
```

### `interactive`

Controls whether status transitions (`stalled`, `recovered`) wake the parent session with a steer message.

**Default:** the inverse of `auto-exit`. Autonomous agents (`auto-exit: true`) are non-interactive and ping the parent on stall/recovery; agents without `auto-exit` are interactive and stay quiet. Bare spawns with no agent defs (e.g. `/iterate` with `fork: true`) are treated as interactive.

**Why it exists:** Interactive agents can run for minutes or hours while the user thinks, types, and reads in the subagent's pane. Child snapshots still update the widget, but stalled/recovered supervision messages rarely need to wake the parent for user-driven sessions. Skipping the steer keeps the parent quiet until the child actually finishes.

**When to override:**

- Set `interactive: false` on an agent that doesn't auto-exit but you still want stall pings for
- Set `interactive: true` on an autonomous agent you'd rather check on yourself

```yaml
---
name: planner
# interactive defaults to true because auto-exit is not set
---
```

Or per spawn:

```typescript
subagent({ name: "Scout", agent: "scout", interactive: true, task: "..." });
```

---

## Tool Access Control

By default, every sub-agent can spawn further sub-agents. Control this with frontmatter:

### `spawning: false`

Denies all subagent lifecycle tools (`subagent`, `subagent_interrupt`, `subagents_list`, `subagent_resume`):

```yaml
---
name: worker
spawning: false
---
```

### `deny-tools`

Fine-grained control over individual extension tools:

```yaml
---
name: focused-agent
deny-tools: subagent
---
```

### Recommended Configuration

| Agent      | `spawning`  | Rationale                                    |
| ---------- | ----------- | -------------------------------------------- |
| planner    | _(default)_ | Legitimately spawns scouts for investigation |
| worker     | `false`     | Should implement tasks, not delegate         |
| researcher | `false`     | Should research, not spawn                   |
| reviewer   | `false`     | Should review, not spawn                     |
| scout      | `false`     | Should gather context, not spawn             |

---

## Role Folders

The `cwd` parameter lets sub-agents start in a specific directory with its own configuration:

```
project/
├── agents/
│   ├── game-designer/
│   │   └── CLAUDE.md          ← "You are a game designer..."
│   ├── sre/
│   │   ├── CLAUDE.md          ← "You are an SRE specialist..."
│   │   └── .pi/skills/        ← SRE-specific skills
│   └── narrative/
│       └── CLAUDE.md          ← "You are a narrative designer..."
```

```typescript
subagent({ name: "Game Designer", cwd: "agents/game-designer", task: "Design the combat system" });
subagent({ name: "SRE", cwd: "agents/sre", task: "Review deployment pipeline" });
```

Set a default `cwd` in agent frontmatter:

```yaml
---
name: game-designer
cwd: ./agents/game-designer
spawning: false
---
```

---

## Tools Widget

Every sub-agent session displays a compact tools widget showing available and denied tools. Toggle with `Ctrl+J`:

```
[scout] — 12 tools · 4 denied  (Ctrl+J)              ← collapsed
[scout] — 12 available  (Ctrl+J to collapse)          ← expanded
  read, bash, edit, write, todo, ...
  denied: subagent, subagents_list, ...
```

---

## Requirements

- [pi](https://github.com/earendil-works/pi) 1.3.x, minimum 1.3.0. The extension is tested on this line only.
- [herdr-tui](https://herdr.dev) with the `herdr` CLI, or herdr-core with `hc` or `herdr-core` on `PATH`.

```bash
herdr
pi
```

Use `hc run pi` for herdr-core. Other terminal backends are not supported.

---

## Acknowledgements

The sub-agent status supervision and turn-only interruption features were inspired by [RepoPrompt](https://repoprompt.com/)'s sub-agent snapshot polling and run cancellation features.

---

## License

MIT
