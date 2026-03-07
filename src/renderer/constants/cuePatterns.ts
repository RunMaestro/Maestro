export interface CuePattern {
	id: string;
	name: string;
	description: string;
	explanation: string;
	yaml: string;
}

export const CUE_PATTERNS: CuePattern[] = [
	{
		id: 'scheduled-task',
		name: 'Scheduled Task',
		description: 'Single agent on a timer',
		explanation:
			'Runs a prompt on a fixed interval (e.g. every 60 minutes). Great for periodic maintenance, status checks, or recurring reports. Adjust interval_minutes and point prompt to your markdown file.',
		yaml: `subscriptions:
  - name: "Scheduled Task"
    event: time.interval
    interval_minutes: 60
    prompt: prompts/scheduled-task.md
    enabled: true
`,
	},
	{
		id: 'file-enrichment',
		name: 'File Enrichment',
		description: 'React to file changes',
		explanation:
			'Triggers whenever files matching the watch glob are created or modified. Use for auto-generating docs, running linters, updating tests, or enriching files with metadata. Adjust the watch pattern to target specific directories or file types.',
		yaml: `subscriptions:
  - name: "File Enrichment"
    event: file.changed
    watch: "src/**/*"
    prompt: prompts/enrich.md
    enabled: true
`,
	},
	{
		id: 'reactive',
		name: 'Reactive',
		description: 'Trigger on agent completion',
		explanation:
			'Fires when a specific agent session finishes its work. Use to chain agents — e.g. run tests after code generation, or deploy after tests pass. Set source_session to the name of the agent you want to react to.',
		yaml: `subscriptions:
  - name: "React to Completion"
    event: agent.completed
    source_session: "trigger-session"
    prompt: prompts/react.md
    enabled: true
`,
	},
	{
		id: 'research-swarm',
		name: 'Research Swarm',
		description: 'Fan-out to multiple agents, fan-in to synthesize',
		explanation:
			'Sends the same prompt to multiple agents in parallel (fan-out), then waits for all to finish before running a synthesis prompt (fan-in). Perfect for research, competitive analysis, or getting diverse perspectives on a problem.',
		yaml: `# Orchestrator session: fans out research, then synthesizes
subscriptions:
  - name: "Fan-out Research"
    event: time.interval
    interval_minutes: 1440  # Daily
    prompt: prompts/research-question.md
    fan_out:
      - "researcher-1"
      - "researcher-2"
      - "researcher-3"
    enabled: true

  - name: "Synthesize Results"
    event: agent.completed
    source_session:
      - "researcher-1"
      - "researcher-2"
      - "researcher-3"
    prompt: prompts/synthesize.md
    enabled: true
`,
	},
	{
		id: 'sequential-chain',
		name: 'Sequential Chain',
		description: 'Agent A \u2192 Agent B \u2192 Agent C pipeline',
		explanation:
			'Creates a multi-step pipeline where each agent triggers the next via agent.completed events. The first session starts on a timer; subsequent sessions each listen for the previous one to finish. Each session needs its own cue.yaml — commented sections show what goes where.',
		yaml: `# Session A config:
subscriptions:
  - name: "Step 1"
    event: time.interval
    interval_minutes: 120
    prompt: prompts/step-1.md
    enabled: true

# Session B config (separate .maestro/cue.yaml):
# subscriptions:
#   - name: "Step 2"
#     event: agent.completed
#     source_session: "session-a"
#     prompt: prompts/step-2.md

# Session C config (separate .maestro/cue.yaml):
# subscriptions:
#   - name: "Step 3"
#     event: agent.completed
#     source_session: "session-b"
#     prompt: prompts/step-3.md
`,
	},
	{
		id: 'debate',
		name: 'Debate',
		description: 'Two agents take turns, moderator synthesizes',
		explanation:
			'Fans out a topic to two opposing agents (pro/con), then synthesizes their arguments once both finish. Use for decision-making, design reviews, or any scenario where you want contrasting perspectives before reaching a conclusion.',
		yaml: `# Moderator session: kicks off debate, synthesizes at end
subscriptions:
  - name: "Start Debate"
    event: time.interval
    interval_minutes: 1440
    prompt: prompts/debate-topic.md
    fan_out:
      - "debater-pro"
      - "debater-con"
    enabled: true

  - name: "Synthesize Debate"
    event: agent.completed
    source_session:
      - "debater-pro"
      - "debater-con"
    prompt: prompts/debate-synthesis.md
    enabled: true
`,
	},
	{
		id: 'pr-review',
		name: 'PR Review',
		description: 'Auto-review new GitHub pull requests',
		explanation:
			'Polls GitHub for new pull requests at a configurable interval. Filters let you skip drafts, bot PRs, or target specific labels. The repo is auto-detected from your git remote, or you can set it explicitly.',
		yaml: `subscriptions:
  - name: "Review New PRs"
    event: github.pull_request
    # repo: "owner/repo"  # optional — auto-detected from git remote
    poll_minutes: 5
    prompt: prompts/pr-review.md
    filter:
      author: "!dependabot[bot]"
      draft: false
    enabled: true
`,
	},
	{
		id: 'issue-triage',
		name: 'Issue Triage',
		description: 'Auto-triage new GitHub issues',
		explanation:
			'Polls GitHub for new issues and runs a triage prompt against each one. Useful for auto-labeling, prioritizing, assigning, or responding to incoming issues. Add filters to narrow by label, author, or other fields.',
		yaml: `subscriptions:
  - name: "Triage New Issues"
    event: github.issue
    # repo: "owner/repo"  # optional — auto-detected from git remote
    poll_minutes: 10
    prompt: prompts/issue-triage.md
    enabled: true
`,
	},
	{
		id: 'task-queue',
		name: 'Task Queue',
		description: 'Process pending markdown tasks from a directory',
		explanation:
			'Watches markdown files for unchecked task items (- [ ]) and processes them one at a time. Template variables like {{CUE_TASK_FILE}} and {{CUE_TASK_LIST}} are available in your prompt so the agent knows exactly what to work on.',
		yaml: `subscriptions:
  - name: "Process Task Queue"
    event: task.pending
    watch: "tasks/**/*.md"
    poll_minutes: 1
    prompt: prompts/process-task.md
    enabled: true

# Template variables available in your prompt:
#   {{CUE_TASK_FILE}}      — Full path to the file with pending tasks
#   {{CUE_TASK_FILE_NAME}} — File name (e.g., "sprint-tasks.md")
#   {{CUE_TASK_COUNT}}     — Number of unchecked tasks found
#   {{CUE_TASK_LIST}}      — Formatted list of pending tasks with line numbers
#   {{CUE_TASK_CONTENT}}   — Full file content (truncated to 10K chars)
`,
	},
];
