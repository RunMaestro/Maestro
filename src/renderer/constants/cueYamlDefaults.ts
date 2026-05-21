/** Default YAML template shown when no cue.yaml file exists yet. */
export const CUE_YAML_TEMPLATE = `# .maestro/cue.yaml
# Define event-driven subscriptions for your agents.
#
# subscriptions:
#   - name: "initialize workspace"
#     event: app.startup
#     prompt: prompts/workspace-init.md
#     enabled: true
#
#   - name: "code review on change"
#     event: file.changed
#     watch: "src/**/*.ts"
#     prompt: prompts/review.md
#     enabled: true
#
#   - name: "hourly security audit"
#     event: time.heartbeat
#     interval_minutes: 60
#     prompt: prompts/security-audit.md
#     enabled: true
#
#   - name: "deploy after tests pass"
#     event: agent.completed
#     source_session: "test-runner"
#     prompt: prompts/deploy.md
#     enabled: true
#
#   - name: "review new PRs"
#     event: github.pull_request
#     poll_minutes: 5
#     # retrigger_on_comments: true   # re-fire when a PR receives new activity
#     # max_notifications: 10         # per-PR cap on re-fires (0 = unlimited)
#     prompt: prompts/pr-review.md    # reference {{CUE_NEW_COMMENTS}} for comment context
#     enabled: true
#
#   - name: "triage issues"
#     event: github.issue
#     poll_minutes: 10
#     # retrigger_on_comments: true   # re-fire when an issue receives new activity
#     # max_notifications: 10         # per-issue cap on re-fires (0 = unlimited)
#     prompt: prompts/issue-triage.md # reference {{CUE_NEW_COMMENTS}} for comment context
#     enabled: true
#
#   - name: "process task queue"
#     event: task.pending
#     watch: "tasks/**/*.md"
#     poll_minutes: 1
#     prompt: prompts/process-task.md
#     enabled: true
#
#   - name: "deploy"
#     event: cli.trigger
#     prompt: "Run the deployment pipeline for the current branch"
#     enabled: true
#
# settings:
#   timeout_minutes: 30
#   timeout_on_fail: break
#   max_concurrent: 1
#   queue_size: 512
`;
