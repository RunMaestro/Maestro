import {
	Zap,
	FileText,
	Radio,
	Code,
	GitBranch,
	Clock,
	Sparkles,
	Layers,
	Moon,
	Filter,
	GitMerge,
} from 'lucide-react';
import type { Theme } from '../types';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { DEFAULT_SHORTCUTS } from '../constants/shortcuts';

interface CueHelpContentProps {
	theme: Theme;
	cueShortcutKeys?: string[];
}

/**
 * Help content for Maestro Cue, used inline within the CueModal.
 */
export function CueHelpContent({ theme, cueShortcutKeys }: CueHelpContentProps) {
	return (
		<div className="space-y-6" style={{ color: theme.colors.textMain }}>
			{/* Section 1: What is Maestro Cue? */}
			<section>
				<div className="flex items-center gap-2 mb-3">
					<Zap className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<h3 className="font-bold">What is Maestro Cue?</h3>
				</div>
				<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
					<p>
						Maestro Cue is an event-driven automation system. Define triggers in a YAML file, and
						Maestro automatically executes prompts against your AI agents when events occur. The
						conductor gives the cue — the agents respond.
					</p>
				</div>
			</section>

			{/* Section 2: Getting Started */}
			<section>
				<div className="flex items-center gap-2 mb-3">
					<FileText className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<h3 className="font-bold">Getting Started</h3>
				</div>
				<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
					<p>
						Use the <strong style={{ color: theme.colors.textMain }}>Pipeline Editor</strong> tab to
						visually build your automation pipelines. Drag triggers from the left drawer and agents
						from the right drawer onto the canvas, then connect them to define your workflow. The
						editor automatically generates and manages the underlying{' '}
						<code className="px-1 rounded" style={{ backgroundColor: theme.colors.bgActivity }}>
							maestro-cue.yaml
						</code>{' '}
						file.
					</p>
					<div
						className="flex items-center gap-2 px-3 py-2 rounded"
						style={{ backgroundColor: theme.colors.accent + '15' }}
					>
						<Sparkles className="w-4 h-4 flex-shrink-0" style={{ color: theme.colors.accent }} />
						<span>
							<strong style={{ color: theme.colors.textMain }}>Note:</strong> Maestro Cue is an
							Encore Feature. Enable it in Settings → Encore tab, then use the master toggle in the
							Cue dashboard to start/stop the engine.
						</span>
					</div>
					<div
						className="font-mono text-xs p-3 rounded border"
						style={{
							backgroundColor: theme.colors.bgActivity,
							borderColor: theme.colors.border,
						}}
					>
						subscriptions:
						<br />
						{'  '}- name: "My First Cue"
						<br />
						{'    '}event: time.interval
						<br />
						{'    '}interval_minutes: 30
						<br />
						{'    '}prompt: prompts/my-task.md
						<br />
						{'    '}enabled: true
					</div>
				</div>
			</section>

			{/* Section 3: Event Types */}
			<section>
				<div className="flex items-center gap-2 mb-3">
					<Radio className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<h3 className="font-bold">Event Types</h3>
				</div>
				<div className="text-sm space-y-3 pl-7" style={{ color: theme.colors.textDim }}>
					<div>
						<p>
							<strong style={{ color: theme.colors.textMain }}>Interval</strong>{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								time.interval
							</code>
						</p>
						<p className="mt-1">
							Runs your prompt on a timer. Set{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								interval_minutes
							</code>{' '}
							to control frequency.
						</p>
					</div>
					<div>
						<p>
							<strong style={{ color: theme.colors.textMain }}>File Watch</strong>{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								file.changed
							</code>
						</p>
						<p className="mt-1">
							Watches for file system changes matching a glob pattern. Set{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								watch
							</code>{' '}
							to a glob like{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								src/**/*.ts
							</code>
							.
						</p>
					</div>
					<div>
						<p>
							<strong style={{ color: theme.colors.textMain }}>Agent Completed</strong>{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								agent.completed
							</code>
						</p>
						<p className="mt-1">
							Triggers when another session finishes a task. Set{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								source_session
							</code>{' '}
							to the session name. Use{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								filter: {'{'} triggeredBy: "sub-name" {'}'}
							</code>{' '}
							to chain from a specific subscription only.
						</p>
					</div>
					<div>
						<p>
							<strong style={{ color: theme.colors.textMain }}>GitHub Pull Request</strong>{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								github.pull_request
							</code>
						</p>
						<p className="mt-1">
							Polls for new pull requests via the GitHub CLI. Optional:{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								repo
							</code>{' '}
							(auto-detected),{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								poll_minutes
							</code>{' '}
							(default 5). Requires{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								gh
							</code>{' '}
							CLI installed and authenticated.
						</p>
					</div>
					<div>
						<p>
							<strong style={{ color: theme.colors.textMain }}>GitHub Issue</strong>{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								github.issue
							</code>
						</p>
						<p className="mt-1">
							Polls for new issues via the GitHub CLI. Optional:{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								repo
							</code>{' '}
							(auto-detected),{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								poll_minutes
							</code>{' '}
							(default 5). Requires{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								gh
							</code>{' '}
							CLI installed and authenticated.
						</p>
					</div>
					<div>
						<p>
							<strong style={{ color: theme.colors.textMain }}>Task Pending</strong>{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								task.pending
							</code>
						</p>
						<p className="mt-1">
							Polls markdown files for unchecked tasks (
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								- [ ]
							</code>
							). Requires{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								watch
							</code>{' '}
							glob pattern. Optional{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								poll_minutes
							</code>{' '}
							(default 1). Fires per file when content changes and pending tasks exist.
						</p>
					</div>
					<div
						className="font-mono text-xs p-3 rounded border space-y-3"
						style={{
							backgroundColor: theme.colors.bgActivity,
							borderColor: theme.colors.border,
						}}
					>
						<div>
							# Interval
							<br />
							- name: "Periodic Check"
							<br />
							{'  '}event: time.interval
							<br />
							{'  '}interval_minutes: 15
						</div>
						<div>
							# File Watch
							<br />
							- name: "On File Change"
							<br />
							{'  '}event: file.changed
							<br />
							{'  '}watch: "src/**/*.ts"
						</div>
						<div>
							# Agent Completed
							<br />
							- name: "Chain Reaction"
							<br />
							{'  '}event: agent.completed
							<br />
							{'  '}source_session: "my-agent"
						</div>
						<div>
							# GitHub PR
							<br />
							- name: "Review PRs"
							<br />
							{'  '}event: github.pull_request
							<br />
							{'  '}poll_minutes: 5
						</div>
						<div>
							# GitHub Issue
							<br />
							- name: "Triage Issues"
							<br />
							{'  '}event: github.issue
							<br />
							{'  '}poll_minutes: 10
						</div>
						<div>
							# Task Pending
							<br />
							- name: "Process Tasks"
							<br />
							{'  '}event: task.pending
							<br />
							{'  '}watch: "tasks/**/*.md"
							<br />
							{'  '}poll_minutes: 1
						</div>
					</div>
				</div>
			</section>

			{/* Section 4: Event Filtering */}
			<section>
				<div className="flex items-center gap-2 mb-3">
					<Filter className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<h3 className="font-bold">Event Filtering</h3>
				</div>
				<div className="text-sm space-y-3 pl-7" style={{ color: theme.colors.textDim }}>
					<p>
						Add a{' '}
						<code
							className="px-1 rounded text-xs"
							style={{ backgroundColor: theme.colors.bgActivity }}
						>
							filter
						</code>{' '}
						block to any subscription to narrow when it fires. All conditions must match (AND
						logic).
					</p>
					<table className="w-full text-xs border-collapse">
						<thead>
							<tr>
								<th
									className="text-left py-1 px-2 border-b"
									style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								>
									Expression
								</th>
								<th
									className="text-left py-1 px-2 border-b"
									style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								>
									Meaning
								</th>
								<th
									className="text-left py-1 px-2 border-b"
									style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								>
									Example
								</th>
							</tr>
						</thead>
						<tbody>
							{[
								['"value"', 'Exact match', 'extension: ".ts"'],
								['"!value"', 'Not equal', 'status: "!archived"'],
								['">N"', 'Greater than', 'size: ">1000"'],
								['"<N"', 'Less than', 'priority: "<5"'],
								['"glob*"', 'Glob pattern', 'path: "src/**/*.ts"'],
								['true/false', 'Boolean', 'active: true'],
								['triggeredBy', 'Source subscription', 'triggeredBy: "build-step"'],
							].map(([expr, meaning, example], i) => (
								<tr key={i}>
									<td
										className="py-1 px-2 border-b font-mono"
										style={{ borderColor: theme.colors.border + '50' }}
									>
										{expr}
									</td>
									<td
										className="py-1 px-2 border-b"
										style={{ borderColor: theme.colors.border + '50' }}
									>
										{meaning}
									</td>
									<td
										className="py-1 px-2 border-b font-mono"
										style={{ borderColor: theme.colors.border + '50' }}
									>
										{example}
									</td>
								</tr>
							))}
						</tbody>
					</table>
					<div
						className="font-mono text-xs p-3 rounded border"
						style={{
							backgroundColor: theme.colors.bgActivity,
							borderColor: theme.colors.border,
						}}
					>
						- name: "TypeScript changes only"
						<br />
						{'  '}event: file.changed
						<br />
						{'  '}watch: "src/**/*"
						<br />
						{'  '}filter:
						<br />
						{'    '}extension: ".ts"
						<br />
						{'    '}path: "!*.test.ts"
						<br />
						{'  '}prompt: prompts/ts-review.md
					</div>
				</div>
			</section>

			{/* Section 5: Template Variables */}
			<section>
				<div className="flex items-center gap-2 mb-3">
					<Code className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<h3 className="font-bold">Template Variables</h3>
				</div>
				<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
					<div
						className="font-mono text-xs p-3 rounded border space-y-1"
						style={{
							backgroundColor: theme.colors.bgActivity,
							borderColor: theme.colors.border,
						}}
					>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_EVENT_TYPE}}'}</code> — Event
							type (time.interval, file.changed, agent.completed, github.pull_request, github.issue,
							task.pending)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_EVENT_TIMESTAMP}}'}</code> —
							Event timestamp
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_TRIGGER_NAME}}'}</code> —
							Trigger/subscription name
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_RUN_ID}}'}</code> — Run UUID
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_FILE_PATH}}'}</code> — Changed
							file path (file.changed)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_FILE_NAME}}'}</code> — Changed
							file name
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_FILE_DIR}}'}</code> — Changed
							file directory
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_FILE_EXT}}'}</code> — Changed
							file extension
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_FILE_CHANGE_TYPE}}'}</code> —
							Change type: add, change, unlink (file.changed)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_SOURCE_SESSION}}'}</code> —
							Source session name (agent.completed)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_SOURCE_OUTPUT}}'}</code> — Source
							session output (agent.completed)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_SOURCE_STATUS}}'}</code> — Source
							run status: completed, failed, timeout (agent.completed)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_SOURCE_EXIT_CODE}}'}</code> —
							Source process exit code (agent.completed)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_SOURCE_DURATION}}'}</code> —
							Source run duration in ms (agent.completed)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_SOURCE_TRIGGERED_BY}}'}</code> —
							Subscription that triggered the source (agent.completed)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_TASK_FILE}}'}</code> — File path
							with pending tasks (task.pending)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_TASK_COUNT}}'}</code> — Number of
							pending tasks (task.pending)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_TASK_LIST}}'}</code> — Formatted
							task list with line numbers (task.pending)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_TASK_CONTENT}}'}</code> — Full
							file content, truncated (task.pending)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_GH_NUMBER}}'}</code> — PR/issue
							number (github.*)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_GH_TITLE}}'}</code> — PR/issue
							title (github.*)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_GH_AUTHOR}}'}</code> — Author
							login (github.*)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_GH_URL}}'}</code> — HTML URL
							(github.*)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_GH_LABELS}}'}</code> — Labels,
							comma-separated (github.*)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_GH_REPO}}'}</code> — Repo
							(owner/repo) (github.*)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_GH_BRANCH}}'}</code> — Head
							branch (github.pull_request)
						</div>
					</div>
					<div
						className="flex items-center gap-2 px-3 py-2 rounded"
						style={{ backgroundColor: theme.colors.accent + '15' }}
					>
						<Code className="w-4 h-4 flex-shrink-0" style={{ color: theme.colors.accent }} />
						<span>
							All standard Maestro template variables (
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								{'{{AGENT_NAME}}'}
							</code>
							,{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								{'{{DATE}}'}
							</code>
							, etc.) are also available in Cue prompts.
						</span>
					</div>
				</div>
			</section>

			{/* Section 5: Multi-Agent Orchestration */}
			<section>
				<div className="flex items-center gap-2 mb-3">
					<GitBranch className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<h3 className="font-bold">Multi-Agent Orchestration</h3>
				</div>
				<div className="text-sm space-y-3 pl-7" style={{ color: theme.colors.textDim }}>
					<div>
						<p>
							<strong style={{ color: theme.colors.textMain }}>Fan-Out:</strong> Trigger multiple
							sessions from a single event. Add{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								fan_out: ["session-1", "session-2"]
							</code>{' '}
							to your subscription.
						</p>
					</div>
					<div>
						<p>
							<strong style={{ color: theme.colors.textMain }}>Fan-In:</strong> Wait for multiple
							sessions to complete before triggering. Set{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								source_session
							</code>{' '}
							to an array:{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								["session-1", "session-2"]
							</code>
							.
						</p>
					</div>
					<div
						className="font-mono text-xs p-3 rounded border"
						style={{
							backgroundColor: theme.colors.bgActivity,
							borderColor: theme.colors.border,
						}}
					>
						{'  '}Event ──┬── Agent A (fan-out)
						<br />
						{'          '}├── Agent B
						<br />
						{'          '}└── Agent C
						<br />
						<br />
						{'  '}Agent A ──┐
						<br />
						{'  '}Agent B ──┼── Event (fan-in)
						<br />
						{'  '}Agent C ──┘
					</div>
				</div>
			</section>

			{/* Section: Coordination Patterns */}
			<section>
				<div className="flex items-center gap-2 mb-3">
					<GitMerge className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<h3 className="font-bold">Coordination Patterns</h3>
				</div>
				<div className="text-sm space-y-4 pl-7" style={{ color: theme.colors.textDim }}>
					<p>Maestro Cue supports several coordination patterns for multi-agent workflows.</p>

					<div>
						<p>
							<strong style={{ color: theme.colors.textMain }}>Scheduled Task</strong> &mdash;
							Single agent running on a timer.
						</p>
						<div
							className="font-mono text-xs p-2 rounded border mt-1"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
							}}
						>
							[Timer] &rarr; [Agent]
						</div>
					</div>

					<div>
						<p>
							<strong style={{ color: theme.colors.textMain }}>File Enrichment</strong> &mdash;
							React to file system changes.
						</p>
						<div
							className="font-mono text-xs p-2 rounded border mt-1"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
							}}
						>
							[File Change] &rarr; [Agent]
						</div>
					</div>

					<div>
						<p>
							<strong style={{ color: theme.colors.textMain }}>Research Swarm</strong> &mdash;
							Fan-out to multiple agents, fan-in to synthesize.
						</p>
						<div
							className="font-mono text-xs p-2 rounded border mt-1"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
							}}
						>
							[Timer] &rarr; [Agent 1, Agent 2, Agent 3] &rarr; [Synthesizer]
						</div>
					</div>

					<div>
						<p>
							<strong style={{ color: theme.colors.textMain }}>Sequential Chain</strong> &mdash;
							Pipeline where each agent triggers the next.
						</p>
						<div
							className="font-mono text-xs p-2 rounded border mt-1"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
							}}
						>
							[Agent A] &rarr; [Agent B] &rarr; [Agent C]
						</div>
					</div>

					<div>
						<p>
							<strong style={{ color: theme.colors.textMain }}>Debate</strong> &mdash; Multiple
							perspectives, then moderator synthesizes.
						</p>
						<div
							className="font-mono text-xs p-2 rounded border mt-1"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
							}}
						>
							[Moderator] &rarr; [Pro, Con] &rarr; [Moderator]
						</div>
					</div>

					<div>
						<p>
							<strong style={{ color: theme.colors.textMain }}>Task Queue</strong> &mdash; Watch
							markdown files for unchecked tasks and process them.
						</p>
						<div
							className="font-mono text-xs p-2 rounded border mt-1"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
							}}
						>
							[tasks/*.md] &rarr; [Agent] (per file with pending tasks)
						</div>
					</div>

					<div
						className="flex items-center gap-2 px-3 py-2 rounded"
						style={{ backgroundColor: theme.colors.accent + '15' }}
					>
						<Sparkles className="w-4 h-4 flex-shrink-0" style={{ color: theme.colors.accent }} />
						<span>
							Use the Pipeline Editor to visually build these patterns by dragging and connecting
							triggers and agents.
						</span>
					</div>
				</div>
			</section>

			{/* Section 6: Timeouts & Failure Handling */}
			<section>
				<div className="flex items-center gap-2 mb-3">
					<Clock className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<h3 className="font-bold">Timeouts & Failure Handling</h3>
				</div>
				<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
					<p>
						Default timeout is 30 minutes. If a run times out, the chain breaks and the failure is
						logged.
					</p>
					<p>
						Set{' '}
						<code
							className="px-1 rounded text-xs"
							style={{ backgroundColor: theme.colors.bgActivity }}
						>
							timeout_on_fail: continue
						</code>{' '}
						in settings to skip failed sources and proceed anyway.
					</p>
					<div
						className="font-mono text-xs p-3 rounded border"
						style={{
							backgroundColor: theme.colors.bgActivity,
							borderColor: theme.colors.border,
						}}
					>
						settings:
						<br />
						{'  '}timeout_minutes: 60
						<br />
						{'  '}timeout_on_fail: continue
					</div>
				</div>
			</section>

			{/* Section 7: Concurrency Control */}
			<section>
				<div className="flex items-center gap-2 mb-3">
					<Layers className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<h3 className="font-bold">Concurrency Control</h3>
				</div>
				<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
					<p>
						By default, each session runs one Cue task at a time. Additional events are queued (up
						to 10) and processed as slots free.
					</p>
					<p>Stale queued events (older than the timeout) are automatically dropped.</p>
					<div
						className="font-mono text-xs p-3 rounded border"
						style={{
							backgroundColor: theme.colors.bgActivity,
							borderColor: theme.colors.border,
						}}
					>
						settings:
						<br />
						{'  '}max_concurrent: 3{'    '}# Up to 3 parallel runs
						<br />
						{'  '}queue_size: 20{'       '}# Queue up to 20 events
						<br />
						{'  '}timeout_minutes: 30
					</div>
				</div>
			</section>

			{/* Section 8: Sleep & Recovery */}
			<section>
				<div className="flex items-center gap-2 mb-3">
					<Moon className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<h3 className="font-bold">Sleep & Recovery</h3>
				</div>
				<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
					<p>
						Maestro Cue automatically detects when your computer sleeps and catches up on missed
						time-based triggers when it wakes. File watchers re-initialize automatically.
					</p>
					<p>
						Catch-up events are marked with a{' '}
						<span
							className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold"
							style={{ backgroundColor: '#f59e0b20', color: '#f59e0b' }}
						>
							catch-up
						</span>{' '}
						badge in the activity log so you can distinguish them from regular triggers.
					</p>
				</div>
			</section>

			{/* Section 9: Visual Pipeline Editor */}
			<section>
				<div className="flex items-center gap-2 mb-3">
					<Sparkles className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<h3 className="font-bold">Visual Pipeline Editor</h3>
				</div>
				<div className="text-sm space-y-2 pl-7" style={{ color: theme.colors.textDim }}>
					<p>
						The Pipeline Editor provides a visual canvas for building automation workflows. Drag
						triggers and agents onto the canvas, connect them with edges, and organize them into
						named pipelines with distinct colors.
					</p>
					<p>
						<strong style={{ color: theme.colors.textMain }}>Left drawer:</strong> Trigger types
						(interval, file watch, agent completed, GitHub, task pending)
						<br />
						<strong style={{ color: theme.colors.textMain }}>Right drawer:</strong> Available agents
						from your sessions
						<br />
						<strong style={{ color: theme.colors.textMain }}>Pipeline selector:</strong> Create,
						rename, and switch between pipelines
					</p>
					<div
						className="flex items-center gap-2 px-3 py-2 rounded"
						style={{ backgroundColor: theme.colors.accent + '15' }}
					>
						<Sparkles className="w-4 h-4 flex-shrink-0" style={{ color: theme.colors.accent }} />
						<span>
							<strong style={{ color: theme.colors.textMain }}>Tip:</strong> Press{' '}
							<kbd
								className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold"
								style={{
									backgroundColor: theme.colors.bgActivity,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								{formatShortcutKeys(cueShortcutKeys ?? DEFAULT_SHORTCUTS.maestroCue.keys)}
							</kbd>{' '}
							to open the Cue dashboard. The Pipeline Editor is the default tab.
						</span>
					</div>
				</div>
			</section>
		</div>
	);
}
