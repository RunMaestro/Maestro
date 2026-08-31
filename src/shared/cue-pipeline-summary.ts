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

import { normalizeWebhookPath, type CueRunResult } from './cue/contracts';
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
		case 'webhook.received':
			// Mirror TriggerConfig: an unset path defaults to a slug of the
			// trigger's label, so the node should show the URL that will
			// actually be served rather than a bare `/cue/`.
			return `/cue/${normalizeWebhookPath(config.webhook_path || data.customLabel || data.label || '')}`;
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

/**
 * The prompt(s) attached to one node, plus a one-line preview.
 *
 * A node can carry more than one prompt: a fan-out trigger has a distinct
 * `fan_out_prompts` entry per target, and an agent fed by several triggers has
 * a distinct prompt per incoming edge. `count` is what tells a reader the
 * preview is one of several rather than the whole story, so never collapse
 * this to a bare string.
 */
export interface CueNodePrompts {
	/** Distinct prompt texts, in edge order, de-duplicated. */
	prompts: string[];
	/** `prompts.length`. 0 when the node has no prompt at all. */
	count: number;
	/**
	 * The first prompt collapsed to a single line (newlines and runs of
	 * whitespace become single spaces) so it can sit in a one-line slot and be
	 * clipped by CSS. Empty when there is no prompt.
	 *
	 * Deliberately NOT truncated to a word count here: the list clips it with
	 * `text-overflow: ellipsis`, which fits exactly as many words as the actual
	 * column width allows. A hard-coded character cap would either waste space
	 * on a wide window or still overflow on a narrow one.
	 */
	preview: string;
}

export interface CuePipelineTriggerSummary {
	/** User-facing trigger name (custom label, else the event-type label). */
	label: string;
	/** Short config summary, e.g. `09:00, 17:00` or `every 15min`. */
	summary: string;
	eventType: CueEventType;
	/** Underlying subscription name. Absent on never-saved pipelines. */
	subscriptionName?: string;
	/** Prompts this trigger sends, taken from its OUTGOING edges. */
	prompts: CueNodePrompts;
}

export interface CuePipelineStepSummary {
	kind: 'agent' | 'command' | 'error';
	/** Display name: agent session name, command name, or error headline. */
	label: string;
	/** Secondary line: command body, or the error's reason. Empty for agents. */
	detail: string;
	/** Bound Maestro agent id, when the step has one. */
	sessionId?: string;
	/**
	 * Prompts this step receives, taken from its INCOMING edges (falling back to
	 * the node's own `inputPrompt` for chain agents). This is frequently the
	 * ONLY thing distinguishing two steps: a fan-out pipeline renders the same
	 * agent name N times, and the prompt is what makes each row a different job.
	 */
	prompts: CueNodePrompts;
}

/** Collapse a prompt to one line: no newlines, no runs of whitespace. */
function collapsePrompt(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

function buildNodePrompts(texts: Array<string | undefined>): CueNodePrompts {
	const prompts: string[] = [];
	for (const text of texts) {
		const trimmed = text?.trim();
		if (!trimmed || prompts.includes(trimmed)) continue;
		prompts.push(trimmed);
	}
	return {
		prompts,
		count: prompts.length,
		preview: prompts.length > 0 ? collapsePrompt(prompts[0]) : '',
	};
}

export interface CuePipelineDescription {
	triggers: CuePipelineTriggerSummary[];
	/** Agents and commands in execution order (BFS distance from a trigger). */
	steps: CuePipelineStepSummary[];
	/** Distinct agent session ids referenced by the pipeline. */
	agentIds: string[];
	/** Nodes the loader could not resolve to a live agent. */
	errorCount: number;
	/**
	 * The COLLAPSED one-liner. A small pipeline gets its literal flow
	 * (`Scheduled (09:00) → rc → Maestro`); a large one gets counts
	 * (`39 triggers (Scheduled, File Change) → 39 agents`).
	 *
	 * The threshold is not cosmetic. A pipeline like "Pedsidian" groups 39
	 * INDEPENDENT trigger→agent chains under one name, so chaining its node
	 * names with arrows produces a 39-arrow line that reads as a sequence and
	 * is simply false. Counts are both shorter and more accurate; the real
	 * structure belongs in the expanded detail.
	 */
	headline: string;
	/** `Scheduled (09:00)` or `39 triggers (Scheduled, File Change)`. */
	triggerHeadline: string;
	/** `27 agents, 12 commands`. */
	stepHeadline: string;
	/**
	 * Full `a → b → c` chain of every step. Useful as a search haystack and for
	 * small pipelines, but do NOT render it unconditionally - see `headline`.
	 */
	flow: string;
}

/** How many trigger kinds to name before the list itself becomes noise. */
const MAX_NAMED_TRIGGER_KINDS = 3;

/** How many steps a flow line can hold before counts read better than arrows. */
const MAX_FLOW_STEPS = 4;

/** `2 agents` / `1 command` / `3 unresolved`, omitting empty categories. */
function countPhrase(counts: Array<[number, string, string]>): string {
	const parts = counts
		.filter(([n]) => n > 0)
		.map(([n, singular, plural]) => `${n} ${n === 1 ? singular : plural}`);
	return parts.join(', ');
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

/**
 * Prompts flowing INTO a node.
 *
 * `edge.prompt` is the single source of truth for trigger→agent edges - the
 * loader deliberately clears `AgentNodeData.inputPrompt` on those, because
 * mirroring the two caused stale saves (see yamlToPipeline). `inputPrompt` is
 * reserved for chain agents, which have no incoming trigger edge, so it is
 * consulted only when no incoming edge carried a prompt.
 */
function incomingPrompts(pipeline: CuePipeline, node: PipelineNode): CueNodePrompts {
	const fromEdges = pipeline.edges.filter((e) => e.target === node.id).map((e) => e.prompt);
	const resolved = buildNodePrompts(fromEdges);
	if (resolved.count > 0) return resolved;
	if (node.type === 'agent') {
		return buildNodePrompts([(node.data as AgentNodeData).inputPrompt]);
	}
	return resolved;
}

/** Prompts a trigger sends, one per outgoing edge (fan-out gives several). */
function outgoingPrompts(pipeline: CuePipeline, nodeId: string): CueNodePrompts {
	return buildNodePrompts(pipeline.edges.filter((e) => e.source === nodeId).map((e) => e.prompt));
}

function stepLabel(node: PipelineNode, prompts: CueNodePrompts): CuePipelineStepSummary {
	if (node.type === 'agent') {
		const data = node.data as AgentNodeData;
		return {
			kind: 'agent',
			label: data.sessionName || 'Unnamed agent',
			detail: '',
			sessionId: data.sessionId,
			prompts,
		};
	}
	if (node.type === 'command') {
		const data = node.data as CommandNodeData;
		return {
			kind: 'command',
			label: data.name || 'Command',
			detail: summarizeCommandNode(data),
			sessionId: data.owningSessionId,
			prompts,
		};
	}
	// Error node: the loader could not resolve this reference to a live agent.
	const data = node.data as { message?: string };
	return { kind: 'error', label: 'Unresolved agent', detail: data.message ?? '', prompts };
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
				prompts: outgoingPrompts(pipeline, node.id),
			};
		});

	const steps = orderStepNodes(pipeline).map((node) =>
		stepLabel(node, incomingPrompts(pipeline, node))
	);
	const agentIds: string[] = [];
	for (const step of steps) {
		if (step.kind === 'agent' && step.sessionId && !agentIds.includes(step.sessionId)) {
			agentIds.push(step.sessionId);
		}
	}

	// Distinct trigger KINDS, in first-seen order - "39 triggers" alone says
	// nothing about what wakes the pipeline up, and 39 labels say too much.
	const kinds: string[] = [];
	for (const t of triggers) {
		const kind = CUE_EVENT_LABELS[t.eventType] || t.label;
		if (!kinds.includes(kind)) kinds.push(kind);
	}
	const namedKinds = kinds.slice(0, MAX_NAMED_TRIGGER_KINDS).join(', ');
	const kindSuffix = kinds.length > MAX_NAMED_TRIGGER_KINDS ? `${namedKinds}, …` : namedKinds;

	const triggerHeadline =
		triggers.length === 0
			? 'No trigger'
			: triggers.length === 1
				? triggers[0].summary
					? `${triggers[0].label} (${triggers[0].summary})`
					: triggers[0].label
				: `${triggers.length} triggers (${kindSuffix})`;

	const errorCount = steps.filter((s) => s.kind === 'error').length;
	const stepHeadline =
		countPhrase([
			[steps.filter((s) => s.kind === 'agent').length, 'agent', 'agents'],
			[steps.filter((s) => s.kind === 'command').length, 'command', 'commands'],
			[errorCount, 'unresolved node', 'unresolved nodes'],
		]) || 'no steps';

	const flow = [triggerHeadline, ...steps.map((s) => s.label)].join(' → ');
	const headline =
		triggers.length <= 1 && steps.length <= MAX_FLOW_STEPS
			? flow
			: `${triggerHeadline} → ${stepHeadline}`;

	return {
		triggers,
		steps,
		agentIds,
		errorCount,
		headline,
		triggerHeadline,
		stepHeadline,
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
