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
