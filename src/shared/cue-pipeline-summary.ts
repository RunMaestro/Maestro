/**
 * Human-readable descriptions and health verdicts for Cue pipelines.
 *
 * The pipeline GRAPH answers "how is this wired?" by drawing it. The pipeline
 * LIST answers "what does this do, and is it working?" in prose, and this
 * module is where both of those sentences are built. Pure and runtime-agnostic
 * (no React, no IPC), so the renderer list view, a future `maestro-cli cue
 * list`, and tests all describe a pipeline identically.
 *
 * Two entry points:
 *   - `describePipeline(pipeline)`  → what it does (triggers, flow, steps)
 *   - `derivePipelineHealth(...)`   → whether it is working (status + detail)
 */

import type { CueRunResult } from './cue/contracts';
import { parseSubscriptionName, CUE_EVENT_LABELS } from './cue/cue-summary';
import type {
	AgentNodeData,
	CommandNodeData,
	CuePipeline,
	CueEventType,
	PipelineNode,
	TriggerNodeData,
} from './cue-pipeline-types';

// ─── Node summaries ──────────────────────────────────────────────────────────

/** Returns a short human-readable summary of a trigger's configuration. */
export function getTriggerConfigSummary(data: TriggerNodeData): string {
	const { eventType, config } = data;
	switch (eventType) {
		case 'time.heartbeat':
			return config.interval_minutes ? `every ${config.interval_minutes}min` : 'heartbeat';
		case 'time.scheduled': {
			const times = config.schedule_times ?? [];
			const days = config.schedule_days ?? [];
			if (times.length === 0) return 'scheduled';
			const timeStr = times.length <= 2 ? times.join(', ') : `${times.length} times`;
			const dayStr = days.length > 0 && days.length < 7 ? ` (${days.join(', ')})` : '';
			return `${timeStr}${dayStr}`;
		}
		case 'file.changed':
			return config.watch ?? '**/*';
		case 'github.pull_request':
		case 'github.issue':
			return config.repo ?? 'repo';
		case 'task.pending':
			return config.watch ?? 'tasks';
		case 'agent.completed':
			return 'agent done';
		case 'cli.trigger':
			return 'cli';
		default:
			return '';
	}
}

/** Build the one-line summary shown under a command node's name. */
export function summarizeCommandNode(data: CommandNodeData): string {
	if (data.mode === 'shell') {
		const text = data.shell?.trim() ?? '';
		if (!text) return '(no command)';
		const firstLine = text.split('\n')[0];
		return '$ ' + (firstLine.length > 36 ? firstLine.slice(0, 33) + '…' : firstLine);
	}
	const target = data.cliTarget?.trim() || '(no target)';
	return `cli send → ${target}`;
}

// ─── Pipeline description ────────────────────────────────────────────────────

export interface CuePipelineTriggerSummary {
	/** User-facing trigger name (custom label, else the event-type label). */
	label: string;
	/** Short config summary, e.g. `09:00, 17:00` or `every 15min`. */
	summary: string;
	eventType: CueEventType;
	/** Underlying subscription name. Absent on never-saved pipelines. */
	subscriptionName?: string;
}

export interface CuePipelineStepSummary {
	kind: 'agent' | 'command' | 'error';
	/** Display name: agent session name, command name, or error headline. */
	label: string;
	/** Secondary line: command body, or the error's reason. Empty for agents. */
	detail: string;
	/** Bound Maestro agent id, when the step has one. */
	sessionId?: string;
}

export interface CuePipelineDescription {
	triggers: CuePipelineTriggerSummary[];
	/** Agents and commands in execution order (BFS distance from a trigger). */
	steps: CuePipelineStepSummary[];
	/** Distinct agent session ids referenced by the pipeline. */
	agentIds: string[];
	/** Nodes the loader could not resolve to a live agent. */
	errorCount: number;
	/** One-line `Scheduled 09:00 → rc → Maestro` flow sentence. */
	flow: string;
}

/**
 * Order the non-trigger nodes by their distance from the nearest trigger, so
 * a prose description reads in the same direction the graph is drawn. Nodes
 * unreachable from any trigger (orphans) sort last, keeping them visible in
 * the list rather than silently dropped.
 *
 * Deliberately separate from `computeNodeRanks` in pipelineAutoArrange: that
 * one produces column indices for canvas geometry (and is tuned for spacing),
 * whereas this only needs a stable reading order.
 */
function orderStepNodes(pipeline: CuePipeline): PipelineNode[] {
	const depth = new Map<string, number>();
	const outgoing = new Map<string, string[]>();
	for (const edge of pipeline.edges) {
		const list = outgoing.get(edge.source);
		if (list) list.push(edge.target);
		else outgoing.set(edge.source, [edge.target]);
	}

	const queue: string[] = [];
	for (const node of pipeline.nodes) {
		if (node.type !== 'trigger') continue;
		depth.set(node.id, 0);
		queue.push(node.id);
	}
	while (queue.length > 0) {
		const id = queue.shift()!;
		const next = depth.get(id)! + 1;
		for (const targetId of outgoing.get(id) ?? []) {
			if (depth.has(targetId)) continue;
			depth.set(targetId, next);
			queue.push(targetId);
		}
	}

	const steps = pipeline.nodes.filter((n) => n.type !== 'trigger');
	return steps
		.map((node, index) => ({ node, index, depth: depth.get(node.id) ?? Number.MAX_SAFE_INTEGER }))
		.sort((a, b) => a.depth - b.depth || a.index - b.index)
		.map((entry) => entry.node);
}

function stepLabel(node: PipelineNode): CuePipelineStepSummary {
	if (node.type === 'agent') {
		const data = node.data as AgentNodeData;
		return {
			kind: 'agent',
			label: data.sessionName || 'Unnamed agent',
			detail: '',
			sessionId: data.sessionId,
		};
	}
	if (node.type === 'command') {
		const data = node.data as CommandNodeData;
		return {
			kind: 'command',
			label: data.name || 'Command',
			detail: summarizeCommandNode(data),
			sessionId: data.owningSessionId,
		};
	}
	// Error node: the loader could not resolve this reference to a live agent.
	const data = node.data as { message?: string };
	return { kind: 'error', label: 'Unresolved agent', detail: data.message ?? '' };
}

/** Describe what a pipeline does: its triggers, its steps, and a flow line. */
export function describePipeline(pipeline: CuePipeline): CuePipelineDescription {
	const triggers: CuePipelineTriggerSummary[] = pipeline.nodes
		.filter((n) => n.type === 'trigger')
		.map((node) => {
			const data = node.data as TriggerNodeData;
			return {
				label: data.customLabel || CUE_EVENT_LABELS[data.eventType] || data.label,
				summary: getTriggerConfigSummary(data),
				eventType: data.eventType,
				subscriptionName: data.subscriptionName,
			};
		});

	const steps = orderStepNodes(pipeline).map(stepLabel);
	const agentIds: string[] = [];
	for (const step of steps) {
		if (step.kind === 'agent' && step.sessionId && !agentIds.includes(step.sessionId)) {
			agentIds.push(step.sessionId);
		}
	}

	const head =
		triggers.length === 0
			? 'No trigger'
			: triggers.length === 1
				? triggers[0].summary
					? `${triggers[0].label} (${triggers[0].summary})`
					: triggers[0].label
				: `${triggers.length} triggers`;
	const flow = [head, ...steps.map((s) => s.label)].join(' → ');

	return {
		triggers,
		steps,
		agentIds,
		errorCount: steps.filter((s) => s.kind === 'error').length,
		flow,
	};
}

// ─── Pipeline health ─────────────────────────────────────────────────────────

/**
 * Health verdict for one pipeline, in precedence order:
 *   `running`  - a run is in flight right now
 *   `invalid`  - config is broken (validation errors, unresolved agents)
 *   `disabled` - every backing subscription is switched off in cue.yaml
 *   `failing`  - the most recent finished run failed, timed out, or was stopped
 *   `healthy`  - the most recent finished run completed
 *   `idle`     - nothing in the recent activity window
 */
export type CuePipelineHealthStatus =
	| 'running'
	| 'invalid'
	| 'disabled'
	| 'failing'
	| 'healthy'
	| 'idle';

export interface CuePipelineHealth {
	status: CuePipelineHealthStatus;
	/** Short badge text, e.g. `Failing`. */
	label: string;
	/** One-line explanation of why the pipeline is in this state. */
	detail: string;
	/** Config problems worth showing verbatim (validation errors). */
	issues: string[];
	/** Runs currently in flight for this pipeline. */
	activeRunCount: number;
	/** Most recent finished run for this pipeline, if the window holds one. */
	lastRun?: CueRunResult;
	/** Finished runs for this pipeline inside the supplied activity window. */
	recentRunCount: number;
	/** How many of those did not complete successfully. */
	recentFailureCount: number;
}

export interface CuePipelineHealthContext {
	/** Runs currently in flight (all pipelines). */
	activeRuns: CueRunResult[];
	/** Recent finished runs (all pipelines). Typically the last 100. */
	activityLog: CueRunResult[];
	/** Validation errors for THIS pipeline, prefix already stripped. */
	configErrors?: string[];
	/** True when every subscription backing this pipeline is disabled on disk. */
	disabled?: boolean;
}

/** True when a run belongs to the named pipeline. */
function runBelongsToPipeline(run: CueRunResult, pipelineName: string): boolean {
	if (run.pipelineName) return run.pipelineName === pipelineName;
	return parseSubscriptionName(run.subscriptionName).base === pipelineName;
}

/** A run that reached a terminal state - `stopped` counts as "did not finish". */
function isFailure(run: CueRunResult): boolean {
	return run.status === 'failed' || run.status === 'timeout' || run.status === 'stopped';
}

export function derivePipelineHealth(
	pipeline: CuePipeline,
	ctx: CuePipelineHealthContext
): CuePipelineHealth {
	const configErrors = ctx.configErrors ?? [];
	const description = describePipeline(pipeline);
	const issues = [...configErrors];
	if (description.errorCount > 0) {
		issues.push(
			`${description.errorCount} node${description.errorCount === 1 ? '' : 's'} reference an agent that no longer exists`
		);
	}

	const activeRunCount = ctx.activeRuns.filter((r) =>
		runBelongsToPipeline(r, pipeline.name)
	).length;

	// The activity log arrives newest-first from the engine, but sort defensively
	// so a re-ordered or merged feed can't make "last run" mean "oldest run".
	const finished = ctx.activityLog
		.filter((r) => r.status !== 'running' && runBelongsToPipeline(r, pipeline.name))
		.sort((a, b) => new Date(b.endedAt).getTime() - new Date(a.endedAt).getTime());
	const lastRun = finished[0];
	const recentFailureCount = finished.filter(isFailure).length;

	const base = {
		issues,
		activeRunCount,
		lastRun,
		recentRunCount: finished.length,
		recentFailureCount,
	};

	if (activeRunCount > 0) {
		return {
			...base,
			status: 'running',
			label: 'Running',
			detail: `${activeRunCount} run${activeRunCount === 1 ? '' : 's'} in flight`,
		};
	}
	if (issues.length > 0) {
		return {
			...base,
			status: 'invalid',
			label: 'Needs attention',
			// A count, not `issues[0]` - callers render `issues` verbatim right
			// underneath, and repeating the first one reads as a stutter.
			detail: `${issues.length} config problem${issues.length === 1 ? '' : 's'}`,
		};
	}
	if (ctx.disabled) {
		return {
			...base,
			status: 'disabled',
			label: 'Disabled',
			detail: 'Every trigger for this pipeline is switched off in cue.yaml',
		};
	}
	if (lastRun && isFailure(lastRun)) {
		const verb =
			lastRun.status === 'timeout'
				? 'timed out'
				: lastRun.status === 'stopped'
					? 'was stopped'
					: 'failed';
		return {
			...base,
			status: 'failing',
			label: 'Failing',
			detail: `Last run ${verb}${lastRun.exitCode != null ? ` (exit ${lastRun.exitCode})` : ''}`,
		};
	}
	if (lastRun) {
		return {
			...base,
			status: 'healthy',
			label: 'Healthy',
			detail:
				recentFailureCount > 0
					? `Last run succeeded, ${recentFailureCount} of the last ${finished.length} failed`
					: `Last ${finished.length} run${finished.length === 1 ? '' : 's'} succeeded`,
		};
	}
	return {
		...base,
		status: 'idle',
		label: 'No recent runs',
		// Deliberately not "never run": the activity log is a bounded window, so
		// an old-but-successful pipeline would be libelled by a stronger claim.
		detail: 'Nothing in the recent activity window',
	};
}

/**
 * Strip the `"<pipeline name>": ` prefix that `validatePipelines` puts on every
 * message, so a per-pipeline list row doesn't repeat the name it already shows
 * in its own heading.
 */
export function stripPipelinePrefix(error: string, pipelineName: string): string {
	const prefix = `"${pipelineName}": `;
	return error.startsWith(prefix) ? error.slice(prefix.length) : error;
}
