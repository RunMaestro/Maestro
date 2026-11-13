import type { DocTreeNode, DocumentTaskCount } from './AutoRunDocumentSelector';

/**
 * Roll each folder's descendant task counts up into a single entry per folder
 * path, so the Auto Run document dropdown can show a folder the same
 * "{pct}% ({total})" badge it shows a file.
 *
 * Only files that actually carry tasks contribute: a document missing from
 * `taskCounts`, or one whose `total` is 0, is ignored entirely rather than
 * counted as 0/0. A folder whose whole subtree has no tasks therefore gets no
 * entry at all, which is how the caller knows to render no badge.
 *
 * Counts are summed across the full subtree (nested folders included), so a
 * parent folder always reflects every playbook beneath it.
 */
export function aggregateFolderTaskCounts(
	tree: DocTreeNode[] | undefined,
	taskCounts: Map<string, DocumentTaskCount> | undefined
): Map<string, DocumentTaskCount> {
	const totals = new Map<string, DocumentTaskCount>();
	if (!tree || !taskCounts || taskCounts.size === 0) return totals;

	// Returns the subtree's counts so the parent can accumulate them without a
	// second walk.
	const walk = (node: DocTreeNode): DocumentTaskCount => {
		if (node.type === 'file') {
			const counts = taskCounts.get(node.path);
			if (!counts || counts.total === 0) return { completed: 0, total: 0 };
			return { completed: counts.completed, total: counts.total };
		}

		const sum: DocumentTaskCount = { completed: 0, total: 0 };
		for (const child of node.children ?? []) {
			const childCounts = walk(child);
			sum.completed += childCounts.completed;
			sum.total += childCounts.total;
		}
		if (sum.total > 0) totals.set(node.path, sum);
		return sum;
	};

	for (const node of tree) walk(node);
	return totals;
}

/** The percentage/total pair a "{pct}% ({total})" task badge renders. */
export interface TaskBadgeStats {
	pct: number;
	total: number;
}

/** Badge stats for one document or folder, or null when it has no tasks (no badge). */
export function toTaskBadgeStats(counts: DocumentTaskCount | undefined): TaskBadgeStats | null {
	if (!counts || counts.total === 0) return null;
	return {
		pct: Math.round((counts.completed / counts.total) * 100),
		total: counts.total,
	};
}

/** The badge's text: "{pct}% ({total})". */
export function formatTaskBadgeLabel(stats: TaskBadgeStats): string {
	return `${stats.pct}% (${stats.total})`;
}

/**
 * The longest badge label across every count map, so the dropdown can size
 * every badge to the widest one and their edges line up. With tabular digits
 * every label shares the same non-digit characters, so the longest string is
 * also the widest rendered one. Covers all entries, not only the visible rows,
 * so the width does not jump while the user filters or expands folders.
 * Returns '' when nothing has tasks.
 */
export function widestTaskBadgeLabel(
	countMaps: ReadonlyArray<Map<string, DocumentTaskCount> | undefined>
): string {
	let widest = '';
	for (const map of countMaps) {
		if (!map) continue;
		for (const counts of map.values()) {
			const stats = toTaskBadgeStats(counts);
			if (!stats) continue;
			const label = formatTaskBadgeLabel(stats);
			if (label.length > widest.length) widest = label;
		}
	}
	return widest;
}
