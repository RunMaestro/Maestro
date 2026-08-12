import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useFileExplorerStore } from '../../../stores/fileExplorerStore';
import type { FlattenedNode } from '../types';

interface UseFileTreeSelectionArgs {
	sessionId: string;
	selectedFileIndex: number;
	setSelectedFileIndex: (n: number) => void;
	flattenedTreeRef: React.MutableRefObject<FlattenedNode[]>;
}

interface UseFileTreeSelectionResult {
	selectedPaths: Set<string>;
	selectedPathsRef: React.MutableRefObject<Set<string>>;
	setSelectedPaths: React.Dispatch<React.SetStateAction<Set<string>>>;
	handleRowSelectionClick: (e: React.MouseEvent, globalIndex: number, fullPath: string) => void;
}

export function useFileTreeSelection({
	sessionId,
	selectedFileIndex,
	setSelectedFileIndex,
	flattenedTreeRef,
}: UseFileTreeSelectionArgs): UseFileTreeSelectionResult {
	// Multi-selection state lives in fileExplorerStore so the window-level
	// keyboard handler (useFileExplorerEffects) and these mouse handlers extend
	// the SAME selection from a SINGLE anchor. `selectedPaths` holds the
	// *explicitly* selected paths; when empty, the row at `selectedFileIndex` is
	// the implicit single selection.
	const selectedPaths = useFileExplorerStore((s) => s.selectedPaths);
	const setSelectedPaths = useMemo(() => useFileExplorerStore.getState().setSelectedPaths, []);
	const setSelectionAnchorIndex = useMemo(
		() => useFileExplorerStore.getState().setSelectionAnchorIndex,
		[]
	);

	// Ref mirror so the memoized TreeRow renderer can read the current selection
	// without listing it as a dep (which would force every row to re-render on
	// every click).
	const selectedPathsRef = useRef(selectedPaths);
	useEffect(() => {
		selectedPathsRef.current = selectedPaths;
	}, [selectedPaths]);

	// Drop the multi-selection (and anchor) when switching agents - paths are
	// session-scoped and would otherwise resolve against a different working
	// directory. Also runs on mount, which keeps the store-backed selection from
	// leaking across panel remounts (matching the old local-state behavior).
	useEffect(() => {
		setSelectedPaths(new Set());
		setSelectionAnchorIndex(-1);
	}, [sessionId, setSelectedPaths, setSelectionAnchorIndex]);

	// Multi-select aware row click. Plain click = single select (clear extras).
	// Cmd/Ctrl+click = toggle this row in the multi-selection. Shift+click =
	// extend selection from the anchor to this row.
	const handleRowSelectionClick = useCallback(
		(e: React.MouseEvent, globalIndex: number, fullPath: string) => {
			if (e.shiftKey) {
				// Finder/Explorer semantics: the anchor stays put across successive
				// shift-clicks so the range pivots from the last plain/Cmd-click (or
				// arrow-key move) rather than the last shift-click. Plain click,
				// Cmd-click, and arrow-key navigation all move the anchor; shift-click
				// does not. Applied uniformly across Windows, Linux, and macOS.
				const storedAnchor = useFileExplorerStore.getState().selectionAnchorIndex;
				const tree = flattenedTreeRef.current;
				const anchor =
					storedAnchor >= 0 && storedAnchor < tree.length ? storedAnchor : selectedFileIndex;
				const start = Math.min(anchor, globalIndex);
				const end = Math.max(anchor, globalIndex);
				const next = new Set<string>();
				for (let i = start; i <= end; i++) {
					const item = tree[i];
					if (item) next.add(item.path);
				}
				setSelectedPaths(next);
				return;
			}
			if (e.metaKey || e.ctrlKey) {
				const current = useFileExplorerStore.getState().selectedPaths;
				const next = new Set(current);
				// If the selection was empty, fold in the previously-selected single
				// row so toggling adds (or removes) relative to a 1-item baseline.
				if (next.size === 0) {
					const prevItem = flattenedTreeRef.current[selectedFileIndex];
					if (prevItem && prevItem.path !== fullPath) next.add(prevItem.path);
				}
				if (next.has(fullPath)) next.delete(fullPath);
				else next.add(fullPath);
				setSelectedPaths(next);
				setSelectedFileIndex(globalIndex);
				setSelectionAnchorIndex(globalIndex);
				return;
			}
			// Plain click - collapse to single selection and reset the range anchor.
			if (useFileExplorerStore.getState().selectedPaths.size > 0) setSelectedPaths(new Set());
			setSelectedFileIndex(globalIndex);
			setSelectionAnchorIndex(globalIndex);
		},
		[
			selectedFileIndex,
			setSelectedFileIndex,
			flattenedTreeRef,
			setSelectedPaths,
			setSelectionAnchorIndex,
		]
	);

	return { selectedPaths, selectedPathsRef, setSelectedPaths, handleRowSelectionClick };
}
