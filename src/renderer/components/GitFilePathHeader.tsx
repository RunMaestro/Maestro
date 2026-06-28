import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import type { Theme } from '../types';

interface GitFilePathHeaderProps {
	theme: Theme;
	/** Label content (the file path text). Callers keep their own path rendering. */
	children: ReactNode;
	/**
	 * Click handler that opens the file as a preview tab. When omitted the header
	 * renders as a plain, non-interactive label (e.g. for deleted files that can
	 * no longer be opened).
	 */
	onOpen?: () => void;
	/** Tooltip / aria-label, e.g. "Open WWW/.../dashboard.css in a preview tab". */
	title?: string;
	/** Extra classes for the outer container (callers use different margins). */
	className?: string;
}

/**
 * Clickable file-path header shared by the Git Diff and Git Log viewers. When
 * `onOpen` is supplied, clicking the header dismisses the surrounding modal and
 * opens the file as a preview tab (handled by the caller). The frosted-card look
 * matches the previous static header so existing diffs render unchanged.
 */
export function GitFilePathHeader({
	theme,
	children,
	onOpen,
	title,
	className = '',
}: GitFilePathHeaderProps) {
	const baseClasses = `${className} p-2 rounded font-semibold text-xs`;

	if (!onOpen) {
		return (
			<div
				className={baseClasses}
				style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
			>
				{children}
			</div>
		);
	}

	return (
		<button
			type="button"
			onClick={onOpen}
			title={title}
			className={`${baseClasses} group flex w-full items-center gap-1.5 text-left transition-colors cursor-pointer hover:underline`}
			style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
		>
			<ExternalLink
				className="w-3 h-3 shrink-0 opacity-50 transition-opacity group-hover:opacity-100"
				style={{ color: theme.colors.accent }}
			/>
			<span className="min-w-0 truncate">{children}</span>
		</button>
	);
}
