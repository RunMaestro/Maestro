import { memo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Theme } from '../../types';

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
}

/**
 * Shared banner shell for Auto Run notices. Owns the tinted card, the icon,
 * and the heading/body/actions rhythm so error and warning surfaces stay
 * visually identical apart from color.
 */
export const AutoRunNoticeBanner = memo(function AutoRunNoticeBanner({
	theme,
	severity,
	title,
	children,
	actions,
}: AutoRunNoticeBannerProps) {
	const accent = severity === 'error' ? theme.colors.error : theme.colors.warning;

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
					<div className="text-xs font-semibold mb-1" style={{ color: accent }}>
						{title}
					</div>
					<div className="text-xs mb-2" style={{ color: theme.colors.textMain }}>
						{children}
					</div>
					{actions && <div className="flex gap-2 flex-wrap">{actions}</div>}
				</div>
			</div>
		</div>
	);
});
