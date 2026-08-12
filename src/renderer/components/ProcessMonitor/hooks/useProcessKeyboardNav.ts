import type React from 'react';
import { useCallback } from 'react';
import type { ProcessNode } from '../types';
import { findParentNode, getVisibleNodes } from '../processTree';

export interface UseProcessKeyboardNavInput {
	tree: ProcessNode[];
	expandedIds: Set<string>;
	selectedNodeId: string | null;
	setSelectedNodeId: (id: string | null) => void;
	openProcessDetail: (node: ProcessNode) => void;
	toggleNode: (id: string) => void;
	refresh: () => Promise<void> | void;
}

export interface UseProcessKeyboardNavResult {
	onKeyDown: (e: React.KeyboardEvent) => void;
}

// Translates keyboard events into selection / expansion / detail / refresh actions.
// Stateless - all state and mutators are passed in.
export function useProcessKeyboardNav(
	input: UseProcessKeyboardNavInput
): UseProcessKeyboardNavResult {
	const {
		tree,
		expandedIds,
		selectedNodeId,
		setSelectedNodeId,
		openProcessDetail,
		toggleNode,
		refresh,
	} = input;

	const onKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			const visibleNodes = getVisibleNodes(tree, expandedIds);
			if (visibleNodes.length === 0) return;

			const currentIndex = selectedNodeId
				? visibleNodes.findIndex((n) => n.id === selectedNodeId)
				: -1;

			switch (e.key) {
				case 'ArrowDown':
					e.preventDefault();
					if (currentIndex < visibleNodes.length - 1) {
						setSelectedNodeId(visibleNodes[currentIndex + 1].id);
					} else if (currentIndex === -1 && visibleNodes.length > 0) {
						setSelectedNodeId(visibleNodes[0].id);
					}
					break;

				case 'ArrowUp':
					e.preventDefault();
					if (currentIndex > 0) {
						setSelectedNodeId(visibleNodes[currentIndex - 1].id);
					} else if (currentIndex === -1 && visibleNodes.length > 0) {
						setSelectedNodeId(visibleNodes[visibleNodes.length - 1].id);
					}
					break;

				case 'ArrowRight':
					e.preventDefault();
					if (selectedNodeId) {
						const selectedNode = visibleNodes.find((n) => n.id === selectedNodeId);
						if (selectedNode && selectedNode.children && selectedNode.children.length > 0) {
							if (!expandedIds.has(selectedNodeId)) {
								toggleNode(selectedNodeId);
							} else {
								setSelectedNodeId(selectedNode.children[0].id);
							}
						}
					}
					break;

				case 'ArrowLeft':
					e.preventDefault();
					if (selectedNodeId) {
						const selectedNode = visibleNodes.find((n) => n.id === selectedNodeId);
						if (
							selectedNode &&
							expandedIds.has(selectedNodeId) &&
							selectedNode.children &&
							selectedNode.children.length > 0
						) {
							toggleNode(selectedNodeId);
						} else {
							const parent = findParentNode(tree, selectedNodeId);
							if (parent) {
								setSelectedNodeId(parent.id);
							}
						}
					}
					break;

				case 'Enter':
				case ' ':
					e.preventDefault();
					if (selectedNodeId) {
						const selectedNode = visibleNodes.find((n) => n.id === selectedNodeId);
						if (selectedNode) {
							if (selectedNode.type === 'process' && selectedNode.processSessionId) {
								openProcessDetail(selectedNode);
							} else if (selectedNode.children && selectedNode.children.length > 0) {
								toggleNode(selectedNodeId);
							}
						}
					}
					break;

				case 'r':
				case 'R':
					e.preventDefault();
					void refresh();
					break;
			}
		},
		[tree, expandedIds, selectedNodeId, setSelectedNodeId, openProcessDetail, toggleNode, refresh]
	);

	return { onKeyDown };
}
