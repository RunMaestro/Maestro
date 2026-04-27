import {
	Zap,
	FileText,
	Radio,
	Code,
	Clock,
	Sparkles,
	Layers,
	Moon,
	Filter,
	GitMerge,
	ExternalLink,
} from 'lucide-react';
import type { Theme } from '../types';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { DEFAULT_SHORTCUTS } from '../constants/shortcuts';
import { openUrl } from '../utils/openUrl';
import { buildMaestroUrl } from '../utils/buildMaestroUrl';

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
							.maestro/cue.yaml
						</code>{' '}
						file.
					</p>
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
						{'    '}event: time.heartbeat
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
							<strong style={{ color: theme.colors.textMain }}>Startup</strong>{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								app.startup
							</code>
						</p>
						<p className="mt-1">
							Fires once when the Maestro application starts. No additional fields required. Does
							not re-fire on YAML hot-reload or when toggling Cue on/off.
						</p>
					</div>
					<div>
						<p>
							<strong style={{ color: theme.colors.textMain }}>Heartbeat</strong>{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								time.heartbeat
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
							<strong style={{ color: theme.colors.textMain }}>Scheduled</strong>{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								time.scheduled
							</code>
						</p>
						<p className="mt-1">
							Runs at specific times and days of the week. Set{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								schedule_times
							</code>{' '}
							to an array of HH:MM times. Optionally set{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								schedule_days
							</code>{' '}
							to limit to specific days (mon, tue, wed, thu, fri, sat, sun).
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
					<div>
						<p>
							<strong style={{ color: theme.colors.textMain }}>CLI Trigger</strong>{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								cli.trigger
							</code>
						</p>
						<p className="mt-1">
							Fires when invoked externally via{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								maestro-cli cue trigger &lt;name&gt;
							</code>
							. Useful for hooking Cue into shell scripts, Git hooks, or other automation. The
							optional{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								--prompt
							</code>{' '}
							and{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								--source-agent-id
							</code>{' '}
							flags are exposed as{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								{'{{CUE_CLI_PROMPT}}'}
							</code>{' '}
							and{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								{'{{CUE_SOURCE_AGENT_ID}}'}
							</code>
							.
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
							# Startup
							<br />
							- name: "Init Workspace"
							<br />
							{'  '}event: app.startup
							<br />
							{'  '}prompt: prompts/init.md
						</div>
						<div>
							# Interval
							<br />
							- name: "Periodic Check"
							<br />
							{'  '}event: time.heartbeat
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
						<div>
							# CLI Trigger
							<br />
							- name: "Manual Run"
							<br />
							{'  '}event: cli.trigger
							<br />
							{'  '}prompt: prompts/manual.md
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
							type (app.startup, time.heartbeat, time.scheduled, file.changed, agent.completed,
							github.pull_request, github.issue, task.pending, cli.trigger)
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
							<code style={{ color: theme.colors.accent }}>{'{{CUE_FROM_AGENT}}'}</code> —
							Triggering upstream agent ID — sourceSessionId (agent.completed) or sourceAgentId
							(cli.trigger)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_TASK_FILE}}'}</code> — File path
							with pending tasks (task.pending)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_TASK_FILE_NAME}}'}</code> — File
							name with pending tasks (task.pending)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_TASK_FILE_DIR}}'}</code> —
							Directory of file with pending tasks (task.pending)
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
							<code style={{ color: theme.colors.accent }}>{'{{CUE_GH_TYPE}}'}</code> — GitHub item
							type: "pull_request" or "issue" (github.*)
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
							<code style={{ color: theme.colors.accent }}>{'{{CUE_GH_BODY}}'}</code> — PR/issue
							body, truncated (github.*)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_GH_LABELS}}'}</code> — Labels,
							comma-separated (github.*)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_GH_STATE}}'}</code> — State:
							"open" or "closed" (github.*)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_GH_REPO}}'}</code> — Repo
							(owner/repo) (github.*)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_GH_BRANCH}}'}</code> — Head
							branch (github.pull_request)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_GH_BASE_BRANCH}}'}</code> — Base
							branch (github.pull_request)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_GH_ASSIGNEES}}'}</code> —
							Comma-separated assignees (github.issue)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_CLI_PROMPT}}'}</code> — Prompt
							text passed via{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								--prompt
							</code>{' '}
							flag (cli.trigger)
						</div>
						<div>
							<code style={{ color: theme.colors.accent }}>{'{{CUE_SOURCE_AGENT_ID}}'}</code> —
							Source agent ID passed via{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								--source-agent-id
							</code>{' '}
							(cli.trigger)
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

			{/* Section: Coordination Patterns */}
			<section>
				<div className="flex items-center gap-2 mb-3">
					<GitMerge className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<h3 className="font-bold">Coordination Patterns</h3>
				</div>
				<div className="text-sm space-y-4 pl-7" style={{ color: theme.colors.textDim }}>
					<p>
						Multi-subscription patterns for orchestrating agents. Any trigger (heartbeat, file
						watch, schedule, startup) can serve as the entry point.
					</p>

					<div>
						<p>
							<strong style={{ color: theme.colors.textMain }}>Sequential Pipeline</strong> &mdash;
							Each agent triggers the next via{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								agent.completed
							</code>
							. Use{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								source_sub
							</code>{' '}
							to ensure each step only fires on the intended upstream subscription.
						</p>
						<div
							className="font-mono text-xs p-2 rounded border mt-1"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
							}}
						>
							[Trigger] &rarr; [Agent A] &rarr; [Agent B] &rarr; [Agent C]
						</div>
					</div>

					<div>
						<p>
							<strong style={{ color: theme.colors.textMain }}>Fan-Out</strong> &mdash; Dispatch a
							single event to multiple agents in parallel using{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								fan_out
							</code>
							.
						</p>
						<div
							className="font-mono text-xs p-2 rounded border mt-1"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
							}}
						>
							{'          '}┌&rarr; [Agent A]
							<br />
							[Trigger] ──┼&rarr; [Agent B]
							<br />
							{'          '}└&rarr; [Agent C]
						</div>
					</div>

					<div>
						<p>
							<strong style={{ color: theme.colors.textMain }}>Fan-In (Gather)</strong> &mdash; Wait
							for multiple agents to complete before triggering a synthesizer. Set{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								source_session
							</code>{' '}
							to an array of session names.
						</p>
						<div
							className="font-mono text-xs p-2 rounded border mt-1"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
							}}
						>
							[Agent A] ─┐
							<br />
							[Agent B] ─┼─&rarr; [Synthesizer]
							<br />
							[Agent C] ─┘
						</div>
					</div>

					<div>
						<p>
							<strong style={{ color: theme.colors.textMain }}>Swarm (Fan-Out + Fan-In)</strong>{' '}
							&mdash; Dispatch parallel workers then gather all results into a synthesizer.
						</p>
						<div
							className="font-mono text-xs p-2 rounded border mt-1"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
							}}
						>
							{'            '}┌&rarr; [Worker A] ─┐
							<br />
							[Trigger] ───┼&rarr; [Worker B] ─┼─&rarr; [Synthesizer]
							<br />
							{'            '}└&rarr; [Worker C] ─┘
						</div>
					</div>

					<div>
						<p>
							<strong style={{ color: theme.colors.textMain }}>Command Action</strong> &mdash; Run a
							shell command or relay output to another session via CLI instead of an AI prompt. Set{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								action: command
							</code>
							.
						</p>
						<div
							className="font-mono text-xs p-2 rounded border mt-1"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
							}}
						>
							[Trigger] &rarr; [action: command, mode: shell &rarr; "npm test"]
							<br />
							[Agent A] &rarr; [action: command, mode: cli &rarr; send to Agent B]
						</div>
					</div>

					<div>
						<p>
							<strong style={{ color: theme.colors.textMain }}>Task Queue</strong> &mdash; Watch
							markdown files for unchecked tasks and process them automatically via{' '}
							<code
								className="px-1 rounded text-xs"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								task.pending
							</code>
							.
						</p>
						<div
							className="font-mono text-xs p-2 rounded border mt-1"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
							}}
						>
							[tasks/*.md has ─[ ]] &rarr; [Agent] (fires per file)
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
								{formatShortcutKeys(cueShortcutKeys ?? DEFAULT_SHORTCUTS.openCue.keys)}
							</kbd>{' '}
							to open the Cue dashboard. The Pipeline Editor is the default tab.
						</span>
					</div>
				</div>
			</section>

			{/* Read more link */}
			<div
				className="mt-4 pt-3 border-t flex items-center gap-1.5"
				style={{ borderColor: theme.colors.border }}
			>
				<ExternalLink className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
				<button
					onClick={() => openUrl(buildMaestroUrl('https://docs.runmaestro.ai/maestro-cue'))}
					className="text-xs hover:opacity-80 transition-colors"
					style={{ color: theme.colors.accent }}
				>
					Read more at docs.runmaestro.ai/maestro-cue
				</button>
			</div>
		</div>
	);
}
