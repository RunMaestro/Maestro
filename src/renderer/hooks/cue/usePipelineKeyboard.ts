/**
 * usePipelineKeyboard — installs keyboard shortcuts for the pipeline editor.
 *
 *   - Delete/Backspace: removes selected node or edge (guarded: no-op in
 *     text inputs, no-op in All Pipelines view).
 *   - Escape: cascading close — drawer first, then selection.
 *   - Cmd/Ctrl+S: triggers handleSave, always (even in text inputs, matching
 *     pre-extraction behavior).
 *   - P / S: switch canvas interaction mode (Pan / Select). Bare keys, ignored
 *     while typing in inputs and when modifier keys are held.
 */

import { useEffect, type RefObject } from 'react';
import type { Node, Edge } from 'reactflow';
import type { CanvasInteractionMode } from '../../components/CuePipelineEditor/PipelineCanvas';

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
	setInteractionMode: (mode: CanvasInteractionMode) => void;
	handleSave: () => void | Promise<void>;
	/**
	 * Root element of the pipeline editor. Used to distinguish inputs inside
	 * the editor (where typing should pass through) from inputs behind the
	 * modal (where the modal must claim the keystroke instead of letting the
	 * focused background textarea swallow it).
	 */
	containerRef: RefObject<HTMLElement>;
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
		setInteractionMode,
		handleSave,
		containerRef,
	} = params;

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			const isInput =
				target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
			// Inputs behind the editor (e.g. the AI input textarea under the
			// Cue modal) shouldn't suppress our shortcuts — only inputs inside
			// the editor count as "user is typing here".
			const isInputInsideEditor = isInput && containerRef.current?.contains(target) === true;

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
			} else if (
				(e.key === 'p' || e.key === 'P' || e.key === 's' || e.key === 'S') &&
				!e.metaKey &&
				!e.ctrlKey &&
				!e.altKey
			) {
				// Bare P / S switch the canvas interaction mode. Skipped while
				// typing into an input *inside the editor* (lets the user actually
				// type a 'p' or 's') and when a modifier is held (Cmd+S above).
				// Inputs *outside* the editor (e.g. the AI input area behind the
				// Cue modal) must not swallow the key — the modal owns it.
				if (isInputInsideEditor) return;
				e.preventDefault();
				e.stopPropagation();
				setInteractionMode(e.key === 'p' || e.key === 'P' ? 'hand' : 'pointer');
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
		setInteractionMode,
		containerRef,
	]);
}
