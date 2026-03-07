---
title: Cue Examples
description: Real-world Maestro Cue configurations for common automation workflows.
icon: lightbulb
---

Complete, copy-paste-ready `maestro-cue.yaml` configurations for common workflows. Each example is self-contained — drop it into your project root and adjust agent names to match your Left Bar.

## CI-Style Pipeline

Lint, test, and deploy in sequence. Each step only runs if the previous one succeeded.

**Agents needed:** `linter`, `tester`, `deployer`

The `linter` agent's `maestro-cue.yaml`:

```yaml
subscriptions:
  - name: lint-on-save
    event: file.changed
    watch: 'src/**/*.{ts,tsx}'
    prompt: |
      Run `npx eslint {{CUE_FILE_PATH}} --fix`.
      Report any errors that couldn't be auto-fixed.
```

The `tester` agent's `maestro-cue.yaml`:

```yaml
subscriptions:
  - name: test-after-lint
    event: agent.completed
    source_session: 'linter'
    filter:
      status: completed
      exitCode: 0
    prompt: |
      Lint passed. Run `npm test` and report results.
```

The `deployer` agent's `maestro-cue.yaml`:

```yaml
subscriptions:
  - name: deploy-after-tests
    event: agent.completed
    source_session: 'tester'
    filter:
      status: completed
      exitCode: 0
    prompt: |
      Tests passed. Deploy to staging with `npm run deploy:staging`.
```

---

## Selective Chaining with triggeredBy

When an agent has multiple subscriptions but only one should chain to another agent, use the `triggeredBy` filter. This field contains the subscription name that triggered the completing run.

**Agents needed:** `worker` (has multiple cue subscriptions), `reviewer`

The `worker` agent's `maestro-cue.yaml`:

```yaml
subscriptions:
  # This one should NOT trigger the reviewer
  - name: routine-cleanup
    event: time.interval
    interval_minutes: 60
    prompt: Run `npm run clean` and remove stale build artifacts.

  # This one should NOT trigger the reviewer either
  - name: lint-check
    event: file.changed
    watch: 'src/**/*.ts'
    prompt: Lint {{CUE_FILE_PATH}}.

  # Only THIS one should trigger the reviewer
  - name: implement-feature
    event: github.issue
    filter:
      labels: 'enhancement'
    prompt: |
      New feature request: {{CUE_GH_TITLE}} (#{{CUE_GH_NUMBER}})
      {{CUE_GH_BODY}}

      Implement this feature following existing patterns.
```

The `reviewer` agent's `maestro-cue.yaml`:

```yaml
subscriptions:
  - name: review-new-feature
    event: agent.completed
    source_session: 'worker'
    filter:
      triggeredBy: 'implement-feature' # Only chains from this specific subscription
      status: completed
    prompt: |
      The worker just implemented a feature. Review the changes:

      {{CUE_SOURCE_OUTPUT}}

      Check for:
      1. Code quality and consistency
      2. Missing test coverage
      3. Documentation gaps
```

The `triggeredBy` filter also supports glob patterns: `triggeredBy: "implement-*"` matches any subscription name starting with `implement-`.

---

## Research Swarm

Fan out a question to multiple agents, then fan in to synthesize results.

**Agents needed:** `coordinator`, `researcher-a`, `researcher-b`, `researcher-c`

The `coordinator` agent's `maestro-cue.yaml`:

```yaml
subscriptions:
  # Fan-out: send the research question to all researchers
  - name: dispatch-research
    event: file.changed
    watch: 'research-question.md'
    fan_out:
      - 'researcher-a'
      - 'researcher-b'
      - 'researcher-c'
    prompt: |
      Research the following question from different angles.
      File: {{CUE_FILE_PATH}}

      Read the file and provide a thorough analysis.

  # Fan-in: synthesize when all researchers finish
  - name: synthesize-results
    event: agent.completed
    source_session:
      - 'researcher-a'
      - 'researcher-b'
      - 'researcher-c'
    prompt: |
      All researchers have completed their analysis.

      Combined outputs:
      {{CUE_SOURCE_OUTPUT}}

      Synthesize these perspectives into a single coherent report.
      Highlight agreements, contradictions, and key insights.

settings:
  timeout_minutes: 60
  timeout_on_fail: continue # Synthesize with partial results if someone times out
```

---

## PR Review with Targeted Follow-Up

Auto-review new PRs, then selectively notify a security reviewer only for PRs that touch auth code.

**Agents needed:** `pr-reviewer`, `security-reviewer`

The `pr-reviewer` agent's `maestro-cue.yaml`:

```yaml
subscriptions:
  - name: review-all-prs
    event: github.pull_request
    poll_minutes: 3
    filter:
      draft: false
      base_branch: main
    prompt: |
      New PR: {{CUE_GH_TITLE}} (#{{CUE_GH_NUMBER}})
      Author: {{CUE_GH_AUTHOR}}
      Branch: {{CUE_GH_BRANCH}} -> {{CUE_GH_BASE_BRANCH}}
      URL: {{CUE_GH_URL}}

      {{CUE_GH_BODY}}

      Review for code quality, bugs, and style.
      In your output, list all files changed.
```

The `security-reviewer` agent's `maestro-cue.yaml`:

```yaml
subscriptions:
  - name: security-review
    event: agent.completed
    source_session: 'pr-reviewer'
    filter:
      triggeredBy: 'review-all-prs'
      status: completed
    prompt: |
      A PR was just reviewed. Check if any auth/security-sensitive files were changed:

      {{CUE_SOURCE_OUTPUT}}

      If auth, session, or permission-related code was modified:
      1. Audit the changes for security vulnerabilities
      2. Check for injection, XSS, or auth bypass risks
      3. Verify proper input validation

      If no security-sensitive files were changed, respond with "No security review needed."
```

---

## TODO Task Queue

Watch a markdown file for unchecked tasks and work through them sequentially.

**Agents needed:** `task-worker`

```yaml
subscriptions:
  - name: work-todos
    event: task.pending
    watch: 'TODO.md'
    poll_minutes: 2
    filter:
      taskCount: '>=1'
    prompt: |
      There are {{CUE_TASK_COUNT}} pending tasks in {{CUE_TASK_FILE}}:

      {{CUE_TASK_LIST}}

      Pick the FIRST unchecked task and complete it.
      When done, change `- [ ]` to `- [x]` in the file.
      Do NOT work on more than one task at a time.

settings:
  max_concurrent: 1 # Serial execution — one task at a time
```

---

## Multi-Environment Deploy

Fan out deployments to staging, production, and docs after a build passes.

**Agents needed:** `builder`, `deploy-staging`, `deploy-prod`, `deploy-docs`

The `builder` agent's `maestro-cue.yaml`:

```yaml
subscriptions:
  - name: build-on-push
    event: file.changed
    watch: 'src/**/*'
    prompt: |
      Source files changed. Run a full build with `npm run build`.
      Report success or failure.
```

Any agent with visibility to `builder` (e.g., `deploy-staging`):

```yaml
subscriptions:
  - name: fan-out-deploy
    event: agent.completed
    source_session: 'builder'
    filter:
      triggeredBy: 'build-on-push'
      exitCode: 0
    fan_out:
      - 'deploy-staging'
      - 'deploy-prod'
      - 'deploy-docs'
    prompt: |
      Build succeeded. Deploy your target environment.
      Build output: {{CUE_SOURCE_OUTPUT}}
```

---

## Issue Triage Bot

Auto-triage new GitHub issues by labeling and assigning them.

**Agents needed:** `triage-bot`

```yaml
subscriptions:
  - name: triage-issues
    event: github.issue
    poll_minutes: 5
    filter:
      state: open
      labels: '!triaged' # Skip already-triaged issues
    prompt: |
      New issue needs triage: {{CUE_GH_TITLE}} (#{{CUE_GH_NUMBER}})
      Author: {{CUE_GH_AUTHOR}}
      Labels: {{CUE_GH_LABELS}}

      {{CUE_GH_BODY}}

      Triage this issue:
      1. Identify the component/area affected
      2. Estimate complexity (small / medium / large)
      3. Suggest priority (P0-P3)
      4. Recommend an assignee based on the area
      5. Run `gh issue edit {{CUE_GH_NUMBER}} --add-label "triaged"` to mark as triaged
```

---

## Debate Pattern

Two agents analyze a problem independently, then a third synthesizes their perspectives.

**Agents needed:** `advocate`, `critic`, `judge`

The config that triggers the debate (on any agent with visibility):

```yaml
subscriptions:
  - name: start-debate
    event: file.changed
    watch: 'debate-topic.md'
    fan_out:
      - 'advocate'
      - 'critic'
    prompt: |
      Read {{CUE_FILE_PATH}} and analyze the proposal.

      You are assigned a role — argue from that perspective:
      - advocate: argue IN FAVOR, highlight benefits and opportunities
      - critic: argue AGAINST, highlight risks and weaknesses

      Be thorough and specific.
```

The `judge` agent's `maestro-cue.yaml`:

```yaml
subscriptions:
  - name: synthesize-debate
    event: agent.completed
    source_session:
      - 'advocate'
      - 'critic'
    prompt: |
      Both sides of the debate have been presented.

      Arguments:
      {{CUE_SOURCE_OUTPUT}}

      As the judge:
      1. Summarize each side's strongest points
      2. Identify where they agree and disagree
      3. Render a verdict with your reasoning
      4. Propose a path forward that addresses both perspectives

settings:
  timeout_minutes: 45
  timeout_on_fail: continue
```

---

## Scheduled Report with Conditional Chain

Generate an hourly report, but only notify a summary agent when there's meaningful activity.

**Agents needed:** `reporter`, `summarizer`

The `reporter` agent's `maestro-cue.yaml`:

```yaml
subscriptions:
  - name: hourly-git-report
    event: time.interval
    interval_minutes: 60
    prompt: |
      Generate a report of git activity in the last hour.
      Run `git log --oneline --since="1 hour ago"`.

      If there are commits, format them as a structured report.
      If there are no commits, respond with exactly: "NO_ACTIVITY"
```

The `summarizer` agent's `maestro-cue.yaml`:

```yaml
subscriptions:
  - name: summarize-activity
    event: agent.completed
    source_session: 'reporter'
    filter:
      triggeredBy: 'hourly-git-report'
      status: completed
    prompt: |
      The hourly reporter just finished. Here's its output:

      {{CUE_SOURCE_OUTPUT}}

      If the output says "NO_ACTIVITY", respond with "Nothing to summarize."
      Otherwise, create a concise executive summary of the development activity.
```
