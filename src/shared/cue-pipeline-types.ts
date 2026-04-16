/**
 * Type definitions for the visual pipeline editor.
 *
 * Pipelines are named chains: trigger -> agent1 -> agent2 -> ...
 * with fan-out/fan-in support. Each pipeline has a unique color
 * for visual differentiation on the React Flow canvas.
 */

import type { CueEventType, CueGraphSession as SharedCueGraphSession } from './cue';
export type { CueEventType } from './cue';

/** Cue brand color — single source of truth for all Cue UI */
export const CUE_COLOR = '#06b6d4';

/** 12 visually distinct colors suitable for dark backgrounds */
export const PIPELINE_COLORS: string[] = [
	'#06b6d4', // cyan
	'#8b5cf6', // violet
	'#f59e0b', // amber
	'#ef4444', // red
	'#22c55e', // green
	'#ec4899', // pink
	'#3b82f6', // blue
	'#f97316', // orange
	'#14b8a6', // teal
	'#a855f7', // purple
	'#eab308', // yellow
	'#6366f1', // indigo
];

export type EdgeMode = 'pass' | 'debate' | 'autorun';

export interface DebateConfig {
	maxRounds: number;
	timeoutPerRound: number;
}

export interface PipelineNodePosition {
	x: number;
	y: number;
}

export interface TriggerNodeData {
	eventType: CueEventType;
	label: string;
	/** User-defined label overriding the default event-type label (e.g. "Morning Check") */
	customLabel?: string;
	config: {
		interval_minutes?: number;
		schedule_times?: string[];
		schedule_days?: string[];
		watch?: string;
		repo?: string;
		poll_minutes?: number;
		filter?: Record<string, string | number | boolean>;
	};
}

export interface AgentNodeData {
	sessionId: string;
	sessionName: string;
	toolType: string;
	inputPrompt?: string;
	outputPrompt?: string;
	/** Whether to auto-include {{CUE_SOURCE_OUTPUT}} in generated chain prompts. Default: true. */
	includeUpstreamOutput?: boolean;
	/** Per-node fan-in timeout override (minutes). Used when this agent has multiple incoming agent edges. */
	fanInTimeoutMinutes?: number;
	/** Per-node fan-in timeout-on-fail override. 'break' waits for all, 'continue' fires with partial data. */
	fanInTimeoutOnFail?: 'break' | 'continue';
}

export type PipelineNodeType = 'trigger' | 'agent';

export interface PipelineNode {
	id: string;
	type: PipelineNodeType;
	position: PipelineNodePosition;
	data: TriggerNodeData | AgentNodeData;
}

export interface PipelineEdge {
	id: string;
	source: string;
	target: string;
	mode: EdgeMode;
	debateConfig?: DebateConfig;
	/** Per-edge input prompt (used when multiple triggers feed the same agent with different prompts) */
	prompt?: string;
	/** Per-edge override: whether this source agent's output is included in
	 *  {{CUE_SOURCE_OUTPUT}} (and its per-source variable) for the target agent.
	 *  When undefined, falls back to the target agent's `includeUpstreamOutput`.
	 *  Set to `false` if this source's output should not appear in the prompt. */
	includeUpstreamOutput?: boolean;
	/** Whether this source's output should be forwarded through this agent to
	 *  downstream agents. When true, the output is attached to this agent's
	 *  completion event so agents later in the chain can still access it via
	 *  per-source template variables. Default: false. */
	forwardOutput?: boolean;
}

/** Info about an incoming agent→agent edge, used by the config panel to render
 *  per-source upstream-output toggles. */
export interface IncomingAgentEdgeInfo {
	edgeId: string;
	sourceNodeId: string;
	sourceSessionName: string;
	includeUpstreamOutput: boolean;
	forwardOutput: boolean;
}

/**
 * Sanitize an agent session name into a valid template-variable suffix.
 * Used by both the backend enricher and the pipeline editor UI to derive
 * consistent variable names like `CUE_OUTPUT_AGENT_A`.
 *
 * "Agent A" → "AGENT_A", "my-agent.1" → "MY_AGENT_1", "   " → "UNNAMED"
 */
export function sanitizeVarName(name: string): string {
	const sanitized = name
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
	return sanitized || 'UNNAMED';
}

export interface CuePipeline {
	id: string;
	name: string;
	color: string;
	nodes: PipelineNode[];
	edges: PipelineEdge[];
}

export interface CuePipelineState {
	pipelines: CuePipeline[];
	selectedPipelineId: string | null;
}

export interface PipelineViewport {
	x: number;
	y: number;
	zoom: number;
}

export interface PipelineLayoutState {
	pipelines: CuePipeline[];
	selectedPipelineId: string | null;
	viewport?: PipelineViewport;
	/**
	 * Set of project roots that the most recent successful save wrote to.
	 * Persisted alongside the layout so we can re-seed lastWrittenRootsRef on
	 * editor mount even when an agent that previously wrote to a root has been
	 * renamed or removed since (in which case sessionId/sessionName lookup
	 * would otherwise miss the root and a future "delete the orphaned pipeline"
	 * save would leave a stale YAML at that root).
	 */
	writtenRoots?: string[];
}

/** Session data with subscriptions for the Cue graph/pipeline visualization */
export type CueGraphSession = SharedCueGraphSession;

/** Returns the first unused color from the palette, cycling if all used. */
export function getNextPipelineColor(existingPipelines: CuePipeline[]): string {
	const usedColors = new Set(existingPipelines.map((p) => p.color));
	for (const color of PIPELINE_COLORS) {
		if (!usedColors.has(color)) {
			return color;
		}
	}
	return PIPELINE_COLORS[existingPipelines.length % PIPELINE_COLORS.length];
}

// ─── Shared pipeline-editor types ────────────────────────────────────────────

/** Lightweight session descriptor used by the pipeline editor (avoids importing full Session). */
export interface CuePipelineSessionInfo {
	id: string;
	groupId?: string;
	name: string;
	toolType: string;
	projectRoot?: string;
}

/** Info about an incoming trigger edge for per-edge prompt editing. */
export interface IncomingTriggerEdgeInfo {
	edgeId: string;
	triggerLabel: string;
	configSummary: string;
	prompt: string;
}
