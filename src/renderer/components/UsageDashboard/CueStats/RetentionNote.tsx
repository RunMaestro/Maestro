/**
 * RetentionNote - the Cue tab's caption about how far back its data goes.
 *
 * Cue runs live in `cue_events`, which the engine prunes to the user's
 * retention setting (`cueHistoryRetentionDays`, default 14 days). Every
 * range longer than that shows the same retained window, so the tab says so
 * instead of letting "Last 365 Days" silently mean "last 14 days".
 */

import { memo } from 'react';
import { History } from 'lucide-react';
import type { Theme } from '../../../types';
import type { StatsTimeRange } from '../../../../shared/stats-types';
import { STATS_RANGE_DAYS } from '../../../../shared/statsTimeRange';
import {
	formatCueHistoryRetention,
	resolveCueHistoryRetentionDays,
} from '../../../../shared/cue/retention';
import { useSettingsStore } from '../../../stores/settingsStore';

/** Whether `range` reaches further back than `retentionDays` of history. */
export function rangeExceedsRetention(range: StatsTimeRange, retentionDays: number): boolean {
	return range === 'all' || STATS_RANGE_DAYS[range] > retentionDays;
}

export const RetentionNote = memo(function RetentionNote({
	timeRange,
	theme,
}: {
	timeRange: StatsTimeRange;
	theme: Theme;
}) {
	const retentionDays = resolveCueHistoryRetentionDays(
		useSettingsStore((s) => s.cueHistoryRetentionDays)
	);
	const kept = formatCueHistoryRetention(retentionDays);
	const exceeds = rangeExceedsRetention(timeRange, retentionDays);

	return (
		<div
			className="flex items-start gap-2 px-3 py-2 rounded-lg text-xs"
			style={{
				backgroundColor: theme.colors.bgMain,
				color: exceeds ? theme.colors.warning : theme.colors.textDim,
			}}
			role="note"
			data-testid="cue-stats-retention"
			data-exceeds={exceeds ? 'true' : 'false'}
		>
			<History className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
			<span>
				{exceeds
					? `Cue keeps ${kept} of run history, so this range only shows the last ${kept}. Change the retention in the Cue Activity Log.`
					: `Cue keeps ${kept} of run history (set in the Cue Activity Log).`}
			</span>
		</div>
	);
});
