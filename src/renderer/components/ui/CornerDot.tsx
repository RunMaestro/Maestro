/**
 * CornerDot - a small status dot pinned to the corner of whatever it sits in.
 *
 * The "unread" red pip over a status dot, over an icon, or over a count badge
 * had been hand-rolled at every site that needed one, and the copies had
 * already drifted on size and offset. Render this inside a `relative` parent
 * instead.
 *
 * The dot is decorative: it repeats something the parent already conveys, so
 * it stays out of the accessibility tree unless the caller supplies a `title`.
 */

import type { CSSProperties } from 'react';

export interface CornerDotProps {
	/** Fill color. Callers pass a theme color (error for unread, warning for busy). */
	color: string;
	/** Pulse for live activity. Steady means "waiting for you". */
	pulse?: boolean;
	/**
	 * 'sm' (6px) sits on a status dot or a small icon; 'md' (8px) needs the
	 * extra weight to read against a filled badge.
	 */
	size?: 'sm' | 'md';
	/**
	 * 'top-right' overlaps the parent's corner. 'right' hangs off the middle of
	 * the right edge, for parents too short to have a usable corner.
	 */
	placement?: 'top-right' | 'right';
	/** Native tooltip. Supplying one also exposes the dot to screen readers. */
	title?: string;
	/** Ring color, for a dot that would otherwise blend into what it sits on. */
	ringColor?: string;
}

const SIZE_CLASS: Record<NonNullable<CornerDotProps['size']>, string> = {
	sm: 'w-1.5 h-1.5',
	md: 'w-2 h-2',
};

const PLACEMENT_CLASS: Record<NonNullable<CornerDotProps['placement']>, string> = {
	'top-right': '-top-0.5 -right-0.5',
	right: 'top-1/2 -translate-y-1/2 -right-0.5',
};

export function CornerDot({
	color,
	pulse = false,
	size = 'sm',
	placement = 'top-right',
	title,
	ringColor,
}: CornerDotProps) {
	const style: CSSProperties = { backgroundColor: color };
	if (ringColor) style.boxShadow = `0 0 0 1.5px ${ringColor}`;
	// Deliberately NOT pointer-events-none: that would kill the `title` tooltip.
	// Clicks land on the dot but bubble to whatever it is pinned to, so a dot
	// over a clickable row still activates the row.
	return (
		<span
			className={`absolute rounded-full ${SIZE_CLASS[size]} ${PLACEMENT_CLASS[placement]}${
				pulse ? ' animate-pulse' : ''
			}`}
			style={style}
			title={title}
			aria-hidden={title ? undefined : true}
		/>
	);
}
