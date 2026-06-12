---
title: Cue Configuration
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

<Note>
**One cue.yaml per agent project root.** The engine reads ONLY `<projectRoot>/.maestro/cue.yaml` for each agent - it does not walk parent directories and does not fall back to any ancestor or workspace-wide config. If your fleet has agents at multiple project roots, you maintain one cue.yaml per root. See [Multi-root pipelines](#multi-root-pipelines-agents-in-different-project-roots) below.
</Note>

## Full Schema

```yaml
# Pipeline comment - groups subscriptions into a named pipeline in the UI
# Pipeline: My Pipeline (color: #06b6d4)

# Subscriptions define trigger-prompt pairings
subscriptions:
  - name: string # Required. Unique identifier for this subscription
    event: string # Required. Event type (see Event Types)
    enabled: boolean # Optional. Default: true
    prompt: string # Required (or use prompt_file). Inline prompt text
    prompt_file: string # Required (or use prompt). Path to a .md file
    output_prompt: string # Optional. Follow-up prompt sent after the main run completes
    output_prompt_file: string # Optional. Path to a .md file for the output prompt
    label: string # Optional. Human-readable label displayed in the Cue dashboard
    agent_id: string # Optional. UUID of the target agent

    # Event-specific fields
    interval_minutes: number # Required for time.heartbeat
    schedule_times: list # Required for time.scheduled (HH:MM strings)
    schedule_days: list # Optional for time.scheduled (mon, tue, wed, thu, fri, sat, sun)
    watch: string # Required for file.changed, task.pending (glob pattern)
    source_session: string | list # Required for agent.completed (display name or list of names)
    source_session_ids: string | list # Optional companion to source_session - agent UUID(s). Preferred at runtime; survives renames
    source_sub: string | list # Optional. Upstream subscription name(s) - required when action is "command". Aligns positionally with source_session arrays
    fan_out: list # Optional. Target agent display names for fan-out
    fan_out_ids: list # Optional companion to fan_out - agent UUIDs (parallel array). Preferred at runtime; survives renames
    filter: object # Optional. Payload field conditions
    repo: string # Optional for github.* (auto-detected if omitted)
    poll_minutes: number # Optional for github.*, task.pending

# Global settings (all optional - sensible defaults applied)
settings:
  timeout_minutes: number # Default: 30. Max run duration before timeout
  timeout_on_fail: string # Default: 'break'. What to do on timeout: 'break' or 'continue'
  max_concurrent: number # Default: 1. Simultaneous runs (1-10)
  queue_size: number # Default: 512. Max queued events (0-10000; 0 disables buffering)
  owner_agent_id: string # Optional. Pin this cue.yaml to a single agent (id or name). See "Sharing a workspace".
```

## Sharing a workspace across agents

When two or more agents are registered against the same project directory (for example, one agent using Opus and another using Sonnet, both pointing at the same vault), every _unowned_ subscription (one without an explicit `agent_id`) would otherwise fire once per agent. Maestro resolves this as follows:

- **`settings.owner_agent_id` set and matched by some agent in the root** - that agent is the owner; other agents in the same root skip unowned subscriptions.
- **`settings.owner_agent_id` set but matched by nobody** - the config is dead. Every agent in that project root skips unowned subscriptions, and each row in the Cue dashboard is flagged with a red warning linking to this setting.
- **`settings.owner_agent_id` unset and multiple agents share the root** - the first agent in the session list wins. Non-winner rows in the Cue dashboard are flagged with a red warning naming the winner and pointing to `owner_agent_id` as the override.

Accepted values for `owner_agent_id`: the agent's internal id (UUID) **or** its display name (e.g. `Obsidian`).

Subscriptions with an explicit `agent_id` continue to fan out independently of ownership - useful when a single shared config intentionally targets multiple agents in the same workspace.

## Multi-root pipelines (agents in different project roots)

When a pipeline spans agents that live in **different** project roots, it is physically multiple cue.yaml files - one per participating agent's project root. The engine never aggregates yaml across roots, so a "single root cue.yaml" is not a reliable pattern for a multi-root agent fleet.

**The rule:** Each subscription lives in the `.maestro/cue.yaml` of the agent that owns it. "Owning agent" = the agent whose `agent_id` matches the subscription's `agent_id` field. Cross-agent chains between subscriptions in different files are stitched at runtime via the standard `source_session` / `fan_out` fields plus their UUID-keyed companions (`source_session_ids` / `fan_out_ids`) - no shared file required.

Where each role lives:

| Subscription role                                                      | Lives in cue.yaml under...                                                        |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Trigger consumed by agent A (e.g. `file.changed` that prompts agent A) | Agent A's project root                                                            |
| Fan-out from A to [B, C, D]                                            | Agent A's project root (set `fan_out` + `fan_out_ids`)                            |
| `agent.completed` chain step where upstream is X, downstream is Y      | Agent Y's project root (set `source_session` + `source_session_ids` to X)         |
| Fan-in synthesis where upstreams are A, B, C and downstream is Z       | Agent Z's project root (set `source_session` + `source_session_ids` to [A, B, C]) |
| Command node (`action: command`) attached to agent W's session         | Agent W's project root (it shares W's session and cwd)                            |

**Orchestration "at the root."** If you have an orchestrator agent whose project root sits above the worker agents in the filesystem, the orchestrator's own `.maestro/cue.yaml` is naturally where fan-in / synthesis subscriptions land - because it owns those subscriptions, not because it is "the root." Workers' triggers still live in each worker's own cue.yaml.

**Always set `source_session` / `fan_out`; add the `_ids` companions for rename stability.** The validator requires `source_session` on every `agent.completed` subscription, and `fan_out` is the canonical field for fan-out targets. **Additionally** populate the parallel UUID arrays - `source_session_ids: [<agent-uuid>]` next to `source_session: <agent-name>`, `fan_out_ids: [<uuid>, ...]` next to `fan_out: [<name>, ...]`. The dispatcher prefers ids at lookup time and falls back to names, so cross-root edges survive an upstream agent rename. Omitting the ids works but silently breaks on rename.

**Pipeline grouping across files.** A pipeline that spans roots still appears as one card in the Cue dashboard / Pipeline Editor as long as every participating subscription carries the same `pipeline_name` (and same `# Pipeline: Name (color: #hex)` comment header in each file). The visual editor handles this automatically; if you hand-author, keep the values consistent across every file.

**The visual editor is the easy path.** When you save a multi-root pipeline from the Pipeline Editor, Maestro automatically partitions the subscriptions by owning agent's project root and writes one yaml per participating cwd. If you find yourself authoring a multi-root pipeline by hand and it gets fiddly, building it in the Pipeline Editor and letting it emit the per-cwd files is the supported path.

## Subscriptions

Each subscription is a trigger-prompt pairing. When the trigger fires, Cue sends the prompt to the agent.

### Required Fields

| Field    | Type   | Description                                                                   |
| -------- | ------ | ----------------------------------------------------------------------------- |
| `name`   | string | Unique identifier. Used in logs, history, and as a reference in chains        |
| `event`  | string | One of the nine [event types](./maestro-cue-events)                           |
| `prompt` | string | The prompt to send as inline text. Required unless `prompt_file` is specified |

<Note>
Either `prompt` or `prompt_file` must be provided. If both are present, `prompt_file` takes precedence.
</Note>

### Optional Fields

| Field                | Type            | Default | Description                                                                                                                                                                                                                               |
| -------------------- | --------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`            | boolean         | `true`  | Set to `false` to pause a subscription without removing it                                                                                                                                                                                |
| `agent_id`           | string (UUID)   | -       | UUID of the target agent. Auto-assigned by the Pipeline Editor                                                                                                                                                                            |
| `prompt_file`        | string          | -       | Path to a `.md` file containing the prompt (alternative to inline `prompt`)                                                                                                                                                               |
| `interval_minutes`   | number          | -       | Timer interval. Required for `time.heartbeat`                                                                                                                                                                                             |
| `schedule_times`     | list of strings | -       | Times in `HH:MM` format. Required for `time.scheduled`                                                                                                                                                                                    |
| `schedule_days`      | list of strings | -       | Days of week (`mon`-`sun`). Optional for `time.scheduled`                                                                                                                                                                                 |
| `watch`              | string (glob)   | -       | File glob pattern. Required for `file.changed`, `task.pending`                                                                                                                                                                            |
| `source_session`     | string or list  | -       | Source agent display name(s). Required for `agent.completed`                                                                                                                                                                              |
| `source_session_ids` | string or list  | -       | Companion UUID(s) for `source_session`. Same shape (string ↔ string, list ↔ list). Preferred by the dispatcher at lookup time; falls back to `source_session` names when absent. Set this alongside `source_session` for rename stability |
| `source_sub`         | string or list  | -       | Upstream subscription name(s) that narrow chain matching. **Required** when `action: command` on `agent.completed`. When `source_session` is an array, `source_sub` must be a same-length array (positional pairing)                      |
| `fan_out`            | list of strings | -       | Target agent display names to fan out to                                                                                                                                                                                                  |
| `fan_out_ids`        | list of strings | -       | Companion UUID array for `fan_out` (one entry per fan-out target). Preferred by the dispatcher at lookup time; falls back to `fan_out` names when absent. Set this alongside `fan_out` for rename stability                               |
| `filter`             | object          | -       | Payload conditions (see [Filtering](./maestro-cue-advanced#filtering))                                                                                                                                                                    |
| `repo`               | string          | -       | GitHub repo (`owner/repo`). Auto-detected from git remote                                                                                                                                                                                 |
| `poll_minutes`       | number          | varies  | Poll interval for `github.*` (default 5) and `task.pending` (default 1)                                                                                                                                                                   |
| `output_prompt`      | string          | -       | Follow-up prompt sent after the main run completes successfully                                                                                                                                                                           |
| `output_prompt_file` | string          | -       | Path to a `.md` file for the output prompt (alternative to inline)                                                                                                                                                                        |
| `label`              | string          | -       | Human-readable label displayed in the Cue dashboard and pipeline editor                                                                                                                                                                   |

### Prompt Field

Prompts can be provided inline or via a separate file.

**Inline prompt:**

```yaml
prompt: |
  Please lint the file {{CUE_FILE_PATH}} and fix any errors.
```

**File reference (using `prompt_file`):**

```yaml
prompt_file: .maestro/prompts/my-prompt.md
```

File paths are resolved relative to the project root. Prompt files support the same `{{VARIABLE}}` template syntax as inline prompts. Using `prompt_file` keeps your `cue.yaml` clean when prompts are long or complex - the Pipeline Editor uses this approach by default, storing prompt files in `.maestro/prompts/`.

### Output Prompt (Two-Phase Runs)

The `output_prompt` field enables a two-phase execution pattern. When the main `prompt` completes successfully, Cue automatically sends the `output_prompt` as a follow-up - with the first run's output included as context.

This is useful for workflows where one phase generates data and a second phase acts on it:

```yaml
subscriptions:
  - name: test-and-report
    event: time.heartbeat
    interval_minutes: 60
    prompt: |
      Run the full test suite with `npm test` and capture the results.
    output_prompt: |
      Based on the test results above, generate a summary report.
      Include pass/fail counts and highlight any regressions.
```

You can also use `output_prompt_file` to reference a `.md` file instead of inline text:

```yaml
subscriptions:
  - name: analyze-and-summarize
    event: file.changed
    watch: 'src/**/*.ts'
    prompt: Analyze {{CUE_FILE_PATH}} for code quality issues.
    output_prompt_file: prompts/summarize-analysis.md
```

<Note>
The output prompt only fires when the main run completes successfully. If the main run times out or fails, the output phase is skipped.
</Note>

### Pipelines

A **pipeline** groups multiple subscriptions under a single name in the Pipeline Editor. This is useful when you have related automations (e.g., a daily scan and a weekly review) that logically belong together.

**Defining a pipeline:**

Add a pipeline comment at the top of your `cue.yaml`, then use a naming convention to group subscriptions:

```yaml
# Pipeline: My Pipeline (color: #06b6d4)

subscriptions:
  - name: My Pipeline
    event: time.scheduled
    schedule_times:
      - '09:00'
    prompt_file: .maestro/prompts/my-pipeline-daily.md

  - name: My Pipeline-chain-1
    event: time.scheduled
    schedule_times:
      - '17:00'
    prompt_file: .maestro/prompts/my-pipeline-eod.md
```

**How it works:**

1. The `# Pipeline: Name (color: hex)` comment declares the pipeline name and its color in the UI
2. The first subscription's `name` matches the pipeline name exactly
3. Additional subscriptions in the same pipeline use the convention `Name-chain-N` (e.g., `My Pipeline-chain-1`, `My Pipeline-chain-2`)
4. All subscriptions with matching names appear as separate trigger lines within a single pipeline in the Pipeline Editor

**Notes:**

- The `color` in the comment sets the pipeline's dot color in the UI (any valid hex color)
- Each subscription in a pipeline can have its own event type, schedule, and prompt - they don't need to share configuration
- Use the `label` field to give each line a descriptive name (e.g., "Daily Analysis", "Weekly Review")
- The Pipeline Editor creates this structure automatically when you use the visual editor

**Visual-node identity (`target_node_key`, `fan_out_node_keys`):** When you save from the Pipeline Editor, you may see UUID-valued `target_node_key` / `fan_out_node_keys` fields on subscriptions. These are renderer-only - the Cue engine ignores them. They let the editor distinguish "two visual nodes that happen to point at the same agent" (different keys → two nodes on the canvas) from "one shared node with multiple inputs" (same key → explicit fan-in onto a single node). If you hand-edit YAML and want two separate visual instances of the same agent for the same trigger, give each sub a different `target_node_key`; if you want them to merge into one fan-in target, give them the same key. Leave the keys alone when round-tripping through the editor - clearing them silently re-merges your visual nodes by `agent_id` on the next reload.

#### Agent-authored Trigger -> Command -> Agent YAML checklist

If an AI agent writes `cue.yaml` directly (without using the visual editor), include all of the following so Maestro reconstructs the graph correctly:

1. Initial trigger subscription uses `action: command` with a valid `command` object.
2. The downstream `agent.completed` subscription includes `source_sub` pointing to that command subscription name.
3. For fan-in chains, when `source_sub` / `source_session` / `source_session_ids` are arrays, all three must be the **same length and positionally aligned**: index `i` in each array refers to the same upstream source. The validator rejects mismatched lengths.
4. Keep `pipeline_name` consistent across all subs in the pipeline.
5. Keep per-node identity fields (`target_node_key`, `fan_out_node_keys`) stable once created.

Example:

```yaml
subscriptions:
  - name: Build Pipeline-cmd-1
    pipeline_name: Build Pipeline
    event: time.scheduled
    schedule_times: ['09:00']
    action: command
    command:
      mode: shell
      shell: npm run build
    agent_id: AGENT_UUID_A
    target_node_key: node-cmd-1

  - name: Build Pipeline-chain-1
    pipeline_name: Build Pipeline
    event: agent.completed
    source_session: Agent A
    source_session_ids: [AGENT_UUID_A]
    source_sub: Build Pipeline-cmd-1
    prompt: "{{CUE_SOURCE_OUTPUT}}\n\nSummarize build output and next steps."
    agent_id: AGENT_UUID_A
    target_node_key: node-agent-1
```

### Labels

The `label` field provides a human-readable name displayed in the Cue dashboard and pipeline editor. When subscriptions are grouped into a pipeline, the label distinguishes each line within the pipeline.

```yaml
subscriptions:
  - name: pr-review
    label: 'PR Review Bot'
    event: github.pull_request
    prompt: Review the PR at {{CUE_GH_URL}}.
```

### Disabling Subscriptions

Set `enabled: false` to pause a subscription without deleting it:

```yaml
subscriptions:
  - name: nightly-report
    event: time.heartbeat
    interval_minutes: 1440
    enabled: false # Paused - won't fire until re-enabled
    prompt: Generate a daily summary report.
```

## Settings

The optional `settings` block configures global engine behavior. All fields have sensible defaults - you only need to include settings you want to override.

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

- **`break`** - Stop the run and mark it as failed. No further processing for this event.
- **`continue`** - Stop the run but allow downstream subscriptions (in fan-in chains) to proceed with partial data.

```yaml
settings:
  timeout_on_fail: continue # Don't block the pipeline on slow agents
```

### max_concurrent

**Default:** `1` | **Type:** integer, 1-10

Maximum number of Cue-triggered runs that can execute simultaneously for this agent. Additional events are queued.

```yaml
settings:
  max_concurrent: 3 # Allow up to 3 parallel runs
```

### queue_size

**Default:** `512` | **Type:** integer, 0-10000

Maximum number of events that can be queued when all concurrent slots are occupied. Events beyond this limit are dropped.

Default is `512` - generous enough to absorb bursty triggers without surfacing overflow toasts. Lower it to backpressure faster; set to `0` to drop any event that can't run immediately.

```yaml
settings:
  queue_size: 1024 # Buffer up to 1024 events
```

## Validation

The engine validates your YAML on every load. Common validation errors:

| Error                                   | Fix                                                          |
| --------------------------------------- | ------------------------------------------------------------ |
| `"name" is required`                    | Every subscription needs a unique `name` field               |
| `"event" is required`                   | Specify one of the nine event types                          |
| `"prompt" is required`                  | Provide inline text or a file path                           |
| `"interval_minutes" is required`        | `time.heartbeat` events must specify a positive interval     |
| `"schedule_times" is required`          | `time.scheduled` events must have at least one `HH:MM` time  |
| `"watch" is required`                   | `file.changed` and `task.pending` events need a glob pattern |
| `"source_session" is required`          | `agent.completed` events need the name of the source agent   |
| `"max_concurrent" must be between 1-10` | Keep concurrent runs within the allowed range                |
| `"queue_size" must be between 0-10000`  | Keep queue size within the allowed range                     |
| `filter key must be string/number/bool` | Filter values only accept primitive types                    |

The inline YAML editor in the Cue Modal shows validation errors in real-time as you type. A green **Valid YAML** indicator at the bottom confirms your config parses correctly.

![Cue YAML Editor](./screenshots/cue-yaml-editor.png)

## Complete Example

A realistic configuration demonstrating a pipeline with multiple trigger lines, mixed event types, and external prompt files:

```yaml
# Pipeline: DevOps (color: #10b981)

subscriptions:
  # Lint TypeScript files on save
  - name: DevOps
    label: Lint on Save
    event: file.changed
    watch: 'src/**/*.ts'
    filter:
      extension: '.ts'
    prompt: |
      The file {{CUE_FILE_PATH}} was modified.
      Run `npx eslint {{CUE_FILE_PATH}} --fix` and report any remaining issues.

  # Morning standup on weekdays
  - name: DevOps-chain-1
    label: Morning Standup
    event: time.scheduled
    schedule_times:
      - '09:00'
    schedule_days:
      - mon
      - tue
      - wed
      - thu
      - fri
    prompt: |
      Generate a standup report from recent git activity.

  # Review new PRs automatically
  - name: DevOps-chain-2
    label: PR Review
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
  - name: DevOps-chain-3
    label: Task Worker
    event: task.pending
    watch: 'TODO.md'
    poll_minutes: 5
    prompt: |
      There are {{CUE_TASK_COUNT}} pending tasks in {{CUE_TASK_FILE}}:

      {{CUE_TASK_LIST}}

      Pick the highest priority task and complete it.
      When done, check off the task in the file.

settings:
  timeout_minutes: 45
  max_concurrent: 2
  queue_size: 15
```

All four subscriptions appear as separate trigger lines within a single **DevOps** pipeline in the Pipeline Editor.
