/**
 * CountBadge - a small numeric pill for "how many things are in here".
 *
 * The generic counterpart to the domain badges beside it: `WorktreePill` says
 * one fixed word, `GitChangeCounts` says added/removed with git's own colors.
 * This one says a number and nothing else, so any surface that needs "3" on a
 * chip can use it instead of hand-rolling another `text-3xs px-1 rounded`
 * span. First consumer is the tab-group chip's panel count.
 *
 * Two deliberate choices:
 *
 * - **It always renders, including at zero.** Whether a zero is worth showing
 *   is the caller's judgement, not this component's. Callers that want it gone
 *   should not render it - but reach for `{count > 0 && <CountBadge .../>}`
 *   rather than `{count && ...}`, which paints a bare `0` in the DOM.
 * - **`label` is required.** A screen reader hitting a bare "3" learns nothing,
 *   so the count is announced as "3 panels" via `aria-label` and shown on hover
 *   as a `title`. Pass the singular noun; the component handles the plural.
 */

import type { CSSProperties } from 'react';
import type { Theme } from '../../types';

export interface CountBadgeProps {
	/** The number to display. Rendered as-is, including 0. */
	count: number;
	theme: Theme;
	/**
	 * Singular noun for what is being counted ("panel", "tab", "member"). Used
	 * to build the accessible name and the hover title; never rendered as text.
	 */
	label: string;
	/**
	 * Cap the displayed value, e.g. `max={99}` renders `99+` for 250. The
	 * accessible name still carries the true count. Omit for no cap.
	 */
	max?: number;
	className?: string;
	style?: CSSProperties;
	'data-testid'?: string;
}

/** Pluralize by the count, good enough for the nouns this badge takes. */
function describe(count: number, label: string): string {
	return `${count} ${label}${count === 1 ? '' : 's'}`;
}

export function CountBadge({
	count,
	theme,
	label,
	max,
	className,
	style,
	'data-testid': testId,
}: CountBadgeProps) {
	const capped = max !== undefined && count > max;
	const display = capped ? `${max}+` : `${count}`;
	const description = describe(count, label);

	return (
		<span
			className={`text-3xs font-medium tabular-nums px-1 py-0.5 rounded shrink-0 ${
				className ?? ''
			}`}
			style={{
				backgroundColor: theme.colors.accent + '33',
				border: `1px solid ${theme.colors.accent}66`,
				color: theme.colors.accent,
				...style,
			}}
			aria-label={description}
			title={description}
			data-testid={testId}
		>
			{display}
		</span>
	);
}

export default CountBadge;
