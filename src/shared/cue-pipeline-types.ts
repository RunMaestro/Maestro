/**
 * Type definitions for the visual pipeline editor.
 *
 * Pipelines are named chains: trigger -> agent1 -> agent2 -> ...
 * with fan-out/fan-in support. Each pipeline has a unique color
 * for visual differentiation on the React Flow canvas.
 */

/** Event types that can trigger a Cue subscription (mirrored from cue-types.ts for renderer access) */
export type CueEventType =
	| 'time.heartbeat'
	| 'time.scheduled'
	| 'file.changed'
	| 'agent.completed'
	| 'github.pull_request'
	| 'github.issue'
	| 'task.pending';

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
}

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
