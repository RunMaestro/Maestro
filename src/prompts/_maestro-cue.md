## Maestro Cue

**Cue** is Maestro's event-driven automation engine. A **subscription** listens for an event and fires a prompt at a target agent. Subscriptions are defined per-project in a YAML file.

### Configuration File

**Canonical path: `<project-root>/.maestro/cue.yaml`** — always write new configs here. The engine creates the `.maestro/` directory automatically on save.

Legacy path: `<project-root>/maestro-cue.yaml` (deprecated). The engine still reads it if present for backwards compatibility, but every save migrates to the canonical location, so do **not** write new files there.

When you need to find an existing config, check `.maestro/cue.yaml` first, then fall back to `maestro-cue.yaml` at the project root.

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

### Pipelines vs. Chains (READ THIS FIRST)

A **pipeline** is a logical grouping of related subscriptions in `cue.yaml` — it's what shows up as one named card in the Cue dashboard / Pipeline Editor. A **chain** is a single subscription (or topology of subscriptions: linear chain, fan-out, fan-in) **inside** a pipeline.

**Two non-negotiable defaults — apply BOTH every time:**

1. **Group related chains under one pipeline.** Do not create one pipeline per chain. If the user describes several automations that share a theme (e.g., "morning briefing + EOD wrap-up + weekly review", or "PR triage + PR review + PR merge"), put them in the same pipeline. Separate pipelines are only justified when the work is genuinely unrelated (different domains, different agents, different lifecycles).
2. **One trigger → one agent node. Never fan-in by default.** Every subscription gets its own unique `target_node_key` (any UUID) so the Pipeline Editor renders each chain as its own visual line — even when several chains share the same `agent_id`. Fan-in (multiple triggers collapsing onto one shared node) is a deliberate, opt-in topology — never the result of omitting `target_node_key`. The user's reasoning: an individual chain trivially extends to `trigger → agent → agent`, while a fan-in node has to be untangled first to add a downstream stage.

How grouping is expressed in YAML:

1. **`pipeline_name` field on each subscription** — authoritative. Every subscription that belongs to the same pipeline gets the same `pipeline_name` value. This survives renaming individual subscriptions.
2. **`# Pipeline: Name (color: #hex)` comment header** at the top of `cue.yaml` declares the pipeline's display name and dot color in the UI.
3. **Naming convention** (legacy / human-friendly): the first subscription's `name` matches the pipeline name; additional chains use `Name-chain-1`, `Name-chain-2`, etc. The Pipeline Editor emits this convention automatically.
4. **`target_node_key`** (UUID) on every subscription — even the first one. Mixing keyed and unkeyed subs for the same `agent_id` is fragile: the legacy dedup-by-sessionName fallback can still collapse them depending on YAML ordering. Make every sub explicit.

```yaml
# Pipeline: Daily Ops (color: #06b6d4)

subscriptions:
  - name: Daily Ops
    pipeline_name: Daily Ops
    label: Morning briefing
    event: time.scheduled
    schedule_times: ['09:00']
    agent_id: <briefer-agent-id>
    target_node_key: 6f3d1e92-a2c4-4b71-9e8d-0c5b2a1d4e67
    prompt: |
      Pull together yesterday's commits, open PRs, top tasks. Tight bullets.

  - name: Daily Ops-chain-1
    pipeline_name: Daily Ops
    label: EOD wrap-up
    event: time.scheduled
    schedule_times: ['17:30']
    agent_id: <briefer-agent-id>
    target_node_key: 7e2c8a4b-9d7f-4e3a-b1c5-7f8d2a6e4b93
    prompt: |
      Summarize what shipped today and flag anything left hanging.

  - name: Daily Ops-chain-2
    pipeline_name: Daily Ops
    label: Friday review
    event: time.scheduled
    schedule_times: ['16:00']
    schedule_days: [fri]
    agent_id: <reviewer-agent-id>
    target_node_key: 8a1b9d4e-3c5f-48a2-8e6d-9b1f4c7a2e85
    prompt: |
      Roll up the week. What moved, what stalled, what's next week's focus.
```

Three subscriptions, three different schedules, three distinct `target_node_key`s → three visually-separate chains in the editor (even when two of them share the same `agent_id`), **one pipeline**.

### Pipeline Topologies (within a pipeline)

**Default: independent chains, even when they share an agent.** When several subscriptions live in the same pipeline, give each its own unique `target_node_key` (any UUID will do) so the Pipeline Editor renders them as parallel chains rather than collapsing to a fan-in node. Whether they reuse one `agent_id` or use distinct ones is a separate decision — `target_node_key` controls the _visual_ graph; `agent_id` controls _which agent runs the work_.

- **Same `agent_id`, distinct `target_node_key`s** → one agent runs every chain (shared session, serialized queue), but each chain shows up as its own agent node labelled `Name (1)`, `Name (2)`, etc. This is the right default for a single-project pipeline whose stages are conceptually independent but happen to share one workspace.
- **Distinct `agent_id`s** → fully isolated agents per chain (separate context, can run in parallel). Reach for this only when the chains genuinely need different contexts, models, or project roots.
- **Same `agent_id` and same `target_node_key`** → real fan-in (multiple triggers / upstreams converge on one shared node). Reserve for cases where you actually need a single output point.

**Don't omit `target_node_key`** when several subs in a pipeline share an `agent_id`. Without it, the loader falls back to dedup-by-sessionName and silently collapses every sub onto one node — which is what produces the unintentional fan-in look.

Topologies available:

- **Chain:** A's `agent.completed` fires B. B's `agent.completed` fires C.
- **Fan-out:** one subscription's `fan_out: [agentA, agentB]` dispatches in parallel with per-target `fan_out_prompts`. Use `fan_out_node_keys` to give each target its own visual node.
- **Fan-in:** `source_session: [a, b, c]` fires once ALL listed sources complete (subject to `fan_in_timeout_minutes` / `fan_in_timeout_on_fail`). Each upstream output is available as `{{CUE_OUTPUT_<NAME>}}` (uppercased session name); `include_output_from` narrows which sources contribute to `{{CUE_SOURCE_OUTPUT}}`. **Reserve for cases where you genuinely need synchronized convergence** — e.g. summarizing three parallel research agents into one digest. Don't reach for fan-in just because several triggers happen to share a target.
- **Forwarding:** an intermediate agent can pass an upstream's output through to a downstream agent by listing the source name in `forward_output_from: [<name>]`. The forwarded value is exposed downstream as `{{CUE_FORWARDED_<NAME>}}`.
- **`cli_output`:** an object `cli_output: { target: "<source-agent-id>" }`. When set, the run's stdout is returned to that agent (typically the one that ran `maestro-cli send` or `cue trigger --source-agent-id`).

All of the topologies above can (and usually should) live inside a single pipeline — set the same `pipeline_name` on every subscription that participates.

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

1. Read the existing config first to understand current subscriptions, pipelines, and naming conventions. Check `.maestro/cue.yaml` (canonical) first, then `maestro-cue.yaml` at the project root (legacy fallback).
2. Keep subscription `name` values unique within the file — the engine keys on them.
3. **Group related chains under one pipeline.** Before adding a new subscription, check whether it belongs in an existing pipeline (matching theme, agent set, or domain) — if so, reuse that `pipeline_name` instead of creating a new pipeline. If the user describes several related automations in one request, emit them as multiple subscriptions sharing a single `pipeline_name`, not as separate pipelines.
4. **Within a pipeline, give each subscription its own `target_node_key`** (any UUID) so the Pipeline Editor renders the chains as separate visual lines instead of collapsing them onto one fan-in agent node. This applies whether the chains share an `agent_id` or not. Only reuse a `target_node_key` across subscriptions when you actually want a real fan-in node (multiple triggers/upstreams converging onto one shared agent node). If two chains genuinely need isolated context/models/project-roots, also give them distinct `agent_id`s (create with `{{MAESTRO_CLI_PATH}} create-agent <name> --cwd <project>` if needed); otherwise reusing one `agent_id` is fine and often preferred.
5. For full schema, field reference, and worked examples, fetch the official Cue docs: https://docs.runmaestro.ai/maestro-cue-configuration, https://docs.runmaestro.ai/maestro-cue-events, https://docs.runmaestro.ai/maestro-cue-advanced, https://docs.runmaestro.ai/maestro-cue-examples. Don't guess field names.
6. After writing, validate with `{{MAESTRO_CLI_PATH}} cue list` — the engine reloads automatically when the file changes.

### Shared Workspaces: `settings.owner_agent_id`

When two or more agents are registered against the same project root (for example, an Opus and a Sonnet agent both pointing at the same Obsidian vault), every subscription in `cue.yaml` is either **pinned to a single agent** or **disabled** — there is no mode where an unowned subscription broadcasts to every agent in the root. Which state applies depends on `owner_agent_id` and the per-subscription `agent_id`:

- **Always prefer explicit `agent_id` per subscription** when you want a specific agent (or several, via chains / fan-out) to run work in a shared workspace. That is the reliable way to target multiple agents from one `cue.yaml`.
- **Set `settings.owner_agent_id`** to the agent's internal id (UUID) **or** display name to pin every _unowned_ subscription (no `agent_id`) to that agent. Prefer the UUID when two agents share a display name — a name with multiple matches is flagged as ambiguous and unowned subs are disabled until it's resolved.
- **If `owner_agent_id` is unset and >1 agent shares the root**, the first agent in the session list is picked as a deterministic fallback owner; non-winners are flagged in the Cue dashboard with a red warning pointing to `owner_agent_id`. Do not rely on this fallback — set `owner_agent_id` explicitly.
- **If `owner_agent_id` is set but no agent in the root matches it**, every agent there is flagged and unowned subscriptions are disabled until the value is fixed.

When authoring `cue.yaml` for a workspace that may be registered under more than one agent, set `owner_agent_id` proactively. Use `{{MAESTRO_CLI_PATH}} list agents` to discover ids and names.

### Natural-Language → YAML Recipes

Translate the user's phrasing into one of these starter templates, then adapt names/prompts/agent ids. Always set `agent_id` to the target agent (use `{{MAESTRO_CLI_PATH}} list agents` to find ids).

**Each recipe below is a single chain.** When a user request maps to more than one chain:

- Assign every chain the same `pipeline_name` (and add a `# Pipeline: Name (color: #hex)` comment header at the top of the file) so they group into one pipeline in the UI. Only split into separate pipelines when the chains are genuinely unrelated.
- **Add a unique `target_node_key` (any UUID) to every subscription** — the recipes below omit it because they're standalone single-chain examples, but the moment you emit two or more subscriptions in one file you must give each its own key. Otherwise the Pipeline Editor collapses them into one fan-in agent node, which is never the default we want. The `agent.completed (fan-in)` recipe is the one exception — that's a deliberate convergence node.

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

After authoring, write the YAML to `<project-root>/.maestro/cue.yaml` (create the `.maestro/` directory if it doesn't exist), then run `{{MAESTRO_CLI_PATH}} cue list` to confirm the engine sees it.
