export interface CuePattern {
	id: string;
	name: string;
	description: string;
	yaml: string;
}

export const CUE_PATTERNS: CuePattern[] = [
	{
		id: 'scheduled-task',
		name: 'Scheduled Task',
		description: 'Single agent on a timer',
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
		yaml: `# Session A config:
subscriptions:
  - name: "Step 1"
    event: time.interval
    interval_minutes: 120
    prompt: prompts/step-1.md
    enabled: true

# Session B config (separate maestro-cue.yaml):
# subscriptions:
#   - name: "Step 2"
#     event: agent.completed
#     source_session: "session-a"
#     prompt: prompts/step-2.md

# Session C config (separate maestro-cue.yaml):
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
];
