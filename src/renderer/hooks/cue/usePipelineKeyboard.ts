/**
 * usePipelineKeyboard — installs keyboard shortcuts for the pipeline editor.
 *
 *   - Delete/Backspace: removes selected node or edge (guarded: no-op in
 *     text inputs, no-op in All Pipelines view).
 *   - Escape: cascading close — drawer first, then selection.
 *   - Cmd/Ctrl+S: triggers handleSave, always (even in text inputs, matching
 *     pre-extraction behavior).
 */

import { useEffect } from 'react';
import type { Node, Edge } from 'reactflow';

export interface UsePipelineKeyboardParams {
	isAllPipelinesView: boolean;
	selectedNode: Node | null;
	selectedNodePipelineId: string | null;
	selectedEdge: Edge | null;
	selectedEdgePipelineId: string | null;
	selectedNodeId: string | null;
	selectedEdgeId: string | null;
	triggerDrawerOpen: boolean;
	agentDrawerOpen: boolean;
	onDeleteNode: (nodeId: string) => void;
	onDeleteEdge: (edgeId: string) => void;
	setSelectedNodeId: (id: string | null) => void;
	setSelectedEdgeId: (id: string | null) => void;
	setTriggerDrawerOpen: (open: boolean) => void;
	setAgentDrawerOpen: (open: boolean) => void;
	handleSave: () => void | Promise<void>;
}

export function usePipelineKeyboard(params: UsePipelineKeyboardParams): void {
	const {
		isAllPipelinesView,
		selectedNode,
		selectedNodePipelineId,
		selectedEdge,
		selectedEdgePipelineId,
		selectedNodeId,
		selectedEdgeId,
		triggerDrawerOpen,
		agentDrawerOpen,
		onDeleteNode,
		onDeleteEdge,
		setSelectedNodeId,
		setSelectedEdgeId,
		setTriggerDrawerOpen,
		setAgentDrawerOpen,
		handleSave,
	} = params;

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			const isInput =
				target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';

			if (e.key === 'Delete' || e.key === 'Backspace') {
				if (isInput) return;
				// All Pipelines view is read-only — no deletions.
				// (Save via Cmd+S and Escape-to-deselect remain available.)
				if (isAllPipelinesView) return;
				if (selectedNode && selectedNodePipelineId) {
					e.preventDefault();
					onDeleteNode(selectedNode.id);
				} else if (selectedEdge && selectedEdgePipelineId) {
					e.preventDefault();
					onDeleteEdge(selectedEdge.id);
				}
			} else if (e.key === 'Escape') {
				if (triggerDrawerOpen) {
					setTriggerDrawerOpen(false);
				} else if (agentDrawerOpen) {
					setAgentDrawerOpen(false);
				} else if (selectedNodeId || selectedEdgeId) {
					setSelectedNodeId(null);
					setSelectedEdgeId(null);
				}
			} else if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				void handleSave();
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [
		isAllPipelinesView,
		selectedNode,
		selectedNodePipelineId,
		selectedEdge,
		selectedEdgePipelineId,
		selectedNodeId,
		selectedEdgeId,
		onDeleteNode,
		onDeleteEdge,
		triggerDrawerOpen,
		agentDrawerOpen,
		handleSave,
		setSelectedNodeId,
		setSelectedEdgeId,
		setTriggerDrawerOpen,
		setAgentDrawerOpen,
	]);
}
