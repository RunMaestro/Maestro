## Maestro Cue

**Cue** is Maestro's event-driven automation engine. A **subscription** listens for an event and fires a prompt at a target agent. Subscriptions are defined per-project in a YAML file.

### Configuration File

Location: `<project>/maestro-cue.yaml` (project-root)

Each subscription has a unique `name`, an `event` type, an `enabled` flag, a `prompt` (with template variables), and event-specific fields.

### Event Types

| Event                 | Fires when…                                     | Key config fields                                     |
| --------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| `app.startup`         | Maestro launches                                | —                                                     |
| `time.heartbeat`      | Every N minutes                                 | `interval_minutes`                                    |
| `time.scheduled`      | At specific clock times (cron-like)             | `schedule_times`, `schedule_days`                     |
| `file.changed`        | Files matching a glob are added/changed/removed | `watch` (glob)                                        |
| `agent.completed`     | An upstream agent finishes a run                | `source_session` (name or names)                      |
| `github.pull_request` | A PR matches a filter (polled)                  | `repo`, `gh_state`, `label`, `poll_minutes`, `filter` |
| `github.issue`        | An issue matches a filter (polled)              | `repo`, `gh_state`, `label`, `poll_minutes`, `filter` |
| `task.pending`        | Pending `- [ ]` tasks detected in watched files | `watch`                                               |
| `cli.trigger`         | Manually fired via `maestro-cli cue trigger`    | —                                                     |

### Pipeline Topologies

- **Chain:** A's `agent.completed` fires B. B's `agent.completed` fires C.
- **Fan-out:** one subscription's `fan_out: [agentA, agentB]` dispatches in parallel with per-target `fan_out_prompts`.
- **Fan-in:** `source_session: [a, b, c]` fires once ALL listed sources complete (subject to `fan_in_timeout_minutes` / `fan_in_timeout_on_fail`). Each upstream output is available as `{{CUE_OUTPUT_<NAME>}}` (uppercased session name); `include_output_from` narrows which sources contribute to `{{CUE_SOURCE_OUTPUT}}`.
- **Forwarding:** an intermediate agent can pass an upstream's output through to a downstream agent by listing the source name in `forward_output_from: [<name>]`. The forwarded value is exposed downstream as `{{CUE_FORWARDED_<NAME>}}`.
- **`cli_output`:** an object `cli_output: { target: "<source-agent-id>" }`. When set, the run's stdout is returned to that agent (typically the one that ran `maestro-cli send` or `cue trigger --source-agent-id`).

### Template Variables Available in Cue Prompts

**Always available:**
`{{CUE_EVENT_TYPE}}`, `{{CUE_EVENT_TIMESTAMP}}`, `{{CUE_TRIGGER_NAME}}`, `{{CUE_RUN_ID}}`

**`file.changed` / `task.pending`:**
`{{CUE_FILE_PATH}}`, `{{CUE_FILE_NAME}}`, `{{CUE_FILE_DIR}}`, `{{CUE_FILE_EXT}}`, `{{CUE_FILE_CHANGE_TYPE}}` (`add` | `change` | `unlink`)

**`task.pending`:**
`{{CUE_TASK_FILE}}`, `{{CUE_TASK_FILE_NAME}}`, `{{CUE_TASK_FILE_DIR}}`, `{{CUE_TASK_COUNT}}`, `{{CUE_TASK_LIST}}` (formatted), `{{CUE_TASK_CONTENT}}` (file content, truncated 10K chars)

**`agent.completed`:**
`{{CUE_SOURCE_SESSION}}`, `{{CUE_SOURCE_OUTPUT}}`, `{{CUE_SOURCE_STATUS}}` (`completed` | `failed` | `timeout`), `{{CUE_SOURCE_EXIT_CODE}}`, `{{CUE_SOURCE_DURATION}}`, `{{CUE_SOURCE_TRIGGERED_BY}}`

**`github.*`:**
`{{CUE_GH_TYPE}}`, `{{CUE_GH_NUMBER}}`, `{{CUE_GH_TITLE}}`, `{{CUE_GH_AUTHOR}}`, `{{CUE_GH_URL}}`, `{{CUE_GH_BODY}}`, `{{CUE_GH_LABELS}}`, `{{CUE_GH_STATE}}`, `{{CUE_GH_REPO}}`, `{{CUE_GH_BRANCH}}`, `{{CUE_GH_BASE_BRANCH}}`, `{{CUE_GH_ASSIGNEES}}`, `{{CUE_GH_MERGED_AT}}`

**`cli.trigger`:**
`{{CUE_CLI_PROMPT}}`, `{{CUE_SOURCE_AGENT_ID}}`

### CLI

```bash
# List all subscriptions (including disabled) across agents
{{MAESTRO_CLI_PATH}} cue list [--json]

# Fire a subscription on demand (bypasses its event trigger)
{{MAESTRO_CLI_PATH}} cue trigger <subscription-name> \
    [-p, --prompt "custom prompt"] \
    [--source-agent-id {{AGENT_ID}}] \
    [--json]
```

Pass `--source-agent-id {{AGENT_ID}}` so a subscription with `cli_output` can route its result back to you as a reply.

### Authoring Guidance

When a user asks you to add, modify, or debug a Cue subscription:

1. Read the existing `maestro-cue.yaml` at the project root first to understand current subscriptions and naming conventions.
2. Keep subscription `name` values unique within the file — the engine keys on them.
3. For full schema, field reference, and worked examples, fetch the official Cue docs: https://docs.runmaestro.ai/maestro-cue-configuration, https://docs.runmaestro.ai/maestro-cue-events, https://docs.runmaestro.ai/maestro-cue-advanced, https://docs.runmaestro.ai/maestro-cue-examples. Don't guess field names.
4. After writing, validate with `{{MAESTRO_CLI_PATH}} cue list` — the engine reloads automatically when the file changes.

### Shared Workspaces: `settings.owner_agent_id`

When two or more agents are registered against the same project root (for example, an Opus and a Sonnet agent both pointing at the same Obsidian vault), every subscription in `cue.yaml` is either **pinned to a single agent** or **disabled** — there is no mode where an unowned subscription broadcasts to every agent in the root. Which state applies depends on `owner_agent_id` and the per-subscription `agent_id`:

- **Always prefer explicit `agent_id` per subscription** when you want a specific agent (or several, via chains / fan-out) to run work in a shared workspace. That is the reliable way to target multiple agents from one `cue.yaml`.
- **Set `settings.owner_agent_id`** to the agent's internal id (UUID) **or** display name to pin every _unowned_ subscription (no `agent_id`) to that agent. Prefer the UUID when two agents share a display name — a name with multiple matches is flagged as ambiguous and unowned subs are disabled until it's resolved.
- **If `owner_agent_id` is unset and >1 agent shares the root**, the first agent in the session list is picked as a deterministic fallback owner; non-winners are flagged in the Cue dashboard with a red warning pointing to `owner_agent_id`. Do not rely on this fallback — set `owner_agent_id` explicitly.
- **If `owner_agent_id` is set but no agent in the root matches it**, every agent there is flagged and unowned subscriptions are disabled until the value is fixed.

When authoring `cue.yaml` for a workspace that may be registered under more than one agent, set `owner_agent_id` proactively. Use `{{MAESTRO_CLI_PATH}} list agents` to discover ids and names.

### Natural-Language → YAML Recipes

Translate the user's phrasing into one of these starter templates, then adapt names/prompts/agent ids. Always set `agent_id` to the target agent (use `{{MAESTRO_CLI_PATH}} list agents` to find ids).

**"Every morning at 9am, remind me to…" / "Every Friday afternoon…" → `time.scheduled`**

```yaml
subscriptions:
  - name: morning-standup-prep
    event: time.scheduled
    enabled: true
    schedule_times: ['09:00']
    schedule_days: [mon, tue, wed, thu, fri]
    agent_id: <target-agent-id>
    prompt: |
      Good morning. Pull together: (1) yesterday's commits on this repo,
      (2) any open PRs assigned to me, (3) the top 3 unfinished tasks in
      `{{AUTORUN_FOLDER}}`. Reply with a tight bulleted briefing.
```

**"Check on this every 30 minutes" → `time.heartbeat`**

```yaml
- name: ci-watch
  event: time.heartbeat
  enabled: true
  interval_minutes: 30
  agent_id: <target-agent-id>
  prompt: |
    Run `gh run list --branch main --limit 5 --json status,conclusion,name`
    and call out any failed or stuck runs.
```

**"When this file changes, do X" → `file.changed`**

```yaml
- name: regenerate-types-on-schema-change
  event: file.changed
  enabled: true
  watch: 'src/db/schema.prisma'
  agent_id: <target-agent-id>
  prompt: |
    The schema at `{{CUE_FILE_PATH}}` was {{CUE_FILE_CHANGE_TYPE}}.
    Run `npx prisma generate` and stage the resulting type changes.
```

**"After agent X finishes, have agent Y do Z" → `agent.completed` (chain)**

```yaml
- name: review-after-impl
  event: agent.completed
  enabled: true
  source_session: implementer
  agent_id: <reviewer-agent-id>
  prompt: |
    The implementer just finished:

    {{CUE_SOURCE_OUTPUT}}

    Status: {{CUE_SOURCE_STATUS}}. Review for correctness and style;
    respond with a short approval or a numbered list of required changes.
```

**"When all of A, B, and C complete, summarize" → `agent.completed` (fan-in)**

```yaml
- name: sync-after-parallel-work
  event: agent.completed
  enabled: true
  source_session: [agent-a, agent-b, agent-c]
  fan_in_timeout_minutes: 60
  fan_in_timeout_on_fail: continue
  agent_id: <synthesizer-agent-id>
  prompt: |
    Three agents just finished:

    A: {{CUE_OUTPUT_AGENT_A}}
    B: {{CUE_OUTPUT_AGENT_B}}
    C: {{CUE_OUTPUT_AGENT_C}}

    Produce a unified summary suitable for a daily digest.
```

**"Watch for new PRs on this repo" → `github.pull_request`**

```yaml
- name: pr-triage
  event: github.pull_request
  enabled: true
  repo: owner/name
  gh_state: open
  poll_minutes: 10
  agent_id: <triage-agent-id>
  prompt: |
    New PR #{{CUE_GH_NUMBER}} from @{{CUE_GH_AUTHOR}}: "{{CUE_GH_TITLE}}".
    {{CUE_GH_URL}}

    Skim the diff, suggest reviewers, and propose labels.
```

**"When pending tasks pile up in /docs/tasks, work on them" → `task.pending`**

```yaml
- name: drain-task-backlog
  event: task.pending
  enabled: true
  watch: 'docs/tasks/*.md'
  agent_id: <worker-agent-id>
  prompt: |
    File `{{CUE_TASK_FILE_NAME}}` has {{CUE_TASK_COUNT}} unchecked items:

    {{CUE_TASK_LIST}}

    Pick up the highest-priority unchecked task and complete it.
```

After authoring, write the YAML to `<project-root>/maestro-cue.yaml`, then run `{{MAESTRO_CLI_PATH}} cue list` to confirm the engine sees it.
