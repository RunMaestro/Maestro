/**
 * GitChangeCounts - the `+206 −37 ~5` readout for a working tree.
 *
 * One component behind every surface that reports uncommitted changes: the
 * header git status widget, the header branch pill menu, and the Left Bar
 * right-click menu. Keeping it shared is what makes "is there a diff?" look the
 * same wherever it's asked.
 *
 * Line-level counts only exist for the active agent (git status polling skips
 * numstat for the others), so when they're all zero but files did change this
 * degrades to a plain changed-file count rather than rendering nothing.
 */

import { memo } from 'react';
import { FileDiff, FileEdit, Minus, Plus } from 'lucide-react';
import type { GitChangeTotals } from '../../../shared/gitUtils';
import type { Theme } from '../../types';

export interface GitChangeCountsProps {
	theme: Theme;
	/** Change totals for the agent's working tree. */
	totals: GitChangeTotals;
	/** Wrapper classes, for spacing/alignment at the call site. */
	className?: string;
	/** Icon sizing, so a menu badge can be smaller than the header widget. */
	iconClassName?: string;
}

export const GitChangeCounts = memo(function GitChangeCounts({
	theme,
	totals,
	className = 'flex items-center gap-2',
	iconClassName = 'w-3 h-3',
}: GitChangeCountsProps) {
	const { fileCount, additions, deletions, modified } = totals;
	if (fileCount <= 0) return null;

	// Fallback readout: files changed, but nobody counted the lines.
	if (additions === 0 && deletions === 0 && modified === 0) {
		return (
			<span className={className} data-testid="git-change-counts">
				<span className="flex items-center gap-0.5" style={{ color: theme.colors.textDim }}>
					<FileDiff className={iconClassName} />
					{fileCount}
				</span>
			</span>
		);
	}

	return (
		<span className={className} data-testid="git-change-counts">
			{additions > 0 && (
				<span className="flex items-center gap-0.5 text-green-500">
					<Plus className={iconClassName} />
					{additions}
				</span>
			)}
			{deletions > 0 && (
				<span className="flex items-center gap-0.5 text-red-500">
					<Minus className={iconClassName} />
					{deletions}
				</span>
			)}
			{modified > 0 && (
				<span className="flex items-center gap-0.5 text-orange-500">
					<FileEdit className={iconClassName} />
					{modified}
				</span>
			)}
		</span>
	);
});

export default GitChangeCounts;
