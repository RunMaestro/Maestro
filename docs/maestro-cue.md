---
title: Cue Overview
description: Event-driven automation that triggers agent prompts in response to file changes, timers, agent completions, GitHub activity, and pending tasks.
icon: bolt
---

Maestro Cue is an event-driven automation engine that watches for things happening in your projects and automatically sends prompts to your agents in response. Instead of manually kicking off tasks, you define **subscriptions** — trigger-prompt pairings — in a YAML file, and Cue handles the rest.

<Note>
Maestro Cue is an **Encore Feature** — it's disabled by default. Enable it in **Settings > Encore Features** to access the shortcut, modal, and automation engine.
</Note>

## What Can Cue Do?

A few examples of what you can automate with Cue:

- **Run linting whenever TypeScript files change** — watch `src/**/*.ts` and prompt an agent to lint on every save
- **Generate a morning standup** — schedule at 9:00 AM on weekdays to scan recent git activity and draft a report
- **Chain agents together** — when your build agent finishes, automatically trigger a test agent, then a deploy agent
- **Triage new GitHub PRs** — poll for new pull requests and prompt an agent to review the diff
- **Track TODO progress** — scan markdown files for unchecked tasks and prompt an agent to work on the next one
- **Fan out deployments** — when a build completes, trigger multiple deploy agents simultaneously
- **Trigger from the CLI** — run `maestro-cli cue trigger` to fire a subscription on demand from scripts, CI/CD, or other agents

## Enabling Cue

1. Open **Settings** (`Cmd+,` / `Ctrl+,`)
2. Navigate to the **Encore Features** tab
3. Toggle **Maestro Cue** on

Once enabled, Maestro automatically scans all your active agents for `.maestro/cue.yaml` files in their project roots. The Cue engine starts immediately — no restart required.

## Quick Start

Create a file called `.maestro/cue.yaml` in your project (inside the `.maestro/` directory at the project root):

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

Open the Cue modal to monitor and manage all automation activity.

**Keyboard shortcut:**

- macOS: `Option+Q`
- Windows/Linux: `Alt+Q`

**From Quick Actions:**

- Press `Cmd+K` / `Ctrl+K` and search for "Maestro Cue"

The modal has three tabs — **Dashboard**, **Pipeline Editor**, and **Activity Log** — plus a **Help** button and an **Enabled** master toggle in the header that starts and stops the engine globally.

## Dashboard

The Dashboard tab summarizes engine state at the top (Pipelines, Total Executions, Active Runs, Agents) and lists every agent that has a Cue configuration:

![Cue Dashboard](./screenshots/cue-dashboard.png)

| Column             | Description                                                  |
| ------------------ | ------------------------------------------------------------ |
| **Session**        | Agent name                                                   |
| **Agent**          | Provider type (Claude Code, Codex, OpenCode, etc.)           |
| **Pipelines**      | Color-coded dots for each pipeline configured on this agent  |
| **Status**         | Green = active, yellow = paused, "No Config" = no YAML found |
| **Last Triggered** | How long ago the most recent event fired                     |
| **Subs**           | Number of subscriptions in the YAML                          |
| **Queue**          | Events waiting to be processed                               |

Each row has three action buttons:

- **Run Now** — Manually trigger a subscription on demand, bypassing its normal event conditions. Useful for testing new subscriptions or re-running a failed automation without waiting for the next event.
- **Edit YAML** — Open the inline YAML editor for that agent.
- **View in Pipeline** — Jump to the Pipeline Editor filtered to that agent.

Below the sessions table, the **Active Runs** section lists subscriptions that are currently executing, with a **Stop** button for each.

## Pipeline Editor

The Pipeline Editor tab visualizes your Cue subscriptions as a node graph — triggers on the left, agents on the right, with edges showing how events flow through your automation.

![All Pipelines](./screenshots/cue-pipelines.png)

Each pipeline is color-coded and labeled. Trigger nodes show the event type and configuration (glob patterns, schedule times, etc.), while agent nodes show the provider type. Pipelines from all agents are displayed together so you can see cross-agent relationships at a glance.

A pipeline can contain **multiple trigger lines** — for example, a daily scan and a weekly review grouped under a single "Monitoring" pipeline. Use the `# Pipeline:` comment and `-chain-N` naming convention in your YAML to group subscriptions. See [Pipelines](./maestro-cue-configuration#pipelines) in the Configuration Reference for details.

### Inspecting a Pipeline

Pick a pipeline from the **All Pipelines** dropdown in the top bar, or click any node, to drill into a single pipeline. The **Triggers** drawer (left) and **Agents** drawer (right) toggle from the toolbar and show full configuration details. Selecting a node reveals its details inline at the bottom — including the prompt text for an agent node.

![Pipeline Detail](./screenshots/cue-pipeline.png)

The Triggers drawer lists all event types with their configurations (filter patterns, poll intervals, etc.). The Agents drawer shows all available agents grouped by project with status indicators.

Use the **Switch to Agent** link to jump directly to that agent's workspace.

## Activity Log

The Activity Log tab is a chronological record of every completed, failed, timed-out, or stopped run. The header offers a search box and an **Expand all / Collapse all** toggle.

![Cue Activity Log](./screenshots/cue-activity-log.png)

Each entry shows:

- Timestamp (just the time for today's runs, full date for older)
- Pipeline color dot and subscription name
- Trigger type (e.g. `(file.changed)`, `(github.pull_request)`)
- Status (completed in N seconds, failed, timeout, stopped) with a duration

Click any row — or use **Expand all** — to reveal the full event data: payload fields, run ID, exit code, and any captured stdout/stderr. The search box matches against subscription name, pipeline, file paths, PR titles, and the body of run output.

![Activity Log Detail](./screenshots/cue-activity-log-detail.png)

For `file.changed` events the payload includes the path, filename, directory, extension, and change type. For GitHub triggers it includes the PR/issue number, title, author, URL, and body.

## YAML Editor

Click **Edit YAML** on any Dashboard row to open the inline editor. The left column offers **pattern templates** (Startup, Heartbeat, Scheduled, Reactive, Sequential Chain, PR Review, Issue Triage, Task Queue, and more) — click one to insert a pre-configured subscription block. An **AI Assist** panel below lets you describe what you want in plain English and have the agent edit the config for you.

![Cue YAML Editor](./screenshots/cue-yaml-editor.png)

The right side shows your YAML with real-time validation — a green **Valid YAML** indicator appears at the bottom when the config parses correctly. Click **Save** to write the file; the engine hot-reloads automatically.

### AI Assist

Type a plain-English description of the subscription you want to add or change, and the agent edits the YAML for you. Useful for quickly scaffolding a new trigger without remembering field names.

![AI Assist](./screenshots/cue-yaml-editor-ai.png)

## Help

The header **?** button opens a built-in quick-reference guide covering Cue's purpose, getting started, the full event type list, template variables, and advanced patterns. Use it as an in-app cheat sheet; for the full schema and examples, see [Configuration Reference](./maestro-cue-configuration), [Event Types](./maestro-cue-events), and [Advanced Patterns](./maestro-cue-advanced).

![Cue Help](./screenshots/cue-help.png)

## Configuration File

Cue is configured via a `.maestro/cue.yaml` file placed inside the `.maestro/` directory at your project root. See the [Configuration Reference](./maestro-cue-configuration) for the complete YAML schema.

## Event Types

Cue supports nine event types that trigger subscriptions:

| Event Type            | Trigger                             | Key Fields                        |
| --------------------- | ----------------------------------- | --------------------------------- |
| `app.startup`         | Maestro launches                    | —                                 |
| `time.heartbeat`      | Periodic timer ("every N minutes")  | `interval_minutes`                |
| `time.scheduled`      | Specific times and days of the week | `schedule_times`, `schedule_days` |
| `file.changed`        | File created, modified, or deleted  | `watch` (glob pattern)            |
| `agent.completed`     | Another agent finishes a task       | `source_session`                  |
| `task.pending`        | Unchecked markdown tasks found      | `watch` (glob pattern)            |
| `github.pull_request` | New PR opened on GitHub             | `repo` (optional)                 |
| `github.issue`        | New issue opened on GitHub          | `repo` (optional)                 |
| `cli.trigger`         | Manual trigger via `maestro-cli`    | —                                 |

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

| Shortcut             | Action         |
| -------------------- | -------------- |
| `Option+Q` / `Alt+Q` | Open Cue Modal |
| `Esc`                | Close modal    |

## History Integration

Cue-triggered runs appear in the History panel with a teal **CUE** badge. Each entry records:

- The subscription name that triggered it
- The event type
- The source session (for agent completion chains)

Filter by CUE entries in the History panel or in Director's Notes (when both Encore Features are enabled) to isolate automated activity from manual work.

## Requirements

- **GitHub CLI (`gh`)** — Required only for `github.pull_request` and `github.issue` events. Must be installed and authenticated (`gh auth login`).
- **File watching** — `file.changed` and `task.pending` events use filesystem watchers. No additional dependencies required.
- **CLI triggers** — `cli.trigger` events require `maestro-cli` to be installed. See the [CLI documentation](./cli#cue-automation) for setup.

## Tips

- **Start simple** — Begin with a single `file.changed` or `time.heartbeat` subscription before building complex chains
- **Use the YAML editor** — The inline editor validates your config in real-time, catching errors before they reach the engine
- **Check the Activity Log** — If a subscription isn't firing, the activity log shows failures with error details
- **Prompt files vs inline** — For complex prompts, point the `prompt` field at a `.md` file instead of inlining YAML
- **Hot reload** — The engine watches `.maestro/cue.yaml` for changes and reloads automatically — no need to restart Maestro
- **Template variables** — Use `{{CUE_TRIGGER_NAME}}` in prompts so the agent knows which automation triggered it
