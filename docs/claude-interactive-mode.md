---
title: Claude Interactive Mode
description: Preserve your Claude Max plan quota by driving Claude's interactive TUI instead of billing per-token API calls.
icon: shuffle
---

Claude Code can run in two modes inside Maestro: **API mode** (the classic `claude --print` batch path, billed per token against your Anthropic API key) and **Interactive mode** (a headless wrapper that drives Claude's TUI under the hood and burns down your Claude Max plan quota instead). The default is **Auto** — Maestro picks the cheapest viable mode per turn, falls back automatically when a plan quota is exhausted, and shows you which mode is active on every tab.

<Note>
If you don't have a Claude Max subscription, leave the mode set to `API` and ignore this page. Interactive mode only saves money when you have a flat-rate plan to spend against.
</Note>

## What It Is

Claude Code's `--print` flag drives the model through Anthropic's API, which means every token costs against your API account. The same `claude` binary, run without `--print`, drives an interactive TUI session that bills against your Claude Max plan instead — but the TUI streams text to a terminal, not to a structured pipe Maestro can consume.

**maestro-p** is a small Rust binary that bridges the gap. It spawns `claude` in TUI mode, sends your prompt, and tails the structured JSONL transcript Claude writes to `~/.claude/projects/<project>/<session>.jsonl` per session. Each turn produces the same `assistant` / `tool_use` / `tool_result` / `result` blocks the API path emits, so Maestro's renderer treats both modes the same way — tool cards, code blocks, diffs, and cost summaries all render unchanged.

The net effect: **interactive turns cost zero API dollars** but still surface in Maestro with the same fidelity as API turns.

## How It Works

1. **Phase 1 — the `maestro-p` binary.** A standalone Rust binary that spawns `claude` (no `--print`), sends prompts, watches the session JSONL file, and re-emits each line on its own stdout. The TUI exits when the turn completes; maestro-p exits with the same status (or code 2 if the run hit a quota limit mid-turn).
2. **Phase 2 — Maestro integration.** When the mode resolver decides a turn should run interactively, Maestro spawns `maestro-p` instead of `claude --print` and pipes its stdout into the existing parser. The transcript format is identical.
3. **Phase 3 — auto-switching, badges, and dashboards.** Maestro samples your Claude Max plan usage at startup and after every turn, picks the cheapest viable mode per turn, and surfaces the choice via a per-tab badge and a Usage Dashboard section.

The mode decision happens _before_ spawn, not after — Maestro looks at the latest plan-usage snapshot for the active `CLAUDE_CONFIG_DIR` and routes the turn to whichever binary will succeed. If the snapshot is stale and the interactive run trips a quota limit mid-turn, Maestro respawns the same turn under `claude --print` transparently and the user sees one continuous response with a single badge transition.

## Auto-Switching Behavior

When `claudeCode.headlessMode` is set to `Auto` (the default), each turn is routed by these rules:

- **Plan usage below 95%** → interactive mode. Badge: green `Terminal` icon, tooltip "Interactive (using Max plan quota for {account})".
- **Plan usage at or above 95%** → API mode, reason `auto`. Badge: blue `Cloud` icon, tooltip "API mode (billed per token)". The session keeps its mode preference until the next reset; once the plan window rolls over, the next turn flips back to interactive.
- **Interactive run exits with code 2 (quota hit mid-turn)** → API mode, reason `limit`. Maestro re-spawns the turn under `claude --print` with `--resume <sessionId>` and re-sends your prompt. Badge: orange `AlertTriangle` icon, tooltip "Auto-fell back to API (Max plan quota hit, resets {relative time})". Once the reset time passes, the next turn returns to interactive.

You can pin the mode manually from the tab's mode menu — pinned tabs ignore the auto-switcher and display a small `Lock` glyph on the badge so the choice is visible at a glance.

### Toggling the Mode

Three places change the mode:

- **Per-tab badge** (in the Left Bar agent row and the Main Panel header) — click to cycle Auto → Interactive (pinned) → API (pinned) → Auto.
- **Per-tab overlay menu** — three explicit choices, same cycle as the badge.
- **Global setting** — Settings → General → "Claude Headless Mode". Sets the default for new tabs without touching existing pinned tabs.

A separate `claudeCode.autoFallbackToApiOnLimit` toggle (default on) controls the code-2 mid-turn fallback. Disable it if you'd rather see the failed run surface as an error than have Maestro respawn under the API.

## Multi-Account Support

Interactive mode is per Claude account, which means it composes naturally with [running multiple Claude Code Max subscriptions](/multi-claude). Each Maestro agent can point at a different `CLAUDE_CONFIG_DIR`, and Maestro samples plan usage for each config directory independently.

The badge tooltip shows the short account name (the basename of `CLAUDE_CONFIG_DIR` — e.g., `.claude-personal` → `personal`, `.claude` → `default`) so you can tell at a glance which account's quota each tab is spending against.

### Per-Account Usage in the Dashboard

Open the [Usage Dashboard](/usage-dashboard) (`Opt+Cmd+U` / `Alt+Ctrl+U`) and look in the **Agent Overview** tab for the **Claude Plan Usage** section. You'll see one row per `CLAUDE_CONFIG_DIR` you've used, with three bars:

- **Session %** — current 5-hour window usage, with a countdown to the next reset.
- **Week (all models)** — your weekly plan total across every Claude model.
- **Week (Sonnet only)** — your weekly Sonnet sub-quota.

Bars turn yellow at 75%, red at 95% — the same thresholds the auto-switcher uses to flip a tab to API mode.

A **Refresh** button at the section header re-samples every account on demand. The same button is mirrored in **Settings → General → Claude Interactive Mode** for one-click rechecking.

## Tradeoffs and Limitations

**Latency.** Interactive mode pays a ~2–5 second cold-start cost per turn while the TUI initializes. For a single one-shot prompt this is noticeable; for a multi-turn conversation it amortizes well below the cost of opening a fresh API call. If you're sending isolated prompts where latency matters more than dollars, pin the tab to API mode.

**Tool calls work normally.** The JSONL transcript carries `tool_use` and `tool_result` blocks the same way the API stream does, so file edits, bash commands, web fetches, and every other Claude Code tool render with their normal cards. There's no degraded "text-only" experience.

**Mixed history.** A single tab's scrollback can interleave interactive and API turns — for example, if a turn auto-falls-back to API mid-conversation, or if you toggle the mode by hand. Both styles render with the same tool-card / diff / code-block pipeline; the only visible marker is a small **"Captured via interactive TUI"** pill in the corner of interactive turns. Cost figures, token counts, and session-resume all continue to work across the mix.

**No mid-turn user input.** Like the API path, Maestro's interactive integration uses Claude's batch loop — you can't inject a new message between tool calls inside a single agentic turn. New input queues for the next turn via `--resume`. See [Provider Notes](/provider-notes) for the broader batch-mode caveats that apply to both modes.

**Usage snapshot drift.** The plan-usage figure Maestro decides against is sampled, not live. If you've been running `claude` outside Maestro and used up your quota since the last sample, the first turn after that may try interactive, hit code 2, and fall back to API. The mid-turn respawn is designed to make this invisible, but the first failed run still happens.

**Claude Code only.** Interactive mode is specific to Claude Code's TUI. Codex, OpenCode, Factory Droid, and other providers run with their normal `--print` / `exec` paths and are unaffected by the `claudeCode.headlessMode` setting.

## Related

- [Multiple Claude Accounts](/multi-claude) — set up `CLAUDE_CONFIG_DIR` for per-account routing.
- [Provider Notes](/provider-notes) — what Claude Code's batch mode does and doesn't support.
- [Usage Dashboard](/usage-dashboard) — where the per-account quota bars live.
