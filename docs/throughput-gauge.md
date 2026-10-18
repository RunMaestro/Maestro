---
title: Throughput Gauge
description: A floating gauge that shows how many tokens per second your agents are reading and writing, live, with a peak mark.
icon: gauge-high
---

The Throughput Gauge is a small floating instrument that shows the tokens per second your agents are moving right now. It reads **In** (tokens your agents read: new input and cache writes) and **Out** (tokens they write), averages them over a short window, and marks the highest reading since you last reset it.

The gauge is an [Encore Feature](/encore-features), off by default. It ships as the first-party **Throughput Gauge** plugin.

## Turning it on

Open **Settings -> Encore**, find **Throughput Gauge**, and enable it. Or, from a shell:

```bash
maestro-cli encore enable throughput-gauge
```

The gauge pops up as soon as you turn it on. Turning it off removes the gauge and stops all capture. Nothing keeps listening in the background, and the readings and peak are cleared, so turning it back on starts from zero.

## Showing and hiding it

| Method          | How                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------- |
| Hotkey          | `Opt+Cmd+Shift+T` / `Alt+Ctrl+Shift+T` toggles the gauge                                     |
| Command palette | `Cmd+K` / `Ctrl+K`, then "Show Throughput Gauge" (or "Hide Throughput Gauge" while it is up) |
| Hamburger menu  | **Throughput Gauge** in the Left Bar menu                                                    |
| Close control   | The X on the card, or Escape while the card has focus                                        |

Closing the card hides it. Capture keeps running while it is hidden, so the peak and the averages are current when you bring it back.

## Settings

Set these from the gear on the gauge, from the settings in the Encore tile, or with `maestro-cli throughput-gauge set`.

| Setting | Choices                  | Default    | What it changes                                                        |
| ------- | ------------------------ | ---------- | ---------------------------------------------------------------------- |
| Scope   | All agents, Active agent | All agents | Whose output the gauge counts                                          |
| Metric  | Combined, In, Out        | Combined   | Which reading the needle or digits show. Combined is In + Out          |
| Layout  | One, All three           | One        | One gauge for the chosen metric, or In, Out, and Combined side by side |
| Style   | Dial, VU, LCD, Sparkline | Dial       | How the reading is drawn (see below)                                   |
| Window  | 5s, 10s, 30s, 60s        | 10s        | The rolling average. Shorter reacts faster; longer steadies the number |

Picking a scope, metric, layout, or style from the command palette also shows the gauge, because changing how it looks is asking to look at it.

## Styles

- **Dial**: an analog speedometer with a needle. The default.
- **VU**: a segmented bar meter, the look of a level meter.
- **LCD**: a digital numeric readout.
- **Sparkline**: a trend line of recent readings, for seeing bursts and lulls.

Every style prints the same unit, `tok/s`, and a legend line that names the metric it measures.

## Peak and reset

The gauge keeps the highest reading per metric since the last reset, and draws it as a peak mark. To start the peak again from the current reading, use **Reset peak** under the gear, or run **Reset Throughput Gauge Peak** from the command palette. Changing the scope or the window starts the readings over, which clears the peak as well. Turning the feature off clears it too.

## How the number is estimated, then corrected

Streamed text is the only signal that arrives while a turn runs, so the gauge estimates output tokens from the text as it streams. Providers report the real token counts only when a turn ends. When that report arrives, the gauge adds whatever the real count exceeds the estimate by, and never subtracts. The live number can therefore run a little low during a turn (tool calls and redacted thinking never stream as text), and it lands on the provider's count once the turn finishes. In rare cases a provider repeats part of a reply, and the estimate can overshoot slightly. The gauge does not claw that back, so a reading never goes negative.

Input comes only from the provider's usage reports.

### Cache reads are not counted as input

Tokens read count new input and cache writes. **Cache reads are left out on purpose.** A cache read re-reads context the provider already holds, and in a resumed session that is nearly all of the input. Counting it would pin the needle on every turn and hide the work that actually changed.

## Agents whose turns do not reach the gauge

- **Group chat** moderators and participants. Their output stays in the main process, so the gauge does not count it. Only agent tabs, Auto Run, and synopsis turns are counted.

## CLI

Every verb answers with the gauge's status, so a script can check what it just did.

| Command                                                    | What it does                                          |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| `maestro-cli throughput-gauge show`                        | Show the card                                         |
| `maestro-cli throughput-gauge hide`                        | Hide the card (capture keeps running)                 |
| `maestro-cli throughput-gauge toggle`                      | Show or hide, whichever is the opposite of now        |
| `maestro-cli throughput-gauge set --style lcd --window 30` | Change one or more settings. `--window` is in seconds |
| `maestro-cli throughput-gauge reset-peak`                  | Start the peak mark again from the current reading    |
| `maestro-cli throughput-gauge status --json`               | Read the live rate, peak, settings, and visibility    |

Example `status --json` output, with illustrative values:

```json
{
	"enabled": true,
	"visible": true,
	"settings": {
		"scope": "all",
		"metric": "combined",
		"layout": "single",
		"style": "dial",
		"windowMs": 10000
	},
	"rates": { "in": 412, "out": 96, "combined": 508 },
	"peak": { "in": 1830, "out": 240, "combined": 2010 },
	"windowMs": 10000
}
```

`rates` and `peak` are in tokens per second. `combined` is always `in + out`.

## Related

- [Keyboard Shortcuts](/keyboard-shortcuts): the full shortcut list
- [Encore Features](/encore-features): every opt-in feature and how to enable it
- [Concerto](/concerto): the other always-available visual surface
