---
title: Maestro Cue
description: Event-driven automation that triggers agent prompts in response to file changes, timers, agent completions, GitHub activity, and pending tasks.
icon: bolt
---

Maestro Cue is an event-driven automation engine that watches for things happening in your projects and automatically sends prompts to your agents in response. Instead of manually kicking off tasks, you define **subscriptions** — trigger-prompt pairings — in a YAML file, and Cue handles the rest.

<Note>
Maestro Cue is an **Encore Feature** — it's disabled by default. Enable it in **Settings > Encore Features** to access the shortcut, modal, and automation engine.
</Note>

![Encore Features settings panel](./screenshots/encore-features.png)

## What Can Cue Do?

A few examples of what you can automate with Cue:

- **Run linting whenever TypeScript files change** — watch `src/**/*.ts` and prompt an agent to lint on every save
- **Generate a daily standup summary** — fire every 60 minutes to scan recent git activity and draft a report
- **Chain agents together** — when your build agent finishes, automatically trigger a test agent, then a deploy agent
- **Triage new GitHub PRs** — poll for new pull requests and prompt an agent to review the diff
- **Track TODO progress** — scan markdown files for unchecked tasks and prompt an agent to work on the next one
- **Fan out deployments** — when a build completes, trigger multiple deploy agents simultaneously

## Enabling Cue

1. Open **Settings** (`Cmd+,` / `Ctrl+,`)
2. Navigate to the **Encore Features** tab
3. Toggle **Maestro Cue** on

Once enabled, Maestro automatically scans all your active agents for `maestro-cue.yaml` files in their project roots. The Cue engine starts immediately — no restart required.

## Quick Start

Create a file called `maestro-cue.yaml` in the root of any project that has an active Maestro agent:

```yaml
subscriptions:
  - name: lint-on-save
    event: file.changed
    watch: 'src/**/*.ts'
    prompt: |
      The file {{CUE_FILE_PATH}} was just modified.
      Please run the linter and fix any issues.
```

That's it. Whenever a `.ts` file in `src/` changes, Cue sends that prompt to the agent with the file path filled in automatically.

## The Cue Modal

Open the Cue dashboard to monitor and manage all automation activity.

**Keyboard shortcut:**

- macOS: `Cmd+Shift+Q`
- Windows/Linux: `Ctrl+Shift+Q`

**From Quick Actions:**

- Press `Cmd+K` / `Ctrl+K` and search for "Maestro Cue"

### Sessions Table

The primary view shows all agents that have a `maestro-cue.yaml` file:

<!-- ![Cue Modal sessions table](./screenshots/cue-modal-sessions.png) -->

| Column             | Description                                      |
| ------------------ | ------------------------------------------------ |
| **Session**        | Agent name                                       |
| **Agent**          | Provider type (Claude Code, Codex, etc.)         |
| **Status**         | Green dot = active, yellow = paused, gray = none |
| **Last Triggered** | How long ago the most recent event fired         |
| **Subs**           | Number of subscriptions in the YAML              |
| **Queue**          | Events waiting to be processed                   |
| **Edit**           | Opens the inline YAML editor for that agent      |

### Active Runs

Shows currently executing Cue-triggered prompts with elapsed time and which subscription triggered them.

### Activity Log

A chronological record of completed and failed runs. Each entry shows:

- Subscription name and event type
- Status (completed, failed, timeout, stopped)
- Duration
- Timestamp

### YAML Editor

Click the edit button on any session row to open the inline YAML editor. Changes are validated in real-time — errors appear immediately so you can fix them before saving. The engine hot-reloads your config automatically when the file changes.

### Help

Built-in reference guide accessible from the modal header. Covers configuration syntax, event types, and template variables.

## Configuration File

Cue is configured via a `maestro-cue.yaml` file placed in your project root (the same directory where your agent runs). See the [Configuration Reference](./maestro-cue-configuration) for the complete YAML schema.

## Event Types

Cue supports six event types that trigger subscriptions:

| Event Type            | Trigger                            | Key Fields             |
| --------------------- | ---------------------------------- | ---------------------- |
| `time.interval`       | Periodic timer                     | `interval_minutes`     |
| `file.changed`        | File created, modified, or deleted | `watch` (glob pattern) |
| `agent.completed`     | Another agent finishes a task      | `source_session`       |
| `task.pending`        | Unchecked markdown tasks found     | `watch` (glob pattern) |
| `github.pull_request` | New PR opened on GitHub            | `repo` (optional)      |
| `github.issue`        | New issue opened on GitHub         | `repo` (optional)      |

See [Event Types](./maestro-cue-events) for detailed documentation and examples for each type.

## Template Variables

Prompts support `{{VARIABLE}}` syntax for injecting event data. When Cue fires a subscription, it replaces template variables with the actual event payload before sending the prompt to the agent.

```yaml
prompt: |
  A new PR was opened: {{CUE_GH_TITLE}} (#{{CUE_GH_NUMBER}})
  Author: {{CUE_GH_AUTHOR}}
  Branch: {{CUE_GH_BRANCH}} -> {{CUE_GH_BASE_BRANCH}}
  URL: {{CUE_GH_URL}}

  Please review this PR and provide feedback.
```

See [Advanced Patterns](./maestro-cue-advanced) for the complete template variable reference.

## Advanced Features

Cue supports sophisticated automation patterns beyond simple trigger-prompt pairings:

- **[Fan-out](./maestro-cue-advanced#fan-out)** — One trigger fires against multiple target agents simultaneously
- **[Fan-in](./maestro-cue-advanced#fan-in)** — Wait for multiple agents to complete before triggering
- **[Payload filtering](./maestro-cue-advanced#filtering)** — Conditionally trigger based on event data (glob matching, comparisons, negation)
- **[Agent chaining](./maestro-cue-advanced#agent-chaining)** — Build multi-step pipelines where each agent's output feeds the next
- **[Concurrency control](./maestro-cue-advanced#concurrency-control)** — Limit simultaneous runs and queue overflow events

See [Advanced Patterns](./maestro-cue-advanced) for full documentation.

## Keyboard Shortcuts

| Shortcut                       | Action         |
| ------------------------------ | -------------- |
| `Cmd+Shift+Q` / `Ctrl+Shift+Q` | Open Cue Modal |
| `Esc`                          | Close modal    |

## History Integration

Cue-triggered runs appear in the History panel with a teal **CUE** badge. Each entry records:

- The subscription name that triggered it
- The event type
- The source session (for agent completion chains)

Filter by CUE entries in the History panel or in Director's Notes (when both Encore Features are enabled) to isolate automated activity from manual work.

## Requirements

- **GitHub CLI (`gh`)** — Required only for `github.pull_request` and `github.issue` events. Must be installed and authenticated (`gh auth login`).
- **File watching** — `file.changed` and `task.pending` events use filesystem watchers. No additional dependencies required.

## Tips

- **Start simple** — Begin with a single `file.changed` or `time.interval` subscription before building complex chains
- **Use the YAML editor** — The inline editor validates your config in real-time, catching errors before they reach the engine
- **Check the Activity Log** — If a subscription isn't firing, the activity log shows failures with error details
- **Prompt files vs inline** — For complex prompts, point the `prompt` field at a `.md` file instead of inlining YAML
- **Hot reload** — The engine watches `maestro-cue.yaml` for changes and reloads automatically — no need to restart Maestro
- **Template variables** — Use `{{CUE_TRIGGER_NAME}}` in prompts so the agent knows which automation triggered it
