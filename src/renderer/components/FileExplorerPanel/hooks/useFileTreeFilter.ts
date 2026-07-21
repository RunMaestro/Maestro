import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useLayerStack } from '../../../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../../../constants/modalPriorities';
import type { Session, FocusArea } from '../../../types';
import type { FlattenedNode } from '../types';

interface UseFileTreeFilterArgs {
	fileTreeFilterOpen: boolean;
	setFileTreeFilterOpen: (open: boolean) => void;
	setFileTreeFilter: (s: string) => void;
	lastClickedUnderFilterRef: React.MutableRefObject<string | null>;
	setActiveFocus: (focus: FocusArea) => void;
	sessionId: string;
	setSessions: Dispatch<SetStateAction<Session[]>>;
	flattenedTree: FlattenedNode[];
	setSelectedFileIndex: (n: number) => void;
	fileTreeContainerRef?: React.RefObject<HTMLDivElement>;
	virtualizer: {
		scrollToIndex: (i: number, opts?: { align?: 'start' | 'center' | 'end' | 'auto' }) => void;
	};
}

interface UseFileTreeFilterResult {
	handleFilterEscape: () => void;
	pendingRevealPath: string | null;
}

export function useFileTreeFilter({
	fileTreeFilterOpen,
	setFileTreeFilterOpen,
	setFileTreeFilter,
	lastClickedUnderFilterRef,
	setActiveFocus,
	sessionId,
	setSessions,
	flattenedTree,
	setSelectedFileIndex,
	fileTreeContainerRef,
	virtualizer,
}: UseFileTreeFilterArgs): UseFileTreeFilterResult {
	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();
	const layerIdRef = useRef<string>();
	const [pendingRevealPath, setPendingRevealPath] = useState<string | null>(null);

	// Closing the filter via Escape: if the user clicked a result first, expand
	// its ancestor folders and queue a scroll-into-view so the search payoff
	// actually lands on something they can see and act on. Move DOM focus to
	// the tree container - otherwise the browser restores focus to whatever
	// was focused before the filter opened (typically FilePreview), and that
	// component's onKeyDown swallows Cmd+F before our window-level shortcut
	// handler can route it back to the file panel.
	const handleFilterEscape = useCallback(() => {
		const clickedPath = lastClickedUnderFilterRef.current;
		lastClickedUnderFilterRef.current = null;

		if (clickedPath) {
			const parts = clickedPath.split('/').filter(Boolean);
			const ancestors: string[] = [];
			for (let i = 1; i < parts.length; i++) {
				ancestors.push(parts.slice(0, i).join('/'));
			}

			if (ancestors.length > 0) {
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;
						const expanded = new Set(s.fileExplorerExpanded ?? []);
						for (const p of ancestors) expanded.add(p);
						return { ...s, fileExplorerExpanded: Array.from(expanded) };
					})
				);
			}

			setPendingRevealPath(clickedPath);
		}

		setFileTreeFilterOpen(false);
		setFileTreeFilter('');
		fileTreeContainerRef?.current?.focus();
	}, [
		sessionId,
		setSessions,
		setFileTreeFilterOpen,
		setFileTreeFilter,
		fileTreeContainerRef,
		lastClickedUnderFilterRef,
	]);

	// Register layer when filter is open
	useEffect(() => {
		if (fileTreeFilterOpen) {
			const id = registerLayer({
				type: 'overlay',
				priority: MODAL_PRIORITIES.FILE_TREE_FILTER,
				blocksLowerLayers: false,
				capturesFocus: true,
				focusTrap: 'none',
				onEscape: handleFilterEscape,
				allowClickOutside: true,
				ariaLabel: 'File Tree Filter',
			});
			layerIdRef.current = id;
			return () => unregisterLayer(id);
		}
		// handleFilterEscape intentionally omitted - updateLayerHandler effect below
		// keeps the registered callback fresh without re-registering the layer.
	}, [fileTreeFilterOpen, registerLayer, unregisterLayer]);

	// Update handler when dependencies change
	useEffect(() => {
		if (fileTreeFilterOpen && layerIdRef.current) {
			updateLayerHandler(layerIdRef.current, handleFilterEscape);
		}
	}, [fileTreeFilterOpen, handleFilterEscape, updateLayerHandler]);

	// After Escape expanded ancestor folders, the flattened tree includes the
	// previously-hidden row - select it, focus the file pane, and scroll it into
	// view. Defer the scroll to the next frame so the virtualizer has measured
	// the new row count.
	useEffect(() => {
		if (!pendingRevealPath) return;
		const idx = flattenedTree.findIndex((item) => item.path === pendingRevealPath);
		if (idx < 0) return;
		setSelectedFileIndex(idx);
		setActiveFocus('right');
		const raf = requestAnimationFrame(() => {
			virtualizer.scrollToIndex(idx, { align: 'center' });
		});
		setPendingRevealPath(null);
		return () => cancelAnimationFrame(raf);
	}, [flattenedTree, pendingRevealPath, virtualizer, setSelectedFileIndex, setActiveFocus]);

	return { handleFilterEscape, pendingRevealPath };
}
