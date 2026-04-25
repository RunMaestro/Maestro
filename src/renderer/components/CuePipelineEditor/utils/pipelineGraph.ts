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
	CommandNodeData,
	ErrorNodeData,
} from '../../../../shared/cue-pipeline-types';
import type { Theme } from '../../../../shared/theme-types';
import type { TriggerNodeDataProps } from '../nodes/TriggerNode';
import type { AgentNodeDataProps } from '../nodes/AgentNode';
import type { CommandNodeDataProps } from '../nodes/CommandNode';
import type { ErrorNodeDataProps } from '../nodes/ErrorNode';
import type { PipelineEdgeData } from '../edges/PipelineEdge';

/** Build the one-line summary shown under the command node's name. */
function summarizeCommandNode(data: CommandNodeData): string {
	if (data.mode === 'shell') {
		const text = data.shell?.trim() ?? '';
		if (!text) return '(no command)';
		const firstLine = text.split('\n')[0];
		return '$ ' + (firstLine.length > 36 ? firstLine.slice(0, 33) + '…' : firstLine);
	}
	const target = data.cliTarget?.trim() || '(no target)';
	return `cli send → ${target}`;
}

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
		/** Pipeline-wide running state — kept for components (e.g. the
		 *  NodeConfigPanel on the right rail) that only need a yes/no per
		 *  pipeline. Trigger-node animation should prefer
		 *  `runningSubscriptionsByPipeline` for per-sub precision. */
		runningPipelineIds?: Set<string>;
		/** Per-pipeline set of exact subscription names with active runs.
		 *  A trigger node animates iff its own `subscriptionName` is in the
		 *  set for its owning pipeline. Falls back to `runningPipelineIds`
		 *  when the trigger has no `subscriptionName` stamped (legacy
		 *  never-saved pipelines) so the spinner still surfaces something. */
		runningSubscriptionsByPipeline?: Map<string, Set<string>>;
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

				// Per-trigger running state: a trigger node only shows the
				// spinner when its OWN subscription has an active run. In a
				// multi-trigger pipeline (e.g. startup + scheduled + GitHub PR
				// all under "Pipeline 1") this prevents every trigger icon from
				// spinning just because one sub fired.
				//
				// Fallback: when the trigger has no `subscriptionName` (legacy
				// never-saved pipelines), fall back to the pipeline-wide flag
				// so the spinner still surfaces something rather than going
				// silent entirely.
				const runningSubs = triggerOptions?.runningSubscriptionsByPipeline?.get(pipeline.id);
				const isRunning = triggerData.subscriptionName
					? !!runningSubs?.has(triggerData.subscriptionName)
					: (triggerOptions?.runningPipelineIds?.has(pipeline.id) ?? false);

				const nodeData: TriggerNodeDataProps = {
					compositeId,
					eventType: triggerData.eventType,
					label: triggerData.customLabel || triggerData.label,
					configSummary: getTriggerConfigSummary(triggerData),
					onConfigure: onConfigureNode,
					onTriggerPipeline: triggerOptions?.onTriggerPipeline,
					pipelineName: pipeline.name,
					// Thread the trigger's owning subscription name through to the
					// Play button. Populated by yamlToPipeline on load; absent on
					// never-saved pipelines (Play button is hidden in that case).
					subscriptionName: triggerData.subscriptionName,
					isSaved: triggerOptions?.isSaved,
					isRunning,
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
			} else if (pNode.type === 'agent') {
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
			} else if (pNode.type === 'command') {
				const cmdData = pNode.data as CommandNodeData;
				const nodeData: CommandNodeDataProps = {
					compositeId,
					name: cmdData.name,
					mode: cmdData.mode,
					summary: summarizeCommandNode(cmdData),
					owningSessionName: cmdData.owningSessionName,
					pipelineColor: pipeline.color,
					pipelineCount: 1,
					pipelineColors: [pipeline.color],
					onConfigure: onConfigureNode,
					theme,
				};
				nodes.push({
					id: compositeId,
					type: 'command',
					position: { x: pNode.position.x, y: pNode.position.y + yOffset },
					data: nodeData,
					dragHandle: '.drag-handle',
				});
			} else if (pNode.type === 'error') {
				const errData = pNode.data as ErrorNodeData;
				const nodeData: ErrorNodeDataProps = {
					compositeId,
					message: errData.message,
					unresolvedId: errData.unresolvedId,
					unresolvedName: errData.unresolvedName,
					subscriptionName: errData.subscriptionName,
					theme,
				};
				nodes.push({
					id: compositeId,
					type: 'error',
					position: { x: pNode.position.x, y: pNode.position.y + yOffset },
					data: nodeData,
					dragHandle: '.drag-handle',
					selectable: false,
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
 *
 * Edge animation rule: an edge is flagged `isRunning` iff its TARGET is an
 * agent node whose `sessionName` appears in this pipeline's active-agents
 * set (`runningAgentsByPipeline`). This makes only the edges feeding into
 * the currently-executing agent(s) animate — rather than every edge in a
 * pipeline where any run is active. Works identically for linear chains
 * (one target per hop), fan-out (multiple targets concurrently), and
 * fan-in (multiple incoming edges to one running target).
 *
 * Non-agent targets (cli_output, error nodes) never animate — they don't
 * correspond to a dispatchable run.
 */
export function convertToReactFlowEdges(
	pipelines: CuePipelineState['pipelines'],
	selectedPipelineId: string | null,
	selectedEdgeId?: string | null,
	theme?: Theme,
	runningAgentsByPipeline?: Map<string, Set<string>>
): Edge[] {
	const edges: Edge[] = [];

	for (const pipeline of pipelines) {
		const isActive = selectedPipelineId === null || pipeline.id === selectedPipelineId;

		// Skip non-active pipelines entirely — their nodes are not rendered by
		// convertToReactFlowNodes, so edges referencing them would be orphaned.
		// React Flow may cache the "invalid" state of orphaned edges internally,
		// causing them to not re-appear when switching back to All Pipelines view.
		if (!isActive) continue;

		const runningAgents = runningAgentsByPipeline?.get(pipeline.id);
		// Build node lookup once per pipeline so the per-edge target lookup is O(1).
		const nodeById = new Map<string, (typeof pipeline.nodes)[number]>();
		for (const n of pipeline.nodes) nodeById.set(n.id, n);

		for (const pEdge of pipeline.edges) {
			const compositeId = `${pipeline.id}:${pEdge.id}`;
			const targetNode = nodeById.get(pEdge.target);
			const targetSessionName =
				targetNode?.type === 'agent' ? (targetNode.data as AgentNodeData).sessionName : undefined;
			const isRunning =
				!!targetSessionName && !!runningAgents && runningAgents.has(targetSessionName);

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
