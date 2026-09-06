/**
 * UsageDashboardFooter
 *
 * The dashboard's status bar: what range is loaded (left), a per-tab readout of
 * what you are actually looking at (center), and the escape hatch (right).
 *
 * Split out of the modal because the center slot reads the footer-summary
 * context, and a component cannot consume a context it provides itself.
 *
 * Laid out as three equal columns rather than a flex row so the center line is
 * centered against the WINDOW, not against whatever the left cell happens to
 * weigh once the database-size chip appears. Every cell truncates, so a long
 * summary is clipped instead of shoving the Esc hint off the edge.
 */

import { memo } from 'react';
import { Database } from 'lucide-react';
import type { Theme } from '../../types';
import type { FooterSummaryTab } from './footerSummary';
import { usePublishedFooterSummary } from './useFooterSummary';

interface UsageDashboardFooterProps {
	theme: Theme;
	/** Tab currently on screen - selects which published summary to show. */
	viewMode: FooterSummaryTab;
	/** Left-hand range label, e.g. "Showing this month data". */
	rangeLabel: string;
	/**
	 * Summary for tabs the modal itself describes. A panel-published summary
	 * wins: the panel owns the data, so it knows about filters and fetches the
	 * modal cannot see.
	 */
	fallbackSummary: string | null;
	/** Formatted stats database size, or null while unknown. */
	databaseSizeLabel: string | null;
}

export const UsageDashboardFooter = memo(function UsageDashboardFooter({
	theme,
	viewMode,
	rangeLabel,
	fallbackSummary,
	databaseSizeLabel,
}: UsageDashboardFooterProps) {
	const published = usePublishedFooterSummary(viewMode);
	const summary = published ?? fallbackSummary;

	return (
		<div
			className="px-6 py-3 border-t grid grid-cols-3 items-center gap-4 text-xs flex-shrink-0"
			style={{
				borderColor: theme.colors.border,
				color: theme.colors.textDim,
			}}
		>
			<div className="flex items-center gap-4 min-w-0">
				<span className="truncate">{rangeLabel}</span>
				{databaseSizeLabel && (
					<span
						className="flex items-center gap-1 flex-shrink-0"
						style={{ opacity: 0.7 }}
						title="Stats database size"
						data-testid="database-size-indicator"
					>
						<Database className="w-3 h-3" />
						{databaseSizeLabel}
					</span>
				)}
			</div>

			<div className="min-w-0 text-center">
				{summary && (
					<span
						className="truncate inline-block max-w-full"
						style={{ opacity: 0.85 }}
						title={summary}
						data-testid="usage-dashboard-footer-summary"
					>
						{summary}
					</span>
				)}
			</div>

			<div className="min-w-0 text-right">
				<span className="truncate inline-block max-w-full" style={{ opacity: 0.7 }}>
					Press Esc to close
				</span>
			</div>
		</div>
	);
});

export default UsageDashboardFooter;
