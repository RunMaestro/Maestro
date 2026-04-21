/**
 * usePipelineMutations — Node/edge mutation callbacks scoped to the selected pipeline.
 *
 * Each callback takes the relevant `selected*PipelineId` directly as a live
 * React prop (not via a mutable ref). When selection state changes upstream,
 * React re-runs this hook and recomputes the callbacks with fresh IDs —
 * eliminating the stale-closure class of bugs that previously required the
 * `useSelectionRef` bridge in CuePipelineEditor.
 *
 * All mutations no-op when the relevant pipeline id is null (e.g. user
 * clicked a node, deleted the pipeline via another path, then triggered a
 * mutation before re-selecting).
 */

import { useCallback } from 'react';
import type {
	CuePipelineState,
	PipelineEdge as PipelineEdgeType,
	TriggerNodeData,
	AgentNodeData,
	CommandNodeData,
} from '../../../shared/cue-pipeline-types';

export interface UsePipelineMutationsParams {
	setPipelineState: React.Dispatch<React.SetStateAction<CuePipelineState>>;
	selection: {
		selectedNodePipelineId: string | null;
		selectedEdgePipelineId: string | null;
		setSelectedNodeId: (id: string | null) => void;
		setSelectedEdgeId: (id: string | null) => void;
	};
}

export interface UsePipelineMutationsReturn {
	onUpdateNode: (
		nodeId: string,
		data: Partial<TriggerNodeData | AgentNodeData | CommandNodeData>
	) => void;
	onUpdateEdgePrompt: (edgeId: string, prompt: string) => void;
	onDeleteNode: (nodeId: string) => void;
	onUpdateEdge: (edgeId: string, updates: Partial<PipelineEdgeType>) => void;
	onDeleteEdge: (edgeId: string) => void;
}

export function usePipelineMutations({
	setPipelineState,
	selection,
}: UsePipelineMutationsParams): UsePipelineMutationsReturn {
	const { selectedNodePipelineId, selectedEdgePipelineId, setSelectedNodeId, setSelectedEdgeId } =
		selection;

	const onUpdateNode = useCallback(
		(nodeId: string, data: Partial<TriggerNodeData | AgentNodeData | CommandNodeData>) => {
			if (!selectedNodePipelineId) return;
			setPipelineState((prev) => ({
				...prev,
				pipelines: prev.pipelines.map((p) => {
					if (p.id !== selectedNodePipelineId) return p;
					return {
						...p,
						nodes: p.nodes.map((n) => {
							if (n.id !== nodeId) return n;
							return { ...n, data: { ...n.data, ...data } };
						}),
					};
				}),
			}));
		},
		[selectedNodePipelineId, setPipelineState]
	);

	const onUpdateEdgePrompt = useCallback(
		(edgeId: string, prompt: string) => {
			if (!selectedNodePipelineId) return;
			setPipelineState((prev) => ({
				...prev,
				pipelines: prev.pipelines.map((p) => {
					if (p.id !== selectedNodePipelineId) return p;
					return {
						...p,
						edges: p.edges.map((e) => {
							if (e.id !== edgeId) return e;
							return { ...e, prompt };
						}),
					};
				}),
			}));
		},
		[selectedNodePipelineId, setPipelineState]
	);

	const onDeleteNode = useCallback(
		(nodeId: string) => {
			if (!selectedNodePipelineId) return;
			setPipelineState((prev) => ({
				...prev,
				pipelines: prev.pipelines.map((p) => {
					if (p.id !== selectedNodePipelineId) return p;
					return {
						...p,
						nodes: p.nodes.filter((n) => n.id !== nodeId),
						edges: p.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
					};
				}),
			}));
			setSelectedNodeId(null);
		},
		[selectedNodePipelineId, setPipelineState, setSelectedNodeId]
	);

	// Edge updates can originate from the edge config panel (selectedEdgePipelineId)
	// OR from the node config panel's upstream-sources card (selectedNodePipelineId).
	// Use whichever is available so per-edge toggles work from both contexts.
	const onUpdateEdge = useCallback(
		(edgeId: string, updates: Partial<PipelineEdgeType>) => {
			const pipelineId = selectedEdgePipelineId ?? selectedNodePipelineId;
			if (!pipelineId) return;
			setPipelineState((prev) => ({
				...prev,
				pipelines: prev.pipelines.map((p) => {
					if (p.id !== pipelineId) return p;
					return {
						...p,
						edges: p.edges.map((e) => {
							if (e.id !== edgeId) return e;
							return { ...e, ...updates };
						}),
					};
				}),
			}));
		},
		[selectedEdgePipelineId, selectedNodePipelineId, setPipelineState]
	);

	const onDeleteEdge = useCallback(
		(edgeId: string) => {
			if (!selectedEdgePipelineId) return;
			setPipelineState((prev) => ({
				...prev,
				pipelines: prev.pipelines.map((p) => {
					if (p.id !== selectedEdgePipelineId) return p;
					return {
						...p,
						edges: p.edges.filter((e) => e.id !== edgeId),
					};
				}),
			}));
			setSelectedEdgeId(null);
		},
		[selectedEdgePipelineId, setPipelineState, setSelectedEdgeId]
	);

	return {
		onUpdateNode,
		onUpdateEdgePrompt,
		onDeleteNode,
		onUpdateEdge,
		onDeleteEdge,
	};
}
