/**
 * MiniBadge - the tiny uppercase text chip that tags an item's state.
 *
 * "WT" beside a worktree agent, "Active" / "Snoozed" beside a tab. The generic
 * text counterpart to `CountBadge`, which says a number and nothing else, and
 * to the domain pills beside it (`WorktreePill`, `GitRunningBadge`) that say
 * one fixed word with their own colors.
 *
 * It exists because the same `text-3xs px-1 rounded uppercase` span was being
 * written per surface: the Usage Dashboard's tiles carried one copy and the
 * per-tab list needed the identical chip, which is exactly the point where the
 * two start drifting on padding and weight.
 *
 * The label is rendered as given and is its own accessible name, so pass a real
 * word ("Snoozed"), not an abbreviation the reader has to decode - unless the
 * abbreviation is the established UI term, in which case pass `title` with the
 * long form.
 */

import type { CSSProperties } from 'react';
import type { Theme } from '../../types';

export interface MiniBadgeProps {
	/** Short label, rendered uppercase via CSS (the string itself is untouched). */
	label: string;
	theme: Theme;
	/** Chip color, used for both the text and its translucent fill. Defaults to
	 *  the theme accent. */
	color?: string;
	/** Hover tooltip, e.g. the long form of an abbreviated label. */
	title?: string;
	className?: string;
	style?: CSSProperties;
	testId?: string;
}

export function MiniBadge({
	label,
	theme,
	color,
	title,
	className = '',
	style,
	testId,
}: MiniBadgeProps) {
	const tint = color ?? theme.colors.accent;
	return (
		<span
			className={`flex-shrink-0 px-1 py-0.5 rounded text-3xs font-bold uppercase tracking-wide ${className}`}
			style={{ backgroundColor: `${tint}20`, color: tint, ...style }}
			title={title}
			data-testid={testId}
		>
			{label}
		</span>
	);
}

export default MiniBadge;
