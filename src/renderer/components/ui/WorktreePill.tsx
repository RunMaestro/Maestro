/**
 * WorktreePill — small pill badge marking a worktree child agent.
 *
 * Used in two places:
 *   1. The left-panel agent list (`SessionItem.tsx`), gated by `showWorktreePill`.
 *   2. The Display settings panel, where it visually previews what the toggle
 *      controls.
 *
 * Keep this in sync with the historical inline JSX in `SessionItem.tsx` so the
 * settings preview matches the actual badge users see in the sidebar.
 */

import type { CSSProperties } from 'react';
import type { Theme } from '../../types';

interface WorktreePillProps {
	theme: Theme;
	className?: string;
	style?: CSSProperties;
}

export function WorktreePill({ theme, className, style }: WorktreePillProps) {
	return (
		<span
			className={`text-[9px] font-medium uppercase tracking-wider px-1 py-0.5 rounded shrink-0 ${
				className ?? ''
			}`}
			style={{
				backgroundColor: theme.colors.accent + '33',
				border: `1px solid ${theme.colors.accent}66`,
				color: theme.colors.accent,
				...style,
			}}
		>
			Worktree
		</span>
	);
}

export default WorktreePill;
