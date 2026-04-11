/**
 * Pure utility functions for converting the internal CuePipelineState
 * into React Flow nodes and edges for rendering.
 *
 * Extracted here so they can be unit-tested independently of the component.
 */

import { MarkerType, type Node, type Edge } from 'reactflow';
import type {
	CuePipelineState,
	TriggerNodeData,
	AgentNodeData,
} from '../../../../shared/cue-pipeline-types';
import type { Theme } from '../../../../shared/theme-types';
import type { TriggerNodeDataProps } from '../nodes/TriggerNode';
import type { AgentNodeDataProps } from '../nodes/AgentNode';
import type { PipelineEdgeData } from '../edges/PipelineEdge';

// ─── Trigger config summary ──────────────────────────────────────────────────

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

// ─── Pipeline Y-offset (for "All Pipelines" view) ──────────────────────────

const PIPELINE_GAP = 100; // px between pipeline groups
const NODE_HEIGHT = 100; // approximate node height

/**
 * Computes vertical offsets so pipeline groups don't overlap in the
 * "All Pipelines" view. Returns an empty map when a single pipeline is
 * selected (offsets are only needed for the combined view).
 *
 * Exported so `onNodesChange` can subtract offsets before writing
 * ReactFlow's screen-space positions back to the canonical state.
 */
export function computePipelineYOffsets(
	pipelines: CuePipelineState['pipelines'],
	selectedPipelineId: string | null
): Map<string, number> {
	const offsets = new Map<string, number>();
	if (selectedPipelineId !== null || pipelines.length <= 1) return offsets;

	let currentY = 0;
	for (const pipeline of pipelines) {
		if (pipeline.nodes.length === 0) continue;
		let minY = Infinity;
		let maxY = -Infinity;
		for (const node of pipeline.nodes) {
			minY = Math.min(minY, node.position.y);
			maxY = Math.max(maxY, node.position.y);
		}
		offsets.set(pipeline.id, currentY - minY);
		currentY += maxY - minY + NODE_HEIGHT + PIPELINE_GAP;
	}
	return offsets;
}

// ─── Node conversion ─────────────────────────────────────────────────────────

/**
 * Converts the internal pipeline state into React Flow node objects.
 *
 * Rules:
 * - "All Pipelines" view (selectedPipelineId === null): renders all nodes from
 *   all pipelines, stacked vertically with gap offsets to avoid overlap.
 * - "Selected pipeline" view: renders ONLY nodes belonging to the active
 *   pipeline. Nodes from other pipelines are fully hidden — even if the same
 *   agent session appears in multiple pipelines. This prevents confusing
 *   "ghost" duplicates when an agent is shared across pipelines.
 *
 * Agent nodes always carry multi-pipeline color metadata so the AgentNode
 * component can display the multi-color indicator even in the selected view.
 */
export function convertToReactFlowNodes(
	pipelines: CuePipelineState['pipelines'],
	selectedPipelineId: string | null,
	onConfigureNode?: (compositeId: string) => void,
	triggerOptions?: {
		onTriggerPipeline?: (pipelineName: string) => void;
		isSaved?: boolean;
		runningPipelineIds?: Set<string>;
	},
	theme?: Theme,
	/** Pre-computed Y-offsets to use instead of recomputing from bounding boxes.
	 *  Passed during drag so rendering uses the same offsets as onNodesChange. */
	frozenYOffsets?: Map<string, number> | null
): Node[] {
	const nodes: Node[] = [];

	// When showing all pipelines, compute vertical offsets to prevent overlap.
	// During drag, use frozen offsets so the display stays consistent with the
	// offsets subtracted in onNodesChange (prevents visual jump on drag end).
	const pipelineYOffsets = frozenYOffsets ?? computePipelineYOffsets(pipelines, selectedPipelineId);

	// First pass: compute all pipeline colors per agent session (for multi-color indicator)
	const agentPipelineMap = new Map<string, string[]>();
	for (const pipeline of pipelines) {
		for (const pNode of pipeline.nodes) {
			if (pNode.type === 'agent') {
				const agentData = pNode.data as AgentNodeData;
				const existing = agentPipelineMap.get(agentData.sessionId) ?? [];
				if (!existing.includes(pipeline.color)) {
					existing.push(pipeline.color);
				}
				agentPipelineMap.set(agentData.sessionId, existing);
			}
		}
	}

	// Count how many pipelines each agent appears in (for pipelineCount badge)
	const agentPipelineCount = new Map<string, number>();
	for (const pipeline of pipelines) {
		for (const pNode of pipeline.nodes) {
			if (pNode.type === 'agent') {
				const agentData = pNode.data as AgentNodeData;
				agentPipelineCount.set(
					agentData.sessionId,
					(agentPipelineCount.get(agentData.sessionId) ?? 0) + 1
				);
			}
		}
	}

	// Count agent session occurrences for duplicate instance labeling
	const agentSessionCounts = new Map<string, number>();
	const agentSessionIndex = new Map<string, number>();
	for (const pipeline of pipelines) {
		if (selectedPipelineId !== null && pipeline.id !== selectedPipelineId) continue;
		for (const pNode of pipeline.nodes) {
			if (pNode.type === 'agent') {
				const sid = (pNode.data as AgentNodeData).sessionId;
				agentSessionCounts.set(sid, (agentSessionCounts.get(sid) ?? 0) + 1);
			}
		}
	}

	for (const pipeline of pipelines) {
		const isActive = selectedPipelineId === null || pipeline.id === selectedPipelineId;

		// Only render nodes from the active pipeline. In "All Pipelines" view all
		// pipelines are active, so nothing is skipped. In "selected pipeline" view,
		// nodes from other pipelines are hidden entirely — this prevents the jarring
		// "ghost duplicate" that appeared when a shared agent was dragged into a new
		// pipeline, causing the same agent from another pipeline to pop up dimmed.
		if (!isActive) continue;

		for (const pNode of pipeline.nodes) {
			const compositeId = `${pipeline.id}:${pNode.id}`;
			const yOffset = pipelineYOffsets.get(pipeline.id) ?? 0;

			if (pNode.type === 'trigger') {
				const triggerData = pNode.data as TriggerNodeData;
				const fanOutCount = pipeline.edges.filter((e) => e.source === pNode.id).length;
				const nodeData: TriggerNodeDataProps = {
					compositeId,
					eventType: triggerData.eventType,
					label: triggerData.customLabel || triggerData.label,
					configSummary: getTriggerConfigSummary(triggerData),
					onConfigure: onConfigureNode,
					onTriggerPipeline: triggerOptions?.onTriggerPipeline,
					pipelineName: pipeline.name,
					isSaved: triggerOptions?.isSaved,
					isRunning: triggerOptions?.runningPipelineIds?.has(pipeline.id),
					fanOutCount: fanOutCount > 1 ? fanOutCount : undefined,
					theme,
				};
				nodes.push({
					id: compositeId,
					type: 'trigger',
					position: { x: pNode.position.x, y: pNode.position.y + yOffset },
					data: nodeData,
					dragHandle: '.drag-handle',
				});
			} else {
				const agentData = pNode.data as AgentNodeData;
				const pipelineColors = agentPipelineMap.get(agentData.sessionId) ?? [pipeline.color];
				const hasOutgoingEdge = pipeline.edges.some((e) => e.source === pNode.id);
				const hasEdgePrompt = pipeline.edges.some((e) => e.target === pNode.id && !!e.prompt);
				// Compute instance index for duplicate agent differentiation
				const totalInstances = agentSessionCounts.get(agentData.sessionId) ?? 1;
				const currentIdx = (agentSessionIndex.get(agentData.sessionId) ?? 0) + 1;
				agentSessionIndex.set(agentData.sessionId, currentIdx);
				const instanceLabel = totalInstances > 1 ? currentIdx : undefined;
				// Compute fan-in count: incoming edges from other agent nodes
				const incomingAgentEdgeCount = pipeline.edges.filter((e) => {
					if (e.target !== pNode.id) return false;
					const srcNode = pipeline.nodes.find((n) => n.id === e.source);
					return srcNode?.type === 'agent';
				}).length;
				const nodeData: AgentNodeDataProps = {
					compositeId,
					sessionId: agentData.sessionId,
					sessionName: agentData.sessionName,
					toolType: agentData.toolType,
					instanceLabel,
					fanInCount: incomingAgentEdgeCount > 1 ? incomingAgentEdgeCount : undefined,
					hasPrompt: !!(agentData.inputPrompt || agentData.outputPrompt || hasEdgePrompt),
					hasOutgoingEdge,
					pipelineColor: pipeline.color,
					pipelineCount: agentPipelineCount.get(agentData.sessionId) ?? 1,
					pipelineColors,
					onConfigure: onConfigureNode,
					theme,
				};
				nodes.push({
					id: compositeId,
					type: 'agent',
					position: { x: pNode.position.x, y: pNode.position.y + yOffset },
					data: nodeData,
					dragHandle: '.drag-handle',
				});
			}
		}
	}

	return nodes;
}

// ─── Edge conversion ─────────────────────────────────────────────────────────

/**
 * Converts the internal pipeline state into React Flow edge objects.
 *
 * Edges from non-active pipelines are rendered with `isActivePipeline: false`
 * so the PipelineEdge component can dim them appropriately.
 */
export function convertToReactFlowEdges(
	pipelines: CuePipelineState['pipelines'],
	selectedPipelineId: string | null,
	runningPipelineIds?: Set<string>,
	selectedEdgeId?: string | null,
	theme?: Theme
): Edge[] {
	const edges: Edge[] = [];

	for (const pipeline of pipelines) {
		const isActive = selectedPipelineId === null || pipeline.id === selectedPipelineId;

		// Skip non-active pipelines entirely — their nodes are not rendered by
		// convertToReactFlowNodes, so edges referencing them would be orphaned.
		// React Flow may cache the "invalid" state of orphaned edges internally,
		// causing them to not re-appear when switching back to All Pipelines view.
		if (!isActive) continue;

		const isRunning = runningPipelineIds?.has(pipeline.id) ?? false;

		for (const pEdge of pipeline.edges) {
			const compositeId = `${pipeline.id}:${pEdge.id}`;
			const edgeData: PipelineEdgeData = {
				pipelineColor: pipeline.color,
				mode: pEdge.mode,
				isActivePipeline: isActive,
				isRunning,
				theme,
			};
			edges.push({
				id: compositeId,
				source: `${pipeline.id}:${pEdge.source}`,
				target: `${pipeline.id}:${pEdge.target}`,
				type: 'pipeline',
				data: edgeData,
				selected: compositeId === selectedEdgeId,
				markerEnd: {
					type: MarkerType.ArrowClosed,
					color: pipeline.color,
					width: selectedEdgeId === compositeId ? 18 : 16,
					height: selectedEdgeId === compositeId ? 18 : 16,
				},
			});
		}
	}

	return edges;
}
