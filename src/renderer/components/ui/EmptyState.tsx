/**
 * EmptyState - Full-featured empty-state primitive
 *
 * Renders a centered layout with an optional icon, title (h3), description,
 * primary and secondary action buttons, and an optional inline help link.
 *
 * Used by Agent Dispatch, Living Wiki, Delivery Planner, and any surface that
 * needs a consistent "nothing here yet" treatment. Theme-aware via inline styles.
 *
 * Usage:
 * ```tsx
 * <EmptyState
 *   theme={theme}
 *   icon={<Inbox className="w-10 h-10" />}
 *   title="No tasks yet"
 *   description="Create your first task to get started."
 *   primaryAction={{ label: 'Create Task', onClick: handleCreate }}
 *   helpHref="https://docs.runmaestro.ai/tasks"
 *   helpLabel="Learn more"
 * />
 * ```
 */

import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import type { Theme } from '../../types';

export interface EmptyStateAction {
	label: string;
	onClick: () => void;
}

export interface EmptyStateProps {
	/** Theme object for styling */
	theme: Theme;
	/** Optional icon element (caller sets size). Rendered with reduced opacity. */
	icon?: ReactNode;
	/** Primary heading text */
	title: string;
	/** Secondary descriptive text */
	description?: string;
	/** Primary call-to-action button */
	primaryAction?: EmptyStateAction;
	/** Secondary / alternative action button */
	secondaryAction?: EmptyStateAction;
	/** URL opened (via window.open) when the help link is clicked */
	helpHref?: string;
	/** Label for the help link. Defaults to "Learn more" */
	helpLabel?: string;
	/** Additional class names on the outer container */
	className?: string;
}

export function EmptyState({
	theme,
	icon,
	title,
	description,
	primaryAction,
	secondaryAction,
	helpHref,
	helpLabel = 'Learn more',
	className = '',
}: EmptyStateProps) {
	return (
		<div
			className={`flex flex-col items-center justify-center py-12 px-4 text-center ${className}`.trim()}
		>
			{icon && (
				<div className="mb-4 opacity-30" aria-hidden="true" style={{ color: theme.colors.textDim }}>
					{icon}
				</div>
			)}

			<h3 className="text-base font-semibold mb-1" style={{ color: theme.colors.textMain }}>
				{title}
			</h3>

			{description && (
				<p className="text-sm max-w-sm mt-1" style={{ color: theme.colors.textDim }}>
					{description}
				</p>
			)}

			{(primaryAction || secondaryAction) && (
				<div className="flex items-center gap-3 mt-5">
					{primaryAction && (
						<button
							type="button"
							onClick={primaryAction.onClick}
							className="px-4 py-2 rounded-md text-sm font-medium transition-opacity hover:opacity-90"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.accentForeground,
							}}
						>
							{primaryAction.label}
						</button>
					)}
					{secondaryAction && (
						<button
							type="button"
							onClick={secondaryAction.onClick}
							className="px-4 py-2 rounded-md text-sm font-medium transition-opacity hover:opacity-80 border"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textDim,
							}}
						>
							{secondaryAction.label}
						</button>
					)}
				</div>
			)}

			{helpHref && (
				<a
					href={helpHref}
					onClick={(e) => {
						e.preventDefault();
						void window.maestro.shell?.openExternal?.(helpHref);
					}}
					className="inline-flex items-center gap-1 mt-4 text-xs transition-opacity hover:opacity-80 cursor-pointer"
					style={{ color: theme.colors.accent }}
				>
					{helpLabel}
					<ExternalLink className="w-3 h-3" aria-hidden="true" />
				</a>
			)}
		</div>
	);
}

export default EmptyState;
