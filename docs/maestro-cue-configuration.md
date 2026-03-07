---
title: Cue Configuration Reference
description: Complete YAML schema reference for .maestro/cue.yaml configuration files.
icon: file-code
---

Cue is configured via a `.maestro/cue.yaml` file placed inside the `.maestro/` directory at your project root. The engine watches this file for changes and hot-reloads automatically.

## File Location

```
your-project/
├── .maestro/
│   └── cue.yaml        # Cue configuration
├── src/
├── package.json
└── ...
```

Maestro discovers this file automatically when the Cue Encore Feature is enabled. Each agent that has a `.maestro/cue.yaml` in its project root gets its own independent Cue engine instance.

## Full Schema

```yaml
# Subscriptions define trigger-prompt pairings
subscriptions:
  - name: string # Required. Unique identifier for this subscription
    event: string # Required. Event type (see Event Types)
    enabled: boolean # Optional. Default: true
    prompt: string # Required. Prompt text or path to a .md file

    # Event-specific fields
    interval_minutes: number # Required for time.interval
    watch: string # Required for file.changed, task.pending (glob pattern)
    source_session: string | list # Required for agent.completed
    fan_out: list # Optional. Target session names for fan-out
    filter: object # Optional. Payload field conditions
    repo: string # Optional for github.* (auto-detected if omitted)
    poll_minutes: number # Optional for github.*, task.pending

# Global settings (all optional — sensible defaults applied)
settings:
  timeout_minutes: number # Default: 30. Max run duration before timeout
  timeout_on_fail: string # Default: 'break'. What to do on timeout: 'break' or 'continue'
  max_concurrent: number # Default: 1. Simultaneous runs (1-10)
  queue_size: number # Default: 10. Max queued events (0-50)
```

## Subscriptions

Each subscription is a trigger-prompt pairing. When the trigger fires, Cue sends the prompt to the agent.

### Required Fields

| Field    | Type   | Description                                                            |
| -------- | ------ | ---------------------------------------------------------------------- |
| `name`   | string | Unique identifier. Used in logs, history, and as a reference in chains |
| `event`  | string | One of the six [event types](./maestro-cue-events)                     |
| `prompt` | string | The prompt to send, either inline text or a path to a `.md` file       |

### Optional Fields

| Field              | Type            | Default | Description                                                             |
| ------------------ | --------------- | ------- | ----------------------------------------------------------------------- |
| `enabled`          | boolean         | `true`  | Set to `false` to pause a subscription without removing it              |
| `interval_minutes` | number          | —       | Timer interval. Required for `time.interval`                            |
| `watch`            | string (glob)   | —       | File glob pattern. Required for `file.changed`, `task.pending`          |
| `source_session`   | string or list  | —       | Source agent name(s). Required for `agent.completed`                    |
| `fan_out`          | list of strings | —       | Target agent names to fan out to                                        |
| `filter`           | object          | —       | Payload conditions (see [Filtering](./maestro-cue-advanced#filtering))  |
| `repo`             | string          | —       | GitHub repo (`owner/repo`). Auto-detected from git remote               |
| `poll_minutes`     | number          | varies  | Poll interval for `github.*` (default 5) and `task.pending` (default 1) |

### Prompt Field

The `prompt` field accepts either inline text or a file path:

**Inline prompt:**

```yaml
prompt: |
  Please lint the file {{CUE_FILE_PATH}} and fix any errors.
```

**File reference:**

```yaml
prompt: prompts/lint-check.md
```

File paths are resolved relative to the project root. Prompt files support the same `{{VARIABLE}}` template syntax as inline prompts.

### Disabling Subscriptions

Set `enabled: false` to pause a subscription without deleting it:

```yaml
subscriptions:
  - name: nightly-report
    event: time.interval
    interval_minutes: 1440
    enabled: false # Paused — won't fire until re-enabled
    prompt: Generate a daily summary report.
```

## Settings

The optional `settings` block configures global engine behavior. All fields have sensible defaults — you only need to include settings you want to override.

### timeout_minutes

**Default:** `30` | **Type:** positive number

Maximum duration (in minutes) for a single Cue-triggered run. If an agent takes longer than this, the run is terminated.

```yaml
settings:
  timeout_minutes: 60 # Allow up to 1 hour per run
```

### timeout_on_fail

**Default:** `'break'` | **Type:** `'break'` or `'continue'`

What happens when a run times out:

- **`break`** — Stop the run and mark it as failed. No further processing for this event.
- **`continue`** — Stop the run but allow downstream subscriptions (in fan-in chains) to proceed with partial data.

```yaml
settings:
  timeout_on_fail: continue # Don't block the pipeline on slow agents
```

### max_concurrent

**Default:** `1` | **Type:** integer, 1–10

Maximum number of Cue-triggered runs that can execute simultaneously for this agent. Additional events are queued.

```yaml
settings:
  max_concurrent: 3 # Allow up to 3 parallel runs
```

### queue_size

**Default:** `10` | **Type:** integer, 0–50

Maximum number of events that can be queued when all concurrent slots are occupied. Events beyond this limit are dropped.

Set to `0` to disable queueing — events that can't run immediately are discarded.

```yaml
settings:
  queue_size: 20 # Buffer up to 20 events
```

## Validation

The engine validates your YAML on every load. Common validation errors:

| Error                                   | Fix                                                          |
| --------------------------------------- | ------------------------------------------------------------ |
| `"name" is required`                    | Every subscription needs a unique `name` field               |
| `"event" is required`                   | Specify one of the six event types                           |
| `"prompt" is required`                  | Provide inline text or a file path                           |
| `"interval_minutes" is required`        | `time.interval` events must specify a positive interval      |
| `"watch" is required`                   | `file.changed` and `task.pending` events need a glob pattern |
| `"source_session" is required`          | `agent.completed` events need the name of the source agent   |
| `"max_concurrent" must be between 1-10` | Keep concurrent runs within the allowed range                |
| `"queue_size" must be between 0-50`     | Keep queue size within the allowed range                     |
| `filter key must be string/number/bool` | Filter values only accept primitive types                    |

The inline YAML editor in the Cue Modal shows validation errors in real-time as you type.

## Complete Example

A realistic configuration demonstrating multiple event types working together:

```yaml
subscriptions:
  # Lint TypeScript files on save
  - name: lint-on-save
    event: file.changed
    watch: 'src/**/*.ts'
    filter:
      extension: '.ts'
    prompt: |
      The file {{CUE_FILE_PATH}} was modified.
      Run `npx eslint {{CUE_FILE_PATH}} --fix` and report any remaining issues.

  # Run tests every 30 minutes
  - name: periodic-tests
    event: time.interval
    interval_minutes: 30
    prompt: |
      Run the test suite with `npm test`.
      If any tests fail, investigate and fix them.

  # Review new PRs automatically
  - name: pr-review
    event: github.pull_request
    poll_minutes: 3
    filter:
      draft: false
    prompt: |
      A new PR needs review: {{CUE_GH_TITLE}} (#{{CUE_GH_NUMBER}})
      Author: {{CUE_GH_AUTHOR}}
      Branch: {{CUE_GH_BRANCH}} -> {{CUE_GH_BASE_BRANCH}}
      URL: {{CUE_GH_URL}}

      {{CUE_GH_BODY}}

      Please review this PR for code quality, potential bugs, and style issues.

  # Work on pending tasks from TODO.md
  - name: task-worker
    event: task.pending
    watch: 'TODO.md'
    poll_minutes: 5
    prompt: |
      There are {{CUE_TASK_COUNT}} pending tasks in {{CUE_TASK_FILE}}:

      {{CUE_TASK_LIST}}

      Pick the highest priority task and complete it.
      When done, check off the task in the file.

  # Chain: deploy after tests pass
  - name: deploy-after-tests
    event: agent.completed
    source_session: 'test-runner'
    filter:
      status: completed
      exitCode: 0
    prompt: |
      Tests passed successfully. Deploy to staging with `npm run deploy:staging`.

settings:
  timeout_minutes: 45
  max_concurrent: 2
  queue_size: 15
```
