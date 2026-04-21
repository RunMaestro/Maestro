/**
 * usePipelineSelection — Selection state and derived lookups for the pipeline editor.
 *
 * Manages selectedNodeId/selectedEdgeId, resolves composite IDs to pipeline nodes/edges,
 * computes derived data (incoming triggers, source/target nodes), and provides click handlers.
 */

import { useCallback, useMemo, useState } from 'react';
import type { Node, Edge } from 'reactflow';
import {
	CUE_COLOR,
	type CuePipelineState,
	type PipelineNode,
	type PipelineEdge as PipelineEdgeType,
	type TriggerNodeData,
	type AgentNodeData,
	type IncomingTriggerEdgeInfo,
	type IncomingAgentEdgeInfo,
} from '../../../shared/cue-pipeline-types';
import { getTriggerConfigSummary } from '../../components/CuePipelineEditor/utils/pipelineGraph';
import { defaultPromptFor } from '../../components/CuePipelineEditor/cueEventConstants';

export type {
	IncomingTriggerEdgeInfo,
	IncomingAgentEdgeInfo,
} from '../../../shared/cue-pipeline-types';

export interface UsePipelineSelectionParams {
	pipelineState: CuePipelineState;
}

export interface UsePipelineSelectionReturn {
	selectedNodeId: string | null;
	setSelectedNodeId: React.Dispatch<React.SetStateAction<string | null>>;
	selectedEdgeId: string | null;
	setSelectedEdgeId: React.Dispatch<React.SetStateAction<string | null>>;
	selectedNode: PipelineNode | null;
	selectedNodePipelineId: string | null;
	selectedNodeHasOutgoingEdge: boolean;
	hasIncomingAgentEdges: boolean;
	incomingAgentEdgeCount: number;
	incomingAgentEdges: IncomingAgentEdgeInfo[];
	incomingTriggerEdges: IncomingTriggerEdgeInfo[];
	selectedEdge: PipelineEdgeType | null;
	selectedEdgePipelineId: string | null;
	selectedEdgePipelineColor: string;
	edgeSourceNode: PipelineNode | null;
	edgeTargetNode: PipelineNode | null;
	onCanvasSessionIds: Set<string>;
	onNodeClick: (event: React.MouseEvent, node: Node) => void;
	onEdgeClick: (event: React.MouseEvent, edge: Edge) => void;
	onPaneClick: () => void;
	handleConfigureNode: (compositeId: string) => void;
}

export function usePipelineSelection({
	pipelineState,
}: UsePipelineSelectionParams): UsePipelineSelectionReturn {
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
	const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

	const handleConfigureNode = useCallback((compositeId: string) => {
		setSelectedNodeId((prev) => (prev === compositeId ? null : compositeId));
		setSelectedEdgeId(null);
	}, []);

	// Collect session IDs currently on canvas for the agent drawer indicator
	const onCanvasSessionIds = useMemo(() => {
		const ids = new Set<string>();
		for (const pipeline of pipelineState.pipelines) {
			for (const pNode of pipeline.nodes) {
				if (pNode.type === 'agent') {
					ids.add((pNode.data as AgentNodeData).sessionId);
				}
			}
		}
		return ids;
	}, [pipelineState.pipelines]);

	// Resolve selected node from pipeline state using the composite ID
	const {
		selectedNode,
		selectedNodePipelineId,
		selectedNodeHasOutgoingEdge,
		hasIncomingAgentEdges,
		incomingAgentEdgeCount,
		incomingAgentEdges,
		incomingTriggerEdges,
	} = useMemo(() => {
		const empty = {
			selectedNode: null as PipelineNode | null,
			selectedNodePipelineId: null as string | null,
			selectedNodeHasOutgoingEdge: false,
			hasIncomingAgentEdges: false,
			incomingAgentEdgeCount: 0,
			incomingAgentEdges: [] as IncomingAgentEdgeInfo[],
			incomingTriggerEdges: [] as IncomingTriggerEdgeInfo[],
		};
		if (!selectedNodeId) return empty;
		// selectedNodeId is composite: "pipelineId:nodeId"
		const sepIdx = selectedNodeId.indexOf(':');
		if (sepIdx === -1) return empty;
		const pipelineId = selectedNodeId.substring(0, sepIdx);
		const nodeId = selectedNodeId.substring(sepIdx + 1);
		const pipeline = pipelineState.pipelines.find((p) => p.id === pipelineId);
		const node = pipeline?.nodes.find((n) => n.id === nodeId);
		const hasOutgoing = pipeline?.edges.some((e) => e.source === nodeId) ?? false;

		// Compute incoming trigger edges and check for incoming agent edges
		const triggerEdges: IncomingTriggerEdgeInfo[] = [];
		const agentEdges: IncomingAgentEdgeInfo[] = [];
		if (node?.type === 'agent' && pipeline) {
			const incomingEdges = pipeline.edges.filter((e) => e.target === nodeId);
			const targetData = node.data as AgentNodeData;
			for (const edge of incomingEdges) {
				const sourceNode = pipeline.nodes.find((n) => n.id === edge.source);
				if (sourceNode?.type === 'trigger') {
					const triggerData = sourceNode.data as TriggerNodeData;
					// Per-edge prompt takes precedence. Fall back to the event-type
					// barebones template — NEVER to the agent node's inputPrompt, which
					// used to leak the first trigger's prompt onto every other trigger
					// feeding the same agent.
					triggerEdges.push({
						edgeId: edge.id,
						triggerLabel: triggerData.customLabel || triggerData.label,
						configSummary: getTriggerConfigSummary(triggerData),
						prompt: edge.prompt ?? defaultPromptFor(triggerData.eventType),
					});
				} else if (sourceNode?.type === 'agent') {
					const agentData = sourceNode.data as AgentNodeData;
					agentEdges.push({
						edgeId: edge.id,
						sourceNodeId: sourceNode.id,
						sourceSessionName: agentData.sessionName,
						// Resolve: edge setting → node setting → true
						includeUpstreamOutput:
							edge.includeUpstreamOutput !== undefined
								? edge.includeUpstreamOutput
								: targetData.includeUpstreamOutput !== false,
						forwardOutput: edge.forwardOutput ?? false,
					});
				}
			}
		}

		return {
			selectedNode: node ?? null,
			selectedNodePipelineId: node ? pipelineId : null,
			selectedNodeHasOutgoingEdge: hasOutgoing,
			hasIncomingAgentEdges: agentEdges.length > 0,
			incomingAgentEdgeCount: agentEdges.length,
			incomingAgentEdges: agentEdges,
			incomingTriggerEdges: triggerEdges,
		};
	}, [selectedNodeId, pipelineState.pipelines]);

	// Resolve selected edge
	const { selectedEdge, selectedEdgePipelineId, selectedEdgePipelineColor } = useMemo(() => {
		if (!selectedEdgeId)
			return {
				selectedEdge: null,
				selectedEdgePipelineId: null,
				selectedEdgePipelineColor: CUE_COLOR,
			};
		const sepIdx = selectedEdgeId.indexOf(':');
		if (sepIdx === -1)
			return {
				selectedEdge: null,
				selectedEdgePipelineId: null,
				selectedEdgePipelineColor: CUE_COLOR,
			};
		const pipelineId = selectedEdgeId.substring(0, sepIdx);
		const edgeLocalId = selectedEdgeId.substring(sepIdx + 1);
		const pipeline = pipelineState.pipelines.find((p) => p.id === pipelineId);
		const edge = pipeline?.edges.find((e) => e.id === edgeLocalId);
		return {
			selectedEdge: edge ?? null,
			selectedEdgePipelineId: edge ? pipelineId : null,
			selectedEdgePipelineColor: pipeline?.color ?? CUE_COLOR,
		};
	}, [selectedEdgeId, pipelineState.pipelines]);

	// Resolve source/target nodes for the selected edge
	const { edgeSourceNode, edgeTargetNode } = useMemo(() => {
		if (!selectedEdge || !selectedEdgePipelineId)
			return { edgeSourceNode: null, edgeTargetNode: null };
		const pipeline = pipelineState.pipelines.find((p) => p.id === selectedEdgePipelineId);
		if (!pipeline) return { edgeSourceNode: null, edgeTargetNode: null };
		return {
			edgeSourceNode: pipeline.nodes.find((n) => n.id === selectedEdge.source) ?? null,
			edgeTargetNode: pipeline.nodes.find((n) => n.id === selectedEdge.target) ?? null,
		};
	}, [selectedEdge, selectedEdgePipelineId, pipelineState.pipelines]);

	const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
		setSelectedNodeId(node.id);
		setSelectedEdgeId(null);
	}, []);

	const onEdgeClick = useCallback((_event: React.MouseEvent, edge: Edge) => {
		setSelectedEdgeId(edge.id);
		setSelectedNodeId(null);
	}, []);

	const onPaneClick = useCallback(() => {
		setSelectedNodeId(null);
		setSelectedEdgeId(null);
	}, []);

	return {
		selectedNodeId,
		setSelectedNodeId,
		selectedEdgeId,
		setSelectedEdgeId,
		selectedNode,
		selectedNodePipelineId,
		selectedNodeHasOutgoingEdge,
		hasIncomingAgentEdges,
		incomingAgentEdgeCount,
		incomingAgentEdges,
		incomingTriggerEdges,
		selectedEdge,
		selectedEdgePipelineId,
		selectedEdgePipelineColor,
		edgeSourceNode,
		edgeTargetNode,
		onCanvasSessionIds,
		onNodeClick,
		onEdgeClick,
		onPaneClick,
		handleConfigureNode,
	};
}
