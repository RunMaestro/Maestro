import { memo, useId, type ReactNode } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import type { Theme } from '../../types';
import { usePersistedToggle } from '../../hooks/ui/usePersistedToggle';

export type AutoRunNoticeSeverity = 'error' | 'warning';

export interface AutoRunNoticeBannerProps {
	theme: Theme;
	severity: AutoRunNoticeSeverity;
	/** Short bold heading, e.g. "Auto Run Paused" */
	title: string;
	/** Body content - plain text or rich nodes */
	children: ReactNode;
	/** Action buttons rendered under the body */
	actions?: ReactNode;
	/**
	 * localStorage key that makes the banner collapsible: the heading becomes a
	 * toggle that folds the body and actions away, and the choice survives a
	 * remount. Omit for a banner that is always fully shown.
	 */
	collapseKey?: string;
	/** Start collapsed the first time, before the user has chosen. */
	defaultCollapsed?: boolean;
}

/**
 * Shared banner shell for Auto Run notices. Owns the tinted card, the icon,
 * and the heading/body/actions rhythm so error and warning surfaces stay
 * visually identical apart from color.
 *
 * With `collapseKey` the heading turns into a disclosure button: a standing
 * advisory the author has already read shrinks to one line instead of pushing
 * the document out of view, and stays that way across re-renders.
 */
export const AutoRunNoticeBanner = memo(function AutoRunNoticeBanner({
	theme,
	severity,
	title,
	children,
	actions,
	collapseKey,
	defaultCollapsed = false,
}: AutoRunNoticeBannerProps) {
	const accent = severity === 'error' ? theme.colors.error : theme.colors.warning;
	const bodyId = useId();
	// The hook is unconditional (rules of hooks); the key only decides whether
	// its value is read. A stable placeholder keeps non-collapsible callers from
	// writing to storage.
	const { value: collapsed, toggle } = usePersistedToggle(
		collapseKey ?? 'autoRun.notice.unused',
		defaultCollapsed
	);
	const isCollapsible = Boolean(collapseKey);
	const isCollapsed = isCollapsible && collapsed;

	const heading = (
		<div className="text-xs font-semibold" style={{ color: accent }}>
			{title}
		</div>
	);

	return (
		<div
			role="alert"
			className="mx-2 mb-2 p-3 rounded-lg border"
			style={{
				backgroundColor: `${accent}15`,
				borderColor: accent,
			}}
		>
			<div className="flex items-start gap-2">
				<AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: accent }} />
				<div className="flex-1 min-w-0">
					{isCollapsible ? (
						<button
							type="button"
							onClick={toggle}
							aria-expanded={!isCollapsed}
							aria-controls={bodyId}
							className={`flex items-center gap-1 w-full text-left hover:opacity-80 transition-opacity ${
								isCollapsed ? '' : 'mb-1'
							}`}
							title={isCollapsed ? 'Show details' : 'Hide details'}
						>
							{isCollapsed ? (
								<ChevronRight className="w-3 h-3 flex-shrink-0" style={{ color: accent }} />
							) : (
								<ChevronDown className="w-3 h-3 flex-shrink-0" style={{ color: accent }} />
							)}
							{heading}
						</button>
					) : (
						<div className="mb-1">{heading}</div>
					)}
					{!isCollapsed && (
						<>
							<div id={bodyId} className="text-xs mb-2" style={{ color: theme.colors.textMain }}>
								{children}
							</div>
							{actions && <div className="flex gap-2 flex-wrap">{actions}</div>}
						</>
					)}
				</div>
			</div>
		</div>
	);
});
