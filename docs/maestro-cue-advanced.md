---
title: Cue Advanced Patterns
description: Fan-in/fan-out, payload filtering, agent chaining, template variables, and concurrency control.
icon: diagram-project
---

Cue supports sophisticated automation patterns beyond simple trigger-prompt pairings. This guide covers the advanced features that enable complex multi-agent workflows.

## Fan-Out

Fan-out sends a single trigger's prompt to multiple target agents simultaneously. Use this when one event should kick off parallel work across several agents.

**How it works:** Add a `fan_out` field with a list of agent names. When the trigger fires, Cue spawns a run against each target agent.

```yaml
subscriptions:
  - name: parallel-deploy
    event: agent.completed
    source_session: 'build-agent'
    fan_out:
      - 'deploy-staging'
      - 'deploy-production'
      - 'deploy-docs'
    prompt: |
      Build completed. Deploy the latest artifacts.
      Source output: {{CUE_SOURCE_OUTPUT}}
```

In this example, when `build-agent` finishes, Cue sends the same prompt to three different agents in parallel.

**Notes:**

- Each fan-out target runs independently — failures in one don't affect others
- All targets receive the same prompt with the same template variable values
- Fan-out targets must be agent names visible in the Left Bar
- Fan-out respects `max_concurrent` — if slots are full, excess runs are queued

## Fan-In

Fan-in waits for **multiple** source agents to complete before firing a single trigger. Use this to coordinate work that depends on several agents finishing first.

**How it works:** Set `source_session` to a list of agent names. Cue waits for all of them to complete before firing the subscription.

```yaml
subscriptions:
  - name: integration-tests
    event: agent.completed
    source_session:
      - 'backend-build'
      - 'frontend-build'
      - 'api-tests'
    prompt: |
      All prerequisite agents have completed.
      Run the full integration test suite with `npm run test:integration`.

settings:
  timeout_minutes: 60 # Wait up to 60 minutes for all sources
  timeout_on_fail: continue # Fire anyway if timeout is reached
```

**Behavior:**

- Cue tracks completions from each source agent independently
- The subscription fires only when **all** listed sources have completed
- If `timeout_on_fail` is `'continue'`, the subscription fires with partial data after the timeout
- If `timeout_on_fail` is `'break'` (default), the subscription is marked as timed out and does not fire
- Completion tracking resets after the subscription fires

## Filtering

Filters let you conditionally trigger subscriptions based on event payload data. All filter conditions are AND'd — every condition must pass for the subscription to fire.

### Filter Syntax

Filters are key-value pairs where the key is a payload field name and the value is an expression:

```yaml
filter:
  field_name: expression
```

### Expression Types

| Expression     | Meaning               | Example                |
| -------------- | --------------------- | ---------------------- |
| `"value"`      | Exact string match    | `extension: ".ts"`     |
| `123`          | Exact numeric match   | `exitCode: 0`          |
| `true`/`false` | Exact boolean match   | `draft: false`         |
| `"!value"`     | Negation (not equal)  | `status: "!failed"`    |
| `">=N"`        | Greater than or equal | `taskCount: ">=3"`     |
| `">N"`         | Greater than          | `durationMs: ">60000"` |
| `"<=N"`        | Less than or equal    | `exitCode: "<=1"`      |
| `"<N"`         | Less than             | `poll_minutes: "<10"`  |
| `"*pattern*"`  | Glob pattern match    | `path: "**/src/**"`    |

### Dot Notation

Access nested payload fields using dot notation:

```yaml
filter:
  source.status: completed
  source.exitCode: 0
```

### Examples

**Only trigger on TypeScript file changes:**

```yaml
- name: ts-linter
  event: file.changed
  watch: 'src/**/*'
  filter:
    extension: '.ts'
  prompt: Lint {{CUE_FILE_PATH}}.
```

**Only trigger on non-draft PRs targeting main:**

```yaml
- name: pr-review
  event: github.pull_request
  filter:
    draft: false
    base_branch: main
  prompt: Review PR #{{CUE_GH_NUMBER}}.
```

**Only chain when the source agent succeeded:**

```yaml
- name: deploy
  event: agent.completed
  source_session: 'builder'
  filter:
    status: completed
    exitCode: 0
  prompt: Build succeeded. Deploy now.
```

**Only chain from a specific subscription** (when the source agent has multiple subscriptions):

```yaml
- name: review-feature
  event: agent.completed
  source_session: 'worker'
  filter:
    triggeredBy: 'implement-feature' # Ignores completions from other subscriptions
  prompt: Review the feature implementation.
```

The `triggeredBy` field contains the subscription name that triggered the completing run. It supports glob patterns (e.g., `triggeredBy: "deploy-*"`). See [Selective Chaining](./maestro-cue-examples#selective-chaining-with-triggeredby) for a full walkthrough.

**Trigger when there are 3 or more pending tasks:**

```yaml
- name: batch-tasks
  event: task.pending
  watch: 'TODO.md'
  filter:
    taskCount: '>=3'
  prompt: |
    {{CUE_TASK_COUNT}} tasks are pending. Work through them in priority order.
```

**Skip files in test directories:**

```yaml
- name: lint-src-only
  event: file.changed
  watch: '**/*.ts'
  filter:
    path: '!**/test/**'
  prompt: Lint {{CUE_FILE_PATH}}.
```

## Agent Chaining

Agent chaining connects multiple agents in a pipeline where each agent's completion triggers the next. This is built on `agent.completed` events with optional filtering.

### Simple Chain

```yaml
subscriptions:
  # Step 1: Lint
  - name: lint
    event: file.changed
    watch: 'src/**/*.ts'
    prompt: Run the linter on {{CUE_FILE_PATH}}.

  # Step 2: Test (after lint passes)
  - name: test-after-lint
    event: agent.completed
    source_session: 'lint-agent'
    filter:
      exitCode: 0
    prompt: Lint passed. Run the related test suite.

  # Step 3: Build (after tests pass)
  - name: build-after-test
    event: agent.completed
    source_session: 'test-agent'
    filter:
      exitCode: 0
    prompt: Tests passed. Build the project with `npm run build`.
```

### Diamond Pattern

Combine fan-out and fan-in for complex workflows:

```
          ┌─── backend-build ───┐
trigger ──┤                     ├── integration-tests
          └─── frontend-build ──┘
```

```yaml
subscriptions:
  # Fan-out: trigger both builds
  - name: parallel-builds
    event: file.changed
    watch: 'src/**/*'
    fan_out:
      - 'backend-agent'
      - 'frontend-agent'
    prompt: Source changed. Rebuild your component.

  # Fan-in: wait for both, then test
  - name: integration-tests
    event: agent.completed
    source_session:
      - 'backend-agent'
      - 'frontend-agent'
    prompt: Both builds complete. Run integration tests.
```

## Template Variables

All prompts support `{{VARIABLE}}` syntax. Variables are replaced with event payload data before the prompt is sent to the agent.

### Common Variables (All Events)

| Variable                  | Description                    |
| ------------------------- | ------------------------------ |
| `{{CUE_EVENT_TYPE}}`      | Event type that triggered this |
| `{{CUE_EVENT_TIMESTAMP}}` | ISO 8601 timestamp             |
| `{{CUE_TRIGGER_NAME}}`    | Subscription name              |
| `{{CUE_RUN_ID}}`          | Unique run UUID                |

### File Variables (`file.changed`, `task.pending`)

| Variable                   | Description                            |
| -------------------------- | -------------------------------------- |
| `{{CUE_FILE_PATH}}`        | Absolute file path                     |
| `{{CUE_FILE_NAME}}`        | Filename only                          |
| `{{CUE_FILE_DIR}}`         | Directory path                         |
| `{{CUE_FILE_EXT}}`         | Extension (with dot)                   |
| `{{CUE_FILE_CHANGE_TYPE}}` | Change type: `add`, `change`, `unlink` |

### Task Variables (`task.pending`)

| Variable                 | Description                             |
| ------------------------ | --------------------------------------- |
| `{{CUE_TASK_FILE}}`      | File path with pending tasks            |
| `{{CUE_TASK_FILE_NAME}}` | Filename only                           |
| `{{CUE_TASK_FILE_DIR}}`  | Directory path                          |
| `{{CUE_TASK_COUNT}}`     | Number of pending tasks                 |
| `{{CUE_TASK_LIST}}`      | Formatted list (line number: task text) |
| `{{CUE_TASK_CONTENT}}`   | Full file content (truncated to 10K)    |

### Agent Variables (`agent.completed`)

| Variable                      | Description                                   |
| ----------------------------- | --------------------------------------------- |
| `{{CUE_SOURCE_SESSION}}`      | Source agent name(s)                          |
| `{{CUE_SOURCE_OUTPUT}}`       | Source agent output (truncated to 5K)         |
| `{{CUE_SOURCE_STATUS}}`       | Run status (`completed`, `failed`, `timeout`) |
| `{{CUE_SOURCE_EXIT_CODE}}`    | Process exit code                             |
| `{{CUE_SOURCE_DURATION}}`     | Run duration in milliseconds                  |
| `{{CUE_SOURCE_TRIGGERED_BY}}` | Subscription that triggered the source run    |

### GitHub Variables (`github.pull_request`, `github.issue`)

| Variable                 | Description                 | PR  | Issue |
| ------------------------ | --------------------------- | --- | ----- |
| `{{CUE_GH_TYPE}}`        | `pull_request` or `issue`   | Y   | Y     |
| `{{CUE_GH_NUMBER}}`      | PR/issue number             | Y   | Y     |
| `{{CUE_GH_TITLE}}`       | Title                       | Y   | Y     |
| `{{CUE_GH_AUTHOR}}`      | Author login                | Y   | Y     |
| `{{CUE_GH_URL}}`         | HTML URL                    | Y   | Y     |
| `{{CUE_GH_BODY}}`        | Body text (truncated)       | Y   | Y     |
| `{{CUE_GH_LABELS}}`      | Labels (comma-separated)    | Y   | Y     |
| `{{CUE_GH_STATE}}`       | State (`open` / `closed`)   | Y   | Y     |
| `{{CUE_GH_REPO}}`        | Repository (`owner/repo`)   | Y   | Y     |
| `{{CUE_GH_BRANCH}}`      | Head branch                 | Y   |       |
| `{{CUE_GH_BASE_BRANCH}}` | Base branch                 | Y   |       |
| `{{CUE_GH_ASSIGNEES}}`   | Assignees (comma-separated) |     | Y     |

### Standard Variables

Cue prompts also have access to all standard Maestro template variables (like `{{PROJECT_ROOT}}`, `{{TIMESTAMP}}`, etc.) — the same variables available in Auto Run playbooks and system prompts.

## Concurrency Control

Control how many Cue-triggered runs can execute simultaneously and how overflow events are handled.

### max_concurrent

Limits parallel runs per agent. When all slots are occupied, new events are queued.

```yaml
settings:
  max_concurrent: 3 # Up to 3 runs at once
```

**Range:** 1–10. **Default:** 1 (serial execution).

With `max_concurrent: 1` (default), events are processed one at a time in order. This is the safest setting — it prevents agents from receiving overlapping prompts.

Increase `max_concurrent` when your subscriptions are independent and don't conflict with each other (e.g., reviewing different PRs, scanning different files).

### queue_size

Controls how many events can wait when all concurrent slots are full.

```yaml
settings:
  queue_size: 20 # Buffer up to 20 events
```

**Range:** 0–50. **Default:** 10.

- Events beyond the queue limit are **dropped** (silently discarded)
- Set to `0` to disable queuing — events that can't run immediately are discarded
- The current queue depth is visible in the Cue Modal's sessions table

### Timeout

Prevents runaway agents from blocking the pipeline.

```yaml
settings:
  timeout_minutes: 45 # Kill runs after 45 minutes
  timeout_on_fail: continue # Let downstream subscriptions proceed anyway
```

**`timeout_on_fail` options:**

- `break` (default) — Timed-out runs are marked as failed. Downstream `agent.completed` subscriptions see the failure.
- `continue` — Timed-out runs are stopped, but downstream subscriptions still fire with whatever data is available. Useful for fan-in patterns where you'd rather proceed with partial results than block the entire pipeline.

## Sleep/Wake Reconciliation

Cue handles system sleep gracefully:

- **`time.interval`** subscriptions reconcile missed intervals on wake. If your machine sleeps through three intervals, Cue fires one catch-up event (not three).
- **File watchers** (`file.changed`, `task.pending`) resume monitoring on wake. Changes that occurred during sleep may trigger events depending on the OS file system notification behavior.
- **GitHub pollers** resume polling on wake. Any PRs/issues created during sleep are detected on the next poll.

The engine uses a heartbeat mechanism to detect sleep periods. This is transparent — no configuration needed.

## Persistence

Cue persists its state in a local SQLite database:

- **Event journal** — Records all events (completed, failed, timed out) for the Activity Log
- **GitHub seen tracking** — Remembers which PRs/issues have already triggered events (30-day retention)
- **Heartbeat** — Tracks engine uptime for sleep/wake detection

Events older than 7 days are automatically pruned to keep the database lean.
