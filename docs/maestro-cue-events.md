---
title: Cue Event Types
description: Detailed reference for all six Maestro Cue event types with configuration, payloads, and examples.
icon: calendar-check
---

Cue supports six event types. Each type watches for a different kind of activity and produces a payload that can be injected into prompts via [template variables](./maestro-cue-advanced#template-variables).

## time.interval

Fires on a periodic timer. The subscription triggers immediately when the engine starts, then repeats at the configured interval.

**Required fields:**

| Field              | Type   | Description                            |
| ------------------ | ------ | -------------------------------------- |
| `interval_minutes` | number | Minutes between triggers (must be > 0) |

**Behavior:**

- Fires immediately on engine start (or when the subscription is first loaded)
- Reconciles missed intervals after system sleep — if your machine sleeps through one or more intervals, Cue fires a catch-up event on wake
- The interval resets after each trigger, not after each run completes

**Example:**

```yaml
subscriptions:
  - name: hourly-summary
    event: time.interval
    interval_minutes: 60
    prompt: |
      Generate a summary of git activity in the last hour.
      Run `git log --oneline --since="1 hour ago"` and organize by author.
```

**Payload fields:** None specific to this event type. Use common variables like `{{CUE_TRIGGER_NAME}}` and `{{CUE_EVENT_TIMESTAMP}}`.

---

## file.changed

Fires when files matching a glob pattern are created, modified, or deleted.

**Required fields:**

| Field   | Type          | Description                       |
| ------- | ------------- | --------------------------------- |
| `watch` | string (glob) | Glob pattern for files to monitor |

**Behavior:**

- Monitors for `add`, `change`, and `unlink` (delete) events
- Debounces by 5 seconds per file — rapid saves to the same file produce a single event
- The glob is evaluated relative to the project root
- Standard glob syntax: `*` matches within a directory, `**` matches across directories

**Example:**

```yaml
subscriptions:
  - name: test-on-change
    event: file.changed
    watch: 'src/**/*.{ts,tsx}'
    filter:
      changeType: '!unlink' # Don't trigger on file deletions
    prompt: |
      The file {{CUE_FILE_PATH}} was {{CUE_EVENT_TYPE}}.
      Run the tests related to this file and report results.
```

**Payload fields:**

| Variable                   | Description                       | Example                   |
| -------------------------- | --------------------------------- | ------------------------- |
| `{{CUE_FILE_PATH}}`        | Absolute path to the changed file | `/project/src/app.ts`     |
| `{{CUE_FILE_NAME}}`        | Filename only                     | `app.ts`                  |
| `{{CUE_FILE_DIR}}`         | Directory containing the file     | `/project/src`            |
| `{{CUE_FILE_EXT}}`         | File extension (with dot)         | `.ts`                     |
| `{{CUE_FILE_CHANGE_TYPE}}` | Change type                       | `add`, `change`, `unlink` |

The `changeType` field is also available in [filters](./maestro-cue-advanced#filtering).

---

## agent.completed

Fires when another Maestro agent finishes a task. This is the foundation for agent chaining — building multi-step pipelines where one agent's completion triggers the next.

**Required fields:**

| Field            | Type           | Description                                     |
| ---------------- | -------------- | ----------------------------------------------- |
| `source_session` | string or list | Name(s) of the agent(s) to watch for completion |

**Behavior:**

- **Single source** (string): Fires immediately when the named agent completes
- **Multiple sources** (list): Waits for **all** named agents to complete before firing (fan-in). See [Fan-In](./maestro-cue-advanced#fan-in)
- The source agent's output is captured and available via `{{CUE_SOURCE_OUTPUT}}` (truncated to 5,000 characters)
- Matches agent names as shown in the Left Bar

**Example — single source:**

```yaml
subscriptions:
  - name: deploy-after-build
    event: agent.completed
    source_session: 'builder'
    filter:
      exitCode: 0 # Only deploy if build succeeded
    prompt: |
      The build agent completed successfully.
      Output: {{CUE_SOURCE_OUTPUT}}

      Deploy to staging with `npm run deploy:staging`.
```

**Example — fan-in (multiple sources):**

```yaml
subscriptions:
  - name: integration-tests
    event: agent.completed
    source_session:
      - 'backend-build'
      - 'frontend-build'
    prompt: |
      Both builds completed. Run the full integration test suite.
```

**Payload fields:**

| Variable                      | Description                                            | Example           |
| ----------------------------- | ------------------------------------------------------ | ----------------- |
| `{{CUE_SOURCE_SESSION}}`      | Name of the completing agent(s)                        | `builder`         |
| `{{CUE_SOURCE_OUTPUT}}`       | Truncated stdout from the source (max 5K chars)        | `Build succeeded` |
| `{{CUE_SOURCE_STATUS}}`       | Run status (`completed`, `failed`, `timeout`)          | `completed`       |
| `{{CUE_SOURCE_EXIT_CODE}}`    | Process exit code                                      | `0`               |
| `{{CUE_SOURCE_DURATION}}`     | Run duration in milliseconds                           | `15000`           |
| `{{CUE_SOURCE_TRIGGERED_BY}}` | Name of the subscription that triggered the source run | `lint-on-save`    |

These fields are also available in [filters](./maestro-cue-advanced#filtering).

The `triggeredBy` field is particularly useful when a source agent has multiple Cue subscriptions but you only want to chain from a specific one. See [Selective Chaining](./maestro-cue-examples#selective-chaining-with-triggeredby) for a complete example.

---

## task.pending

Watches markdown files for unchecked task items (`- [ ]`) and fires when pending tasks are found.

**Required fields:**

| Field   | Type          | Description                             |
| ------- | ------------- | --------------------------------------- |
| `watch` | string (glob) | Glob pattern for markdown files to scan |

**Optional fields:**

| Field          | Type   | Default | Description                       |
| -------------- | ------ | ------- | --------------------------------- |
| `poll_minutes` | number | 1       | Minutes between scans (minimum 1) |

**Behavior:**

- Scans files matching the glob pattern at the configured interval
- Fires when unchecked tasks (`- [ ]`) are found
- Only fires when the task list changes (new tasks appear or existing ones are modified)
- The full task list is formatted and available via `{{CUE_TASK_LIST}}`
- File content (truncated to 10K characters) is available via `{{CUE_TASK_CONTENT}}`

**Example:**

```yaml
subscriptions:
  - name: todo-worker
    event: task.pending
    watch: '**/*.md'
    poll_minutes: 5
    prompt: |
      Found {{CUE_TASK_COUNT}} pending tasks in {{CUE_TASK_FILE}}:

      {{CUE_TASK_LIST}}

      Pick the most important task and complete it.
      When finished, mark it as done by changing `- [ ]` to `- [x]`.
```

**Payload fields:**

| Variable                 | Description                                | Example                |
| ------------------------ | ------------------------------------------ | ---------------------- |
| `{{CUE_TASK_FILE}}`      | Path to the file containing tasks          | `/project/TODO.md`     |
| `{{CUE_TASK_FILE_NAME}}` | Filename only                              | `TODO.md`              |
| `{{CUE_TASK_FILE_DIR}}`  | Directory containing the file              | `/project`             |
| `{{CUE_TASK_COUNT}}`     | Number of pending tasks found              | `3`                    |
| `{{CUE_TASK_LIST}}`      | Formatted list with line numbers           | `L5: Write unit tests` |
| `{{CUE_TASK_CONTENT}}`   | Full file content (truncated to 10K chars) | _(file contents)_      |

---

## github.pull_request

Polls GitHub for new pull requests using the GitHub CLI (`gh`).

**Optional fields:**

| Field          | Type   | Default | Description                                                                  |
| -------------- | ------ | ------- | ---------------------------------------------------------------------------- |
| `repo`         | string | auto    | GitHub repo in `owner/repo` format. Auto-detected from git remote if omitted |
| `poll_minutes` | number | 5       | Minutes between polls (minimum 1)                                            |

**Behavior:**

- Requires the [GitHub CLI](https://cli.github.com/) (`gh`) to be installed and authenticated
- On first run, seeds the "seen" list with existing PRs — only **new** PRs trigger events
- Tracks seen PRs in a local database with 30-day retention
- Auto-detects the repository from the git remote if `repo` is not specified

**Example:**

```yaml
subscriptions:
  - name: pr-reviewer
    event: github.pull_request
    poll_minutes: 3
    filter:
      draft: false # Skip draft PRs
      base_branch: main # Only PRs targeting main
    prompt: |
      New PR: {{CUE_GH_TITLE}} (#{{CUE_GH_NUMBER}})
      Author: {{CUE_GH_AUTHOR}}
      Branch: {{CUE_GH_BRANCH}} -> {{CUE_GH_BASE_BRANCH}}
      Labels: {{CUE_GH_LABELS}}
      URL: {{CUE_GH_URL}}

      {{CUE_GH_BODY}}

      Review this PR for:
      1. Code quality and style consistency
      2. Potential bugs or edge cases
      3. Test coverage
```

**Payload fields:**

| Variable                 | Description                       | Example                               |
| ------------------------ | --------------------------------- | ------------------------------------- |
| `{{CUE_GH_TYPE}}`        | Always `pull_request`             | `pull_request`                        |
| `{{CUE_GH_NUMBER}}`      | PR number                         | `42`                                  |
| `{{CUE_GH_TITLE}}`       | PR title                          | `Add user authentication`             |
| `{{CUE_GH_AUTHOR}}`      | Author's GitHub login             | `octocat`                             |
| `{{CUE_GH_URL}}`         | HTML URL to the PR                | `https://github.com/org/repo/pull/42` |
| `{{CUE_GH_BODY}}`        | PR description (truncated)        | _(PR body text)_                      |
| `{{CUE_GH_LABELS}}`      | Comma-separated label names       | `bug, priority-high`                  |
| `{{CUE_GH_STATE}}`       | PR state                          | `open`                                |
| `{{CUE_GH_BRANCH}}`      | Head (source) branch              | `feature/auth`                        |
| `{{CUE_GH_BASE_BRANCH}}` | Base (target) branch              | `main`                                |
| `{{CUE_GH_REPO}}`        | Repository in `owner/repo` format | `RunMaestro/Maestro`                  |

---

## github.issue

Polls GitHub for new issues using the GitHub CLI (`gh`). Behaves identically to `github.pull_request` but for issues.

**Optional fields:**

| Field          | Type   | Default | Description                        |
| -------------- | ------ | ------- | ---------------------------------- |
| `repo`         | string | auto    | GitHub repo in `owner/repo` format |
| `poll_minutes` | number | 5       | Minutes between polls (minimum 1)  |

**Behavior:**

Same as `github.pull_request` — requires GitHub CLI, seeds on first run, tracks seen issues.

**Example:**

```yaml
subscriptions:
  - name: issue-triage
    event: github.issue
    poll_minutes: 5
    filter:
      labels: '!wontfix' # Skip issues labeled wontfix
    prompt: |
      New issue: {{CUE_GH_TITLE}} (#{{CUE_GH_NUMBER}})
      Author: {{CUE_GH_AUTHOR}}
      Assignees: {{CUE_GH_ASSIGNEES}}
      Labels: {{CUE_GH_LABELS}}

      {{CUE_GH_BODY}}

      Triage this issue:
      1. Identify the area of the codebase affected
      2. Estimate complexity (small/medium/large)
      3. Suggest which team member should handle it
```

**Payload fields:**

Same as `github.pull_request`, except:

| Variable               | Description                     | Example      |
| ---------------------- | ------------------------------- | ------------ |
| `{{CUE_GH_TYPE}}`      | Always `issue`                  | `issue`      |
| `{{CUE_GH_ASSIGNEES}}` | Comma-separated assignee logins | `alice, bob` |

The branch-specific variables (`{{CUE_GH_BRANCH}}`, `{{CUE_GH_BASE_BRANCH}}`) are not available for issues.
