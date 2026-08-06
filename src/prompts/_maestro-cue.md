## Maestro Cue

**Cue** is Maestro's event-driven automation engine. A **subscription** listens for an event and fires a prompt at a target agent. Subscriptions are defined per-project in a YAML file.

### Configuration File

**Canonical path: `<project-root>/.maestro/cue.yaml`** - always write new configs here. The engine creates the `.maestro/` directory automatically on save.

Legacy path: `<project-root>/maestro-cue.yaml` (deprecated). The engine still reads it if present for backwards compatibility, but every save migrates to the canonical location, so do **not** write new files there.

When you need to find an existing config, check `.maestro/cue.yaml` first, then fall back to `maestro-cue.yaml` at the project root.

Each subscription has a unique `name`, an `event` type, an `enabled` flag, a `prompt` (with template variables), and event-specific fields.

**One cue.yaml per agent project root.** Each agent's engine looks for the canonical `<projectRoot>/.maestro/cue.yaml` (falling back to the legacy `<projectRoot>/maestro-cue.yaml` as described in the canonical-first + legacy-fallback rule above), **scoped strictly to that agent's own project root** - there is no parent-directory walk, no ancestor fallback into a workspace-wide config, and no implicit aggregation across roots. If your fleet has agents at three different project roots, you maintain three cue.yaml files (one per root, canonical or legacy per the rule above). See **Multi-Root Pipelines** below before authoring a pipeline that spans more than one project root.

### Event Types

| Event                 | Fires when…                                                          | Key config fields                                                                                   |
| --------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `app.startup`         | Maestro launches                                                     | -                                                                                                   |
| `time.heartbeat`      | Every N minutes                                                      | `interval_minutes`                                                                                  |
| `time.scheduled`      | At specific clock times (cron-like)                                  | `schedule_times`, `schedule_days`                                                                   |
| `time.once`           | At a specific wall-clock moment, exactly once (self-destructs after) | `fire_at`, optional `grace_minutes`, `self_destruct_on_failure`                                     |
| `file.changed`        | Files matching a glob are added/changed/removed                      | `watch` (glob)                                                                                      |
| `agent.completed`     | An upstream agent finishes a run                                     | `source_session` (name or names)                                                                    |
| `github.pull_request` | A PR matches a filter (polled)                                       | `repo`, `gh_state`, `label`, `poll_minutes`, `filter`, `retrigger_on_comments`, `max_notifications` |
| `github.issue`        | An issue matches a filter (polled)                                   | `repo`, `gh_state`, `label`, `poll_minutes`, `filter`, `retrigger_on_comments`, `max_notifications` |
| `task.pending`        | Pending `- [ ]` tasks detected in watched files                      | `watch`                                                                                             |
| `cli.trigger`         | Manually fired via `maestro-cli cue trigger`                         | -                                                                                                   |

### One-Time Scheduled Tasks

`time.once` is the subsystem you should reach for **any time a user asks for a one-off action tied to a clock**. Phrases like "in 20 minutes do X", "tomorrow at 9am email me a summary", "remind me at 4pm to push the rc branch", or "schedule a 1h check-in" all map to `time.once` - not to `time.heartbeat`, not to `time.scheduled`, and definitely not to hand-rolled `setTimeout` shims in a prompt.

**Trigger:** poll-based at roughly 30-second granularity. The required `fire_at` field is an ISO-8601 timestamp **with a timezone** (`Z`, `±HH:MM`, or the colon-less `±HHMM`); anything missing the offset is rejected at load time. The subscription fires once when the wall clock crosses `fire_at`.

**Actions:** every `action` already supported by Cue works here.

- `prompt` - runs the configured agent with the rendered prompt (default action).
- `notify` - surfaces a toast through the owning agent. Clicking the toast jumps to that agent. Use this for human reminders that don't need an agent run.
- `command` - `action: command` with `command.mode: shell` or `command.mode: cli`, exactly as documented in **Command Nodes** above.

**Self-destruct semantics:** the engine deletes the subscription from `cue.yaml` after a successful run (status `completed`). On a `failed` or `timeout` outcome, the subscription is also removed unless you set `self_destruct_on_failure: false` (default `true`) - flip it off only when you actively want to inspect the failed sub in the editor before cleaning it up.

**Missed-fire grace window:** if Maestro is closed when `fire_at` arrives, the engine fires the subscription on next startup as long as the current time is within `grace_minutes` of `fire_at`. Default `grace_minutes` is `360` (6 hours). Past the grace window, the sub is logged as expired and self-destructs without firing - pick a smaller window for time-sensitive reminders, a larger one for anything you don't mind being late.

**Default pipeline:** subscriptions authored via `maestro-cli cue schedule` land in `pipeline_name: "Tasks"` so they group into a single "Tasks" card in the Cue dashboard. Override `--pipeline` only when the one-off naturally belongs to an existing pipeline.

**Authoring rule:** **never hand-write `time.once` subscriptions** - always go through `maestro-cli cue schedule`. The CLI handles ISO formatting, timezone offsets, target_node_key generation, and writes directly to the owning agent's `.maestro/cue.yaml`.

**Recipes:**

**"In 20 minutes, do X" → `--in` (relative offset)**

```bash
{{MAESTRO_CLI_PATH}} cue schedule \
  --in 20m \
  --agent {{AGENT_ID}} \
  --prompt "Check the status of the deploy I kicked off and summarize the result."
```

Resolves to a `time.once` subscription whose `fire_at` is 20 minutes from now (in the system timezone, ISO-8601 with offset). The CLI accepts `s` / `m` / `h` / `d` suffixes.

```yaml
- name: tasks-once-20m-deploy-check
  pipeline_name: Tasks
  event: time.once
  enabled: true
  fire_at: '2026-05-22T14:20:00-05:00'
  agent_id: <briefer-agent-id>
  prompt: |
    Check the status of the deploy I kicked off and summarize the result.
```

**"Remind me at 4pm to push the rc branch" → `--at` (absolute timestamp) + `--notify`**

```bash
{{MAESTRO_CLI_PATH}} cue schedule \
  --at "2026-05-22 16:00" \
  --agent {{AGENT_ID}} \
  --notify \
  --sticky \
  --message "Push rc branch - review the diff first"
```

`--notify` switches the action to `notify`. `--sticky` marks the toast as `dismissible` (no auto-dismiss). The toast's click action jumps to the owning agent.

```yaml
- name: tasks-once-push-rc-reminder
  pipeline_name: Tasks
  event: time.once
  enabled: true
  fire_at: '2026-05-22T16:00:00-05:00'
  agent_id: <agent-id>
  action: notify
  notify:
    message: 'Push rc branch - review the diff first'
    sticky: true
```

**Management:**

```bash
# List every pending one-time task across agents
{{MAESTRO_CLI_PATH}} cue schedule --list

# Cancel a pending task by its sub name
{{MAESTRO_CLI_PATH}} cue schedule --cancel tasks-once-push-rc-reminder
```

`--list` only shows enabled, unfired `time.once` subs (completed/expired ones have already self-destructed). `--cancel` deletes the sub from cue.yaml in place.

### Pipelines vs. Chains (READ THIS FIRST)

A **pipeline** is a logical grouping of related subscriptions in `cue.yaml` - it's what shows up as one named card in the Cue dashboard / Pipeline Editor. A **chain** is a single subscription (or topology of subscriptions: linear chain, fan-out, fan-in) **inside** a pipeline.

**Two non-negotiable defaults - apply BOTH every time:**

1. **Group related chains under one pipeline.** Do not create one pipeline per chain. If the user describes several automations that share a theme (e.g., "morning briefing + EOD wrap-up + weekly review", or "PR triage + PR review + PR merge"), put them in the same pipeline. Separate pipelines are only justified when the work is genuinely unrelated (different domains, different agents, different lifecycles).
2. **One trigger → one agent node. Never fan-in by default.** Every subscription gets its own unique `target_node_key` (any UUID) so the Pipeline Editor renders each chain as its own visual line - even when several chains share the same `agent_id`. Fan-in (multiple triggers collapsing onto one shared node) is a deliberate, opt-in topology - never the result of omitting `target_node_key`. The user's reasoning: an individual chain trivially extends to `trigger → agent → agent`, while a fan-in node has to be untangled first to add a downstream stage.

How grouping is expressed in YAML:

1. **`pipeline_name` field on each subscription** - authoritative. Every subscription that belongs to the same pipeline gets the same `pipeline_name` value. This survives renaming individual subscriptions.
2. **`# Pipeline: Name (color: #hex)` comment header** at the top of `cue.yaml` declares the pipeline's display name and dot color in the UI.
3. **Naming convention** (legacy / human-friendly): the first subscription's `name` matches the pipeline name; additional chains use `Name-chain-1`, `Name-chain-2`, etc. The Pipeline Editor emits this convention automatically.
4. **`target_node_key`** (UUID) on every subscription - even the first one. Mixing keyed and unkeyed subs for the same `agent_id` is fragile: the legacy dedup-by-sessionName fallback can still collapse them depending on YAML ordering. Make every sub explicit.

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

**Default: independent chains, even when they share an agent.** When several subscriptions live in the same pipeline, give each its own unique `target_node_key` (any UUID will do) so the Pipeline Editor renders them as parallel chains rather than collapsing to a fan-in node. Whether they reuse one `agent_id` or use distinct ones is a separate decision - `target_node_key` controls the _visual_ graph; `agent_id` controls _which agent runs the work_.

- **Same `agent_id`, distinct `target_node_key`s** → one agent runs every chain (shared session, serialized queue), but each chain shows up as its own agent node labelled `Name (1)`, `Name (2)`, etc. This is the right default for a single-project pipeline whose stages are conceptually independent but happen to share one workspace.
- **Distinct `agent_id`s** → fully isolated agents per chain (separate context, can run in parallel). Reach for this only when the chains genuinely need different contexts, models, or project roots.
- **Same `agent_id` and same `target_node_key`** → real fan-in (multiple triggers / upstreams converge on one shared node). Reserve for cases where you actually need a single output point.

**Don't omit `target_node_key`** when several subs in a pipeline share an `agent_id`. Without it, the loader falls back to dedup-by-sessionName and silently collapses every sub onto one node - which is what produces the unintentional fan-in look.

Topologies available:

- **Chain:** A's `agent.completed` fires B. B's `agent.completed` fires C.
- **Fan-out:** one subscription's `fan_out: [agentA, agentB]` dispatches in parallel with per-target `fan_out_prompts`. Use `fan_out_node_keys` to give each target its own visual node.
- **Fan-in:** `source_session: [a, b, c]` fires once ALL listed sources complete (subject to `fan_in_timeout_minutes` / `fan_in_timeout_on_fail`). Each upstream output is available as `{{CUE_OUTPUT_<NAME>}}` (uppercased session name); `include_output_from` narrows which sources contribute to `{{CUE_SOURCE_OUTPUT}}`. **Reserve for cases where you genuinely need synchronized convergence** - e.g. summarizing three parallel research agents into one digest. Don't reach for fan-in just because several triggers happen to share a target.
- **Forwarding:** an intermediate agent can pass an upstream's output through to a downstream agent by listing the source name in `forward_output_from: [<name>]`. The forwarded value is exposed downstream as `{{CUE_FORWARDED_<NAME>}}`.
- **Command node:** a subscription with `action: command` that runs a shell command (`command.mode: shell`) or a `maestro-cli` call (`command.mode: cli`) instead of an AI prompt. Emits `agent.completed` like any other run, so a downstream agent reads its stdout via `{{CUE_SOURCE_OUTPUT}}` (use `source_sub: <command-sub-name>` to pin the chain to that command and not other completions in the same session). See **Command Nodes** below for the full schema.
- **`cli_output`:** an object `cli_output: { target: "<source-agent-id>" }`. When set, the run's stdout is returned to that agent (typically the one that ran `maestro-cli send` or `cue trigger --source-agent-id`). **Deprecated** - prefer a downstream `action: command` subscription with `command.mode: cli`.

All of the topologies above can (and usually should) live inside a single pipeline - set the same `pipeline_name` on every subscription that participates.

### Command Nodes (`action: command`)

A **Command node** is a subscription that runs a shell command or invokes `maestro-cli` instead of dispatching a prompt to an AI agent. There is no separate top-level YAML key, no `event: command` type, and no separate node-graph - it's just a normal subscription with `action: command` plus a `command:` block. It lives in the same `subscriptions:` array as agent-prompt subs and shares all the standard fields (`pipeline_name`, `target_node_key`, `source_session`, etc.).

**Schema:**

```yaml
- name: <unique-within-file>
  event: <any of the 9 event types - see Event Types table>
  enabled: true
  action: command # required to become a Command node
  command: # required when action: command
    # ---- mode: 'shell' ----
    mode: shell
    shell: 'gh pr list --json number,title' # required, non-empty string
    # ---- OR mode: 'cli' ----
    mode: cli
    cli:
      command: send # required; only 'send' is supported today
      target: <session-id-or-name> # required, supports template vars
      message: '{{CUE_SOURCE_OUTPUT}}' # optional; default is exactly this
  # standard subscription fields all still apply (pipeline_name, target_node_key,
  # source_session, source_sub, event-specific fields like interval_minutes, etc.)
```

**Validator rules:** `command.mode` must be `'shell'` or `'cli'`; `command.shell` must be non-empty; `command.cli.command` must be `'send'`; `command.cli.target` must be non-empty; `command.cli.message` must be a string when present. **`fan_out` is rejected** on `action: command` subs - Command nodes do not fan out. `output_prompt` and the legacy `cli_output` field are silently skipped at runtime for command actions.

**Fields that are NOT configurable per node** (and what they actually use):

| Asked-for            | Reality                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `working_dir`        | Always the **owning session's `projectRoot`** (or the remote `projectRoot` when SSH-wrapped).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `timeout` (per-node) | Inherits `settings.timeout_minutes` (default 30). CLI mode is additionally clamped to a hard 30 s ceiling.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `env`                | Local mode: full `process.env`. SSH mode: `process.env` plus the wrapper's `customEnvVars`. No per-subscription overrides.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Shell selection      | Local: `spawn(..., { shell: true })` uses the user's default shell. SSH: hard-coded `bash -c`. Not configurable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Exit-code handling   | exit `0` → `completed`; non-zero → `failed`; killed-on-timeout → `timeout`. Hard-coded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Retry policy         | None. A failed run is just `failed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Max output size      | No cap on capture itself. Multiple distinct caps apply downstream: **`{{CUE_SOURCE_OUTPUT}}` is sliced to `SOURCE_OUTPUT_MAX_CHARS = 5000`** before reaching the next agent's prompt - head-slice on the run-manager's output-prompt path (`cue-run-manager.ts`), tail-slice on the completion-service downstream chain path (`cue-completion-service.ts`). Independent of that, **CLI mode** truncates the forwarded message at **30 000 chars on Windows / 100 000 on POSIX** to stay under argv ceilings. **History** entries truncate `stdout` at 10 000 chars. The full uncapped stdout only exists in the in-memory `CueRunResult.stdout`. |

**SSH behavior:**

- `mode: shell` honors the owning session's SSH remote config - runs on the remote host via `bash -c <substituted-command>` with the remote `projectRoot` as cwd.
- `mode: cli` is intentionally **local-only**. `maestro-cli send` targets the local Maestro daemon, so SSH-wrapping it would point at the wrong daemon.

**Trigger compatibility:** **All 9 event types can fire a Command node directly** (`app.startup`, `time.heartbeat`, `time.scheduled`, `file.changed`, `agent.completed`, `github.pull_request`, `github.issue`, `task.pending`, `cli.trigger`). Event-specific required fields (`interval_minutes`, `schedule_times`, `watch`, `repo`, `source_session`, etc.) apply normally regardless of `action`. The only `action: command`-specific restriction is the `fan_out` rejection above.

**Output exposure & chaining (READ THIS):** Command runs route through the **same** completion path as agent runs and emit `agent.completed`. Downstream subscriptions chain off Command nodes the exact same way they chain off prompt subs - there is **no** separate `{{CUE_COMMAND_OUTPUT}}` variable, no separate event type:

| Variable                      | Value when source is a Command node                                                                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{{CUE_SOURCE_OUTPUT}}`       | The command's captured stdout, sliced to `SOURCE_OUTPUT_MAX_CHARS = 5000` (head-slice on the output-prompt path, tail-slice on the downstream chain path - see "Max output size" above). |
| `{{CUE_SOURCE_STATUS}}`       | `completed` \| `failed` \| `timeout`                                                                                                                                                     |
| `{{CUE_SOURCE_EXIT_CODE}}`    | Numeric exit code (or `null` on spawn failure or signal-kill, e.g. timeout).                                                                                                             |
| `{{CUE_SOURCE_DURATION}}`     | Milliseconds.                                                                                                                                                                            |
| `{{CUE_SOURCE_SESSION}}`      | Owning session **name** (Command nodes have no session of their own).                                                                                                                    |
| `{{CUE_SOURCE_TRIGGERED_BY}}` | The Command subscription's `name`.                                                                                                                                                       |

**Important chaining nuance:** because a Command node shares its owner's session, every completion in that session (the command run AND any agent run hosted there) emits `agent.completed` for the same `sourceSessionId`. To pin a chain sub to a specific upstream Command node, **set `source_sub` to the command sub's name** so the chain matches by `triggeredBy` instead of just by session:

```yaml
- name: after-shell-step
  event: agent.completed
  source_session: <owning-session-name>
  source_sub: my-shell-step # filters by triggeredBy = this sub name
  prompt: |
    The shell step said:
    {{CUE_SOURCE_OUTPUT}}
```

Without `source_sub`, the chain also fires on every other agent.completed in that session. `source_sub` accepts either a single name (`source_sub: my-shell-step`) or an array of names (`source_sub: [step-a, step-b]`) to OR-match completions from any of the listed upstream subscriptions - useful when one downstream chain should fan-in over several command nodes.

**Worked example - `app.startup` → shell → agent:**

```yaml
# Pipeline: Morning Repo Snapshot (color: #06b6d4)

subscriptions:
  - name: snapshot-shell
    pipeline_name: Morning Repo Snapshot
    target_node_key: 1d3e9c12-7a4b-4e9f-9c11-2f6d8b3a4c01
    event: app.startup
    enabled: true
    action: command
    command:
      mode: shell
      shell: |
        git log --since=yesterday --pretty='%h %s' &&
        echo --- &&
        gh pr list --state open --json number,title,author --limit 10

  - name: snapshot-summary
    pipeline_name: Morning Repo Snapshot
    target_node_key: 5e8d4a76-2b1f-4c3a-9e7d-3f4b8c1a6d92
    event: agent.completed
    enabled: true
    source_session: <owning-session-name> # the session that owns cue.yaml
    source_sub: snapshot-shell # pin to the shell step only
    agent_id: <briefer-agent-id>
    prompt: |
      Today's repo state (from the shell snapshot):

      {{CUE_SOURCE_OUTPUT}}

      Status: {{CUE_SOURCE_STATUS}}, exit {{CUE_SOURCE_EXIT_CODE}}.

      Give me a 5-bullet briefing: what shipped, what's open, who's blocked.
```

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
`{{CUE_GH_TYPE}}`, `{{CUE_GH_NUMBER}}`, `{{CUE_GH_TITLE}}`, `{{CUE_GH_AUTHOR}}`, `{{CUE_GH_URL}}`, `{{CUE_GH_BODY}}`, `{{CUE_GH_LABELS}}`, `{{CUE_GH_STATE}}`, `{{CUE_GH_REPO}}`, `{{CUE_GH_BRANCH}}`, `{{CUE_GH_BASE_BRANCH}}`, `{{CUE_GH_ASSIGNEES}}`, `{{CUE_GH_MERGED_AT}}`, `{{CUE_NEW_COMMENTS}}` (comments posted since the last fire - only populated when `retrigger_on_comments: true`), `{{CUE_GH_IS_RETRIGGER}}` (`"true"` / `"false"`), `{{CUE_GH_RETRIGGER_COUNT}}` (re-fire counter, `0` on initial discovery)

**`cli.trigger`:**
`{{CUE_CLI_PROMPT}}`, `{{CUE_SOURCE_AGENT_ID}}`

**`time.once`:** `{{CUE_FIRE_AT}}` (the originally-scheduled fire timestamp, ISO-8601 with timezone — handy for "you asked me to remind you at {{CUE_FIRE_AT}}" phrasing in notify messages or prompts)

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

1. Read the existing config first to understand current subscriptions, pipelines, and naming conventions. Check `.maestro/cue.yaml` (canonical) first, then `maestro-cue.yaml` at the project root (legacy fallback). **If the pipeline involves agents at more than one project root, you must read every participating agent's cue.yaml - there is no single aggregated file.** See **Multi-Root Pipelines** above.
2. Keep subscription `name` values unique within the file - the engine keys on them.
3. **Group related chains under one pipeline.** Before adding a new subscription, check whether it belongs in an existing pipeline (matching theme, agent set, or domain) - if so, reuse that `pipeline_name` instead of creating a new pipeline. If the user describes several related automations in one request, emit them as multiple subscriptions sharing a single `pipeline_name`, not as separate pipelines.
4. **Within a pipeline, give each subscription its own `target_node_key`** (any UUID) so the Pipeline Editor renders the chains as separate visual lines instead of collapsing them onto one fan-in agent node. This applies whether the chains share an `agent_id` or not. Only reuse a `target_node_key` across subscriptions when you actually want a real fan-in node (multiple triggers/upstreams converging onto one shared agent node). If two chains genuinely need isolated context/models/project-roots, also give them distinct `agent_id`s (create with `{{MAESTRO_CLI_PATH}} create-agent <name> --cwd <project>` if needed); otherwise reusing one `agent_id` is fine and often preferred.
5. **For Command nodes (shell scripts or `maestro-cli` calls inside a pipeline)** - see the **Command Nodes** section above for the full schema. The keyword is `action: command` plus a `command:` block; there is no separate top-level YAML key, no `event: command` type, and no separate node graph.
6. For full schema, field reference, and worked examples, fetch the official Cue docs: https://docs.runmaestro.ai/maestro-cue-configuration.md, https://docs.runmaestro.ai/maestro-cue-events.md, https://docs.runmaestro.ai/maestro-cue-advanced.md, https://docs.runmaestro.ai/maestro-cue-examples.md. Don't guess field names.
7. After writing, validate with `{{MAESTRO_CLI_PATH}} cue list` - the engine reloads automatically when the file changes.
8. For one-off / scheduled tasks (any natural-language request that maps to "do X at a specific time, once"), use `{{MAESTRO_CLI_PATH}} cue schedule` - see the **One-Time Scheduled Tasks** section. Never hand-write `time.once` subscriptions; let the CLI generate them.

### Multi-Root Pipelines (agents in different project roots)

A pipeline that spans agents living in **different** project roots is NOT a single-file authoring task. The engine never aggregates yaml files across roots - each agent's runtime only sees `<its-own-projectRoot>/.maestro/cue.yaml`. A pipeline split across N agents at N different roots is physically N separate yaml files; the visual Pipeline Editor manages this for you by writing one file per participating agent's cwd on every save.

**When authoring multi-root pipelines by hand, the rule is:**

- **Each subscription lives in its owning agent's local `.maestro/cue.yaml`.** "Owning agent" = the agent whose `agent_id` matches the subscription's `agent_id` field. Put the subscription in that agent's project root, not anywhere else.
- **Cross-agent chains stitch at runtime via the standard `source_session` / `fan_out` fields, with `_ids` companions for rename stability.** For `agent.completed` chains, `source_session` (the upstream agent's display name, or an array of names for fan-in) is **required** by the validator - supply `source_session_ids: [<upstream-agent-uuid>]` **alongside** it so the dispatcher can resolve the chain even if the upstream is renamed (ids are preferred at lookup time, names are the fallback). Same shape for fan-out: `fan_out: [<target-name>, ...]` is the canonical field, plus `fan_out_ids: [<uuid>, ...]` for rename safety. The downstream subscription itself lives in the _downstream_ (consuming) agent's cue.yaml - the agent whose `agent_id` it carries.
- **Fan-in / synthesis / orchestration subscriptions live with their target agent.** If "agent X waits for A, B, C to complete and summarizes," that fan-in subscription is in agent X's cue.yaml (not in A's, B's, or C's). When agent X is an orchestrator sitting at the workspace root and the workers are in subdirectories, that fan-in naturally lands in the root workspace's `.maestro/cue.yaml` - but the rule is "owning agent's cwd," not "root cwd."
- **A single root cue.yaml is NOT a reliable pattern for a multi-root fleet.** Subscriptions placed at the root that name workers in subdirectories will never reach those workers - the workers' engines never read the root file. If the visual editor previously emitted a single root yaml that "worked," that pipeline only had subs whose `agent_id` resolved to the root agent.

**Where to author what:**

| Subscription role                                                       | Lives in cue.yaml under...                                                        |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Trigger consumed by agent A (e.g. `file.changed` that prompts agent A)  | Agent A's project root                                                            |
| Fan-out from A to [B, C, D]                                             | Agent A's project root (set `fan_out` + `fan_out_ids`)                            |
| `agent.completed` chain step where downstream is agent Y, upstream is X | Agent Y's project root (set `source_session` + `source_session_ids` to X)         |
| Fan-in synthesis where downstream is Z, upstreams are A, B, C           | Agent Z's project root (set `source_session` + `source_session_ids` to [A, B, C]) |
| Command node (`action: command`) attached to agent W's session          | Agent W's project root (it shares W's session/cwd)                                |

**Discovery / writing checklist for hand-edited multi-root pipelines:**

1. List the participating agents and their project roots: `{{MAESTRO_CLI_PATH}} list agents` (note each agent's `id` and `cwd`).
2. For each agent that owns one or more subscriptions in the pipeline, open / create `<that-agent-cwd>/.maestro/cue.yaml`.
3. Write each subscription under the cue.yaml of its `agent_id` owner. Use the same `pipeline_name` value across all files so the dashboard groups them under one pipeline card.
4. For cross-agent references, always set `source_session` / `fan_out` (the validator requires `source_session` on every `agent.completed` sub) and **additionally** set the parallel `source_session_ids` / `fan_out_ids` UUID arrays so the dispatcher survives an upstream rename. The dispatcher prefers ids at lookup time; names are the fallback. Omitting the ids works but breaks silently when an agent gets renamed.
5. Validate from any agent's workspace with `{{MAESTRO_CLI_PATH}} cue list` - the command reports every agent's parsed config, so a missing or misplaced sub is immediately visible.

**Single-root pipelines** (all subs target one agent, or all participating agents share one project root) live in exactly one cue.yaml under that one root - the multi-root rules above don't apply. The "Shared Workspaces" section below covers the related case where >1 agent is registered against the _same_ project root.

### Shared Workspaces: `settings.owner_agent_id`

When two or more agents are registered against the same project root (for example, an Opus and a Sonnet agent both pointing at the same Obsidian vault), every subscription in `cue.yaml` is either **pinned to a single agent** or **disabled** - there is no mode where an unowned subscription broadcasts to every agent in the root. Which state applies depends on `owner_agent_id` and the per-subscription `agent_id`:

- **Always prefer explicit `agent_id` per subscription** when you want a specific agent (or several, via chains / fan-out) to run work in a shared workspace. That is the reliable way to target multiple agents from one `cue.yaml`.
- **Set `settings.owner_agent_id`** to the agent's internal id (UUID) **or** display name to pin every _unowned_ subscription (no `agent_id`) to that agent. Prefer the UUID when two agents share a display name - a name with multiple matches is flagged as ambiguous and unowned subs are disabled until it's resolved.
- **If `owner_agent_id` is unset and >1 agent shares the root**, the first agent in the session list is picked as a deterministic fallback owner; non-winners are flagged in the Cue dashboard with a red warning pointing to `owner_agent_id`. Do not rely on this fallback - set `owner_agent_id` explicitly.
- **If `owner_agent_id` is set but no agent in the root matches it**, every agent there is flagged and unowned subscriptions are disabled until the value is fixed.

When authoring `cue.yaml` for a workspace that may be registered under more than one agent, set `owner_agent_id` proactively. Use `{{MAESTRO_CLI_PATH}} list agents` to discover ids and names.

### Natural-Language → YAML Recipes

Translate the user's phrasing into one of these starter templates, then adapt names/prompts/agent ids. Always set `agent_id` to the target agent (use `{{MAESTRO_CLI_PATH}} list agents` to find ids).

**Each recipe below is a single chain.** When a user request maps to more than one chain:

- Assign every chain the same `pipeline_name` (and add a `# Pipeline: Name (color: #hex)` comment header at the top of the file) so they group into one pipeline in the UI. Only split into separate pipelines when the chains are genuinely unrelated.
- **Add a unique `target_node_key` (any UUID) to every subscription** - the recipes below omit it because they're standalone single-chain examples, but the moment you emit two or more subscriptions in one file you must give each its own key. Otherwise the Pipeline Editor collapses them into one fan-in agent node, which is never the default we want. The `agent.completed (fan-in)` recipe is the one exception - that's a deliberate convergence node.

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

**"Re-fire when a PR/issue receives new activity (comments, reviews, labels)" - opt-in re-trigger.**

By default, a `github.pull_request` / `github.issue` subscription fires **once** per item, on initial discovery. Set `retrigger_on_comments: true` to also re-fire when the item's `updatedAt` advances - comments, edits, reviews, label changes all qualify. Each re-fire payload carries the comments posted since the previous fire as `{{CUE_NEW_COMMENTS}}` so the prompt can react to the new context. Use `max_notifications` to cap how many times a single PR/issue can re-fire (default `10`; set to `0` for unlimited). This is what enables agent-to-agent back-and-forth over GitHub without flooding when a stranger spams a public repo.

```yaml
- name: pr-discussion
  event: github.pull_request
  enabled: true
  repo: owner/name
  poll_minutes: 5
  retrigger_on_comments: true # off by default; opt in for agent ↔ GitHub conversations
  max_notifications: 10 # per-PR cap on re-fires (0 = unlimited)
  agent_id: <agent-id>
  prompt: |
    PR #{{CUE_GH_NUMBER}}: "{{CUE_GH_TITLE}}" - {{CUE_GH_URL}}

    {{#CUE_GH_IS_RETRIGGER}}New activity since the last fire:{{/CUE_GH_IS_RETRIGGER}}
    {{CUE_NEW_COMMENTS}}

    Decide whether a reply is warranted, and post one with `gh pr comment` if so.
```

Counter semantics: the **initial discovery fire is always allowed** and does NOT count toward the cap. With `max_notifications: 10` you get 1 initial + 10 re-fires = 11 total fires per PR/issue. Once the cap is hit, the poller stops emitting events for that item but freezes its tracked revision, so raising the cap later resumes from the right point rather than replaying stale activity.

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

**"Run this shell command, then have an agent work on the output" → `action: command` (shell) → `agent.completed` chain**

```yaml
- name: gather-pr-list
  event: time.heartbeat
  enabled: true
  interval_minutes: 30
  action: command
  command:
    mode: shell
    shell: 'gh pr list --state open --json number,title,author,updatedAt --limit 20'

- name: triage-prs
  event: agent.completed
  enabled: true
  source_session: <owning-session-name>
  source_sub: gather-pr-list # pin chain to the shell step only
  agent_id: <triage-agent-id>
  prompt: |
    Open PRs (from `gh pr list`):

    {{CUE_SOURCE_OUTPUT}}

    Flag anything stale (>3 days no update) and suggest a reviewer for each.
```

**"After this agent finishes, send its output to another agent over `maestro-cli`" → `action: command` (cli)**

```yaml
- name: forward-summary
  event: agent.completed
  enabled: true
  source_session: <upstream-agent-name>
  action: command
  command:
    mode: cli
    cli:
      command: send
      target: <downstream-agent-id-or-name>
      # message defaults to '{{CUE_SOURCE_OUTPUT}}' when omitted
```

After authoring, write the YAML to `<project-root>/.maestro/cue.yaml` (create the `.maestro/` directory if it doesn't exist), then run `{{MAESTRO_CLI_PATH}} cue list` to confirm the engine sees it.
