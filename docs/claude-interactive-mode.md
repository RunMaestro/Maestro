---
title: Claude Adaptive Mode
description: Spend Claude Max plan time-bucketed quota first and auto-fall back to API billing only when limits hit.
icon: shuffle
---

Claude Code has two cost models: **API Limits** (every token bills against your Anthropic API key via `claude --print`) and **Time Limits** (a 5-hour rolling window plus a 7-day window, both flat-rate against your Claude Max plan, accessed by driving the interactive TUI). Maestro can spend a Max plan's Time Limits transparently and only fall back to API billing when those quotas hit — saving real dollars on long sessions.

<Note>
This is opt-in per agent. New agents default to API Limits. If you don't have a Claude Max subscription, leave the toggle off and ignore this page.
</Note>

## How It Works

Behind the scenes, Maestro ships a small Node wrapper called `maestro-p` that drives Claude's interactive TUI under the hood, sends your prompt, and tails the structured JSONL transcript Claude writes to `~/.claude/projects/<project>/<session>.jsonl` per session. Each turn produces the same `assistant` / `tool_use` / `tool_result` / `result` envelope Maestro renders for `claude --print`, so tool cards, code blocks, diffs, and cost summaries all look identical regardless of which path the turn ran through.

When an agent has Adaptive Mode enabled, the spawner picks per turn:

- **Time Limits available** → spawn `maestro-p`. Turns burn down the Max plan's 5-hour and 7-day windows; the Anthropic API key is never charged. This is the preferred path.
- **5-hour or 7-day window at or above 99%** → fall back to `claude --print`. Turns bill against API credits. A 1% buffer is kept so a turn doesn't get killed mid-stream by Anthropic hitting the wall.
- **Already on the API fallback** → stay on `claude --print` until **both** the 5-hour and 7-day windows have rolled over. Both must be available again before the spawner will return to Time Limits, since either one being exhausted is enough to break a Max-plan turn.
- **No usage snapshot cached** → default to Time Limits. The next `maestro-p --status` refresh on startup populates the snapshot.

SSH-enabled agents always stay on the API path — the wrapper needs the real `claude` TUI binary on the local machine.

## Enabling Adaptive Mode

In the **New Agent** dialog or **Edit Agent** modal, look under the **Path** field for the **Adaptive Mode** card. Flip the toggle on:

- The default **Maestro-P Path** uses the script bundled with Maestro (`maestro-p.js` under your app's resources directory). The detected path is shown beneath the input — you only need to type a value if you're pointing at a custom build.
- The toggle is per-agent. You can leave it off for one Claude agent and on for another in the same Maestro window.

The first time an Adaptive Mode agent runs, Maestro samples `maestro-p --status` on startup to seed the usage snapshot for that account.

## Seeing Your Quota

When Adaptive Mode is on and a snapshot is available, the **Context Window** popover (the green bar in the tab header) grows an **Adaptive Mode** section:

- **Current** — which path the next turn will run through (Time Limits or API Limits).
- **5-hour** — a colored bar showing usage against the 5-hour window plus the relative time until it resets.
- **Weekly** — the same shape against the 7-day all-models window.

Colors track the same threshold the spawner uses: green under 70%, yellow 70–98%, red at 99%+.

## Multi-Account Setup

`maestro-p` inherits `CLAUDE_CONFIG_DIR` the same way the regular `claude` binary does, so combining Adaptive Mode with the [multi-account symlink setup](/multi-claude) gives you per-account Max plan spending. Set `CLAUDE_CONFIG_DIR` in the agent's **Environment Variables** to point at the account directory, and the snapshot store keys quotas by the canonical config-dir path so each account is tracked independently.

## Caveats

- **Cold-start latency.** Interactive turns pay roughly 2–5 seconds while the TUI initializes. For a single one-shot prompt that's noticeable; for a multi-turn conversation it amortizes well below the cost of a fresh API call.
- **Mid-turn limit hit.** If `maestro-p` runs out of Max plan quota partway through a turn, the wrapper exits with code 2 and the partial assistant output is preserved. The sticky-limit logic ensures the **next** prompt automatically runs under API Limits — re-send your message to continue under API billing.
- **Claude Code only.** `maestro-p` wraps the Claude TUI specifically. Codex, OpenCode, Factory Droid, and other providers are unaffected by this setting.
- **Snapshot freshness.** Usage data is sampled at startup and persists between sessions. If your Max plan resets while Maestro is closed, the first turn after restart may briefly route to API Limits before the next sample updates the store.
