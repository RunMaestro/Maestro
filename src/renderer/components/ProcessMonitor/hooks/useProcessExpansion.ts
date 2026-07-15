import { useCallback, useEffect, useState } from 'react';
import type { ProcessNode } from '../types';
import { getExpandableIdsByDepth } from '../processTree';

// Persistence for the System Processes expand/collapse stepper.
// Stores the depth tier last shown so it survives app restarts.
const PROCESS_MONITOR_LEVEL_KEY = 'maestro.processMonitor.expandedLevel';

function readStoredExpandedLevel(): number | null {
	if (typeof window === 'undefined') return null;
	try {
		const raw = window.localStorage.getItem(PROCESS_MONITOR_LEVEL_KEY);
		if (raw === null) return null;
		const parsed = Number.parseInt(raw, 10);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
	} catch {
		return null;
	}
}

function writeStoredExpandedLevel(level: number): void {
	if (typeof window === 'undefined') return;
	try {
		window.localStorage.setItem(PROCESS_MONITOR_LEVEL_KEY, String(level));
	} catch {
		// localStorage may throw in private mode or when full - non-fatal for a UI preference.
	}
}

export interface UseProcessExpansionResult {
	expandedIds: Set<string>;
	toggleNode: (id: string) => void;
	expandStep: () => void;
	collapseStep: () => void;
}

// Owns the expanded-node Set, the stepwise expand/collapse buttons, and the
// initial-restore-from-localStorage effect. Receives the latest tree on every
// render - the initial-restore effect's `hasExpandedInitially` guard makes
// re-runs cheap no-ops, so a tree changing every poll cycle does not cascade.
export function useProcessExpansion(
	tree: ProcessNode[],
	isLoading: boolean
): UseProcessExpansionResult {
	const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
	const [hasExpandedInitially, setHasExpandedInitially] = useState(false);

	const toggleNode = useCallback((nodeId: string) => {
		setExpandedIds((prev) => {
			const next = new Set(prev);
			if (next.has(nodeId)) {
				next.delete(nodeId);
			} else {
				next.add(nodeId);
			}
			return next;
		});
	}, []);

	const expandStep = useCallback(() => {
		const idsByDepth = getExpandableIdsByDepth(tree);
		setExpandedIds((prev) => {
			for (let depth = 0; depth < idsByDepth.length; depth++) {
				const ids = idsByDepth[depth] || [];
				if (ids.length === 0) continue;
				const allExpanded = ids.every((id) => prev.has(id));
				if (!allExpanded) {
					const next = new Set(prev);
					ids.forEach((id) => next.add(id));
					writeStoredExpandedLevel(depth + 1);
					return next;
				}
			}
			return prev;
		});
	}, [tree]);

	const collapseStep = useCallback(() => {
		const idsByDepth = getExpandableIdsByDepth(tree);
		setExpandedIds((prev) => {
			for (let depth = idsByDepth.length - 1; depth >= 0; depth--) {
				const ids = idsByDepth[depth] || [];
				if (ids.length === 0) continue;
				const anyExpanded = ids.some((id) => prev.has(id));
				if (anyExpanded) {
					const next = new Set(prev);
					ids.forEach((id) => next.delete(id));
					writeStoredExpandedLevel(depth);
					return next;
				}
			}
			return prev;
		});
	}, [tree]);

	// On initial load, restore the depth level last set via the stepper buttons.
	// Falls back to fully expanded when no preference has been saved yet. The
	// `hasExpandedInitially` guard makes subsequent runs no-ops, so it is safe to
	// keep `tree` in the dep array even though tree changes every poll cycle.
	useEffect(() => {
		if (!isLoading && !hasExpandedInitially) {
			const idsByDepth = getExpandableIdsByDepth(tree);
			const stored = readStoredExpandedLevel();
			const targetLevel = stored ?? idsByDepth.length;
			const cappedLevel = Math.min(targetLevel, idsByDepth.length);
			const initialIds = new Set<string>();
			for (let depth = 0; depth < cappedLevel; depth++) {
				(idsByDepth[depth] || []).forEach((id) => initialIds.add(id));
			}
			setExpandedIds(initialIds);
			setHasExpandedInitially(true);
		}
	}, [isLoading, hasExpandedInitially, tree]);

	return { expandedIds, toggleNode, expandStep, collapseStep };
}
