/**
 * EmptyStatePlaceholder - Generic "No X" placeholder
 *
 * Displays a centered icon + title + optional description. Used wherever a list
 * or pane has nothing to show (no results, no selection, no data yet).
 *
 * Distinct from the top-level `EmptyStateView` which is the full welcome screen.
 *
 * Usage:
 * ```tsx
 * <EmptyStatePlaceholder
 *   theme={theme}
 *   icon={<List className="w-12 h-12" />}
 *   title="No sessions match your search"
 * />
 *
 * <EmptyStatePlaceholder
 *   theme={theme}
 *   icon={<Search className="w-10 h-10" />}
 *   title="No matches"
 *   description="Try adjusting your filters."
 *   action={<button onClick={reset}>Clear filters</button>}
 * />
 * ```
 */

import type { ReactNode } from 'react';
import type { Theme } from '../../types';

export interface EmptyStatePlaceholderProps {
	/** Theme object for styling */
	theme: Theme;
	/** Optional icon element (caller sets size). Rendered with reduced opacity. */
	icon?: ReactNode;
	/** Primary message */
	title: string;
	/** Secondary message / extra context */
	description?: string;
	/** Optional action element (e.g. a button) rendered below the description */
	action?: ReactNode;
	/** Vertical padding tailwind utility. Defaults to 'py-12' */
	verticalPadding?: string;
	/** Horizontal padding tailwind utility. Defaults to 'px-4' */
	horizontalPadding?: string;
	/** Additional class names for the outer container */
	className?: string;
}

export function EmptyStatePlaceholder({
	theme,
	icon,
	title,
	description,
	action,
	verticalPadding = 'py-12',
	horizontalPadding = 'px-4',
	className = '',
}: EmptyStatePlaceholderProps) {
	return (
		<div
			className={`flex flex-col items-center justify-center ${verticalPadding} ${horizontalPadding} ${className}`.trim()}
		>
			{icon && (
				<div className="mb-4 opacity-30" style={{ color: theme.colors.textDim }}>
					{icon}
				</div>
			)}
			<p className="text-sm text-center" style={{ color: theme.colors.textDim }}>
				{title}
			</p>
			{description && (
				<p className="text-xs text-center mt-2 max-w-md" style={{ color: theme.colors.textDim }}>
					{description}
				</p>
			)}
			{action && <div className="mt-4">{action}</div>}
		</div>
	);
}

export default EmptyStatePlaceholder;
