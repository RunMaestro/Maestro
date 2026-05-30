/**
 * usePipelineContextMenu — right-click context menu state and handlers for nodes.
 *
 * Owns the contextMenu state and the Configure/Delete/Duplicate handlers.
 * All three handlers re-check isAllPipelinesView even after open guard:
 * a menu opened in the per-pipeline view stays rendered if the user switches
 * to All Pipelines while the menu is open, and without the guard the still-
 * clickable items would mutate state that isn't editable.
 */

import { useCallback, useState } from 'react';
import type { Node } from 'reactflow';
import type {
	CuePipelineState,
	PipelineNode,
	TriggerNodeData,
} from '../../../shared/cue-pipeline-types';
import type { ContextMenuState } from '../../components/CuePipelineEditor/PipelineContextMenu';

export interface UsePipelineContextMenuParams {
	isAllPipelinesView: boolean;
	setPipelineState: React.Dispatch<React.SetStateAction<CuePipelineState>>;
	setSelectedNodeId: (id: string | null) => void;
	setSelectedEdgeId: (id: string | null) => void;
}

export interface UsePipelineContextMenuReturn {
	contextMenu: ContextMenuState | null;
	setContextMenu: React.Dispatch<React.SetStateAction<ContextMenuState | null>>;
	onNodeContextMenu: (event: React.MouseEvent, node: Node) => void;
	handleContextMenuConfigure: () => void;
	handleContextMenuDelete: () => void;
	handleContextMenuDuplicate: () => void;
	handleContextMenuDismiss: () => void;
}

export function usePipelineContextMenu({
	isAllPipelinesView,
	setPipelineState,
	setSelectedNodeId,
	setSelectedEdgeId,
}: UsePipelineContextMenuParams): UsePipelineContextMenuReturn {
	const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

	const onNodeContextMenu = useCallback(
		(event: React.MouseEvent, node: Node) => {
			event.preventDefault();
			if (isAllPipelinesView) return;
			const sepIdx = node.id.indexOf(':');
			if (sepIdx === -1) return;
			const pipelineId = node.id.substring(0, sepIdx);
			const nodeId = node.id.substring(sepIdx + 1);
			setContextMenu({
				x: event.clientX,
				y: event.clientY,
				nodeId,
				pipelineId,
				nodeType: node.type as 'trigger' | 'agent',
			});
		},
		[isAllPipelinesView]
	);

	const handleContextMenuConfigure = useCallback(() => {
		if (!contextMenu) return;
		if (isAllPipelinesView) {
			setContextMenu(null);
			return;
		}
		setSelectedNodeId(`${contextMenu.pipelineId}:${contextMenu.nodeId}`);
		setSelectedEdgeId(null);
		setContextMenu(null);
	}, [contextMenu, isAllPipelinesView, setSelectedNodeId, setSelectedEdgeId]);

	const handleContextMenuDelete = useCallback(() => {
		if (!contextMenu) return;
		if (isAllPipelinesView) {
			setContextMenu(null);
			return;
		}
		setPipelineState((prev) => ({
			...prev,
			pipelines: prev.pipelines.map((p) => {
				if (p.id !== contextMenu.pipelineId) return p;
				return {
					...p,
					nodes: p.nodes.filter((n) => n.id !== contextMenu.nodeId),
					edges: p.edges.filter(
						(e) => e.source !== contextMenu.nodeId && e.target !== contextMenu.nodeId
					),
				};
			}),
		}));
		setSelectedNodeId(null);
		setContextMenu(null);
	}, [contextMenu, isAllPipelinesView, setPipelineState, setSelectedNodeId]);

	const handleContextMenuDuplicate = useCallback(() => {
		if (!contextMenu || contextMenu.nodeType !== 'trigger') return;
		if (isAllPipelinesView) {
			setContextMenu(null);
			return;
		}
		setPipelineState((prev) => {
			const pipeline = prev.pipelines.find((p) => p.id === contextMenu.pipelineId);
			if (!pipeline) return prev;
			const original = pipeline.nodes.find((n) => n.id === contextMenu.nodeId);
			if (!original || original.type !== 'trigger') return prev;
			const newNode: PipelineNode = {
				id: `trigger-${Date.now()}`,
				type: 'trigger',
				position: { x: original.position.x + 50, y: original.position.y + 50 },
				data: { ...(original.data as TriggerNodeData) },
			};
			return {
				...prev,
				pipelines: prev.pipelines.map((p) => {
					if (p.id !== contextMenu.pipelineId) return p;
					return { ...p, nodes: [...p.nodes, newNode] };
				}),
			};
		});
		setContextMenu(null);
	}, [contextMenu, isAllPipelinesView, setPipelineState]);

	const handleContextMenuDismiss = useCallback(() => {
		setContextMenu(null);
	}, []);

	return {
		contextMenu,
		setContextMenu,
		onNodeContextMenu,
		handleContextMenuConfigure,
		handleContextMenuDelete,
		handleContextMenuDuplicate,
		handleContextMenuDismiss,
	};
}
