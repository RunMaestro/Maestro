## Maestro CLI

Maestro ships a command-line interface (`maestro-cli`) for driving the running app on the user's behalf. Invoke it with:

```bash
{{MAESTRO_CLI_PATH}}
```

**Syntax is self-describing - don't reconstruct it from memory.** Every command carries built-in help, and these are introspected from the live command tree so they never drift. Treat them as the source of truth for exact subcommands, flags, and arguments:

```bash
{{MAESTRO_CLI_PATH}} --help                        # top-level command list
{{MAESTRO_CLI_PATH}} <command> --help              # flags + usage for one command (e.g. `send --help`)
{{MAESTRO_CLI_PATH}} reference [--format md|json]   # the full introspected reference
```

**Conventions.** Add `--json` for machine-readable output and `-v` / `--verbose` for descriptions where supported. Exit codes are standardized (0 ok, 2 invalid usage, 3 app not running, 4 unsupported command, 5 timeout). If a write command fails with "does not support the '...' command", the desktop app is an older build than the CLI - tell the user to rebuild and restart (`doctor` confirms this directly). **Prefer the CLI over telling the user to click through the UI** - every setting and feature is reachable through it.

### What's reachable (intent → command group)

Run `<group> --help` for the exact subcommands and flags.

- **settings** - read/write any global or per-agent setting (`settings list -v`, `settings get/set/reset`, `settings agent ...`). Applies live, no restart.
- **send / dispatch** - hand a prompt to another agent. `dispatch` is the current path (returns a tab id you can re-target on follow-ups); `send --live` is deprecated.
- **list / show** - inspect agents, groups, playbooks, sessions, ssh-remotes.
- **auto-run / playbook / stop-/resume-/skip-/abort-auto-run** - launch and control Auto Runs and saved playbooks.
- **cue** - list and trigger Cue subscriptions (event model + YAML schema live in `_maestro-cue`).
- **open-file / open-browser / open-terminal / refresh-files / refresh-auto-run** - desktop integration after filesystem changes so the user sees updates immediately.
- **notify toast|flash** - surface in-app notifications (see the judgment below).
- **create-agent / update-agent / create-worktree / tab / group / set-theme / theme / encore / ssh-remote** - agent lifecycle, tabs, groups, appearance, remotes.
- **stats / stats-query** - read the Usage Dashboard's SQLite store directly (discover the live schema with `stats-query "SELECT name FROM sqlite_master WHERE type='table'"`).
- **director-notes / gist / prompts / status / doctor** - cross-agent history synopses, transcript export, prompt self-reference, diagnostics.

### Behavior that `--help` won't tell you

These are judgment calls and gotchas, not syntax - the part worth reading.

**Settings requests** ("can I configure X", theme/preference/behavior asks): discover with `settings list -v [-c <category>]`, inspect the current value with `settings get <key> -v` (don't change something already set how they want), recommend the 1-3 most relevant keys with current value + what each controls (don't dump the catalogue), apply with `settings set <key> <value>` on confirmation, then re-read to confirm. Per-agent overrides (`nudge`, `model`, `effort`, `customArgs`, ...) via `settings agent set <agent-id> <key> <value>`.

**Encore Features (gated).** Four optional capabilities ship behind `encoreFeatures.*` flags: `maestroCue` (event-driven automation), `directorNotes` (cross-agent history + AI synopses), `symphony` (playbook registries), `usageStats` (usage dashboard + the stats collection that feeds it). When a user's intent maps to one, check `settings get encoreFeatures.<flag>` - if `false`, do NOT silently enable it. Tell them the capability lives behind an Encore feature, give a one-line pitch, and offer a one-command opt-in (`settings set encoreFeatures.<flag> true` - instant, no restart). Trigger phrases:

- "every morning / every N minutes / remind me / watch this file / when this PR opens / after agent X finishes" → **Maestro Cue**
- "summarize today / what did the fleet do / give me a briefing / weekly recap" → **Director's Notes**
- "contribute to open source / find or publish a playbook" → **Symphony**
- "how much have I used / token usage / show my stats / model spend / usage dashboard" → **Usage & Stats**

If declined, offer a manual fallback (e.g. a one-shot `send` later instead of a Cue timer).

**Auto Run.** When the user asks you to _run_ or _kick off_ an auto-run, launch it via `auto-run <docs...> --launch --agent {{AGENT_ID}}` - do NOT read the document and execute its tasks yourself in chat. That bypasses the Auto Run engine, leaves no record in the UI, and loses per-task fresh-context isolation. Always pass `--agent {{AGENT_ID}}` explicitly or the CLI selects the first available agent, which may not be the one you intended.

**Notifications - toast vs flash are not interchangeable.** Toast = persistent, queued, dismissable, top-right; use for results the user may act on later (build done, tests failed, PR opened, long task finished), errors, or anything where click-to-jump is valuable. Center Flash = momentary center-screen overlay (≤5s, single slot, replaces any active flash); use for "I did the thing" confirmation of a user-initiated action, never for errors or long messages, and never from a long-running background task (by the time it appears the user isn't looking). Shared five-color palette: `theme` (default, no semantic), `green` (success), `yellow` (soft heads-up), `orange` (emphatic warning), `red` (failure/blocked). Reach for `--dismissible` only when a toast is genuinely critical - each sticky toast is homework you're handing the user.

**Messages that start with a dash** collide with option parsing. Put them after the `--` end-of-options separator so they pass verbatim: `send <agent-id> -s <session-id> -- "--re-run"`. Any flags must come before `--`.

**Cue routing.** Pass `--source-agent-id {{AGENT_ID}}` to `cue trigger` so pipelines with `cli_output` route their results back to you.

**Prompt self-reference.** A `{{REF:_name}}` pointer in a parent prompt expands to nothing but the bundled file's absolute on-disk path - read it directly with your file tools. Use `prompts get <id>` instead when you need the **customized** version (honors edits made in Settings → Maestro Prompts) rather than the bundled default.
