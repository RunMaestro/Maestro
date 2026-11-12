import { ChevronDown } from 'lucide-react';
import type { Theme } from '../../../../../types';
import type { StatsTimeRange, WakatimeSettingsState } from '../types';
import { WakatimeSettings } from './WakatimeSettings';

interface UsageStatsSectionProps {
	theme: Theme;
	defaultStatsTimeRange: StatsTimeRange;
	setDefaultStatsTimeRange: (range: StatsTimeRange) => void;
	wakatimeEnabled: boolean;
	setWakatimeEnabled: (enabled: boolean) => void;
	wakatimeApiKey: string;
	wakatimeDetailedTracking: boolean;
	setWakatimeDetailedTracking: (enabled: boolean) => void;
	wakatimeState: WakatimeSettingsState;
}

/**
 * Usage & Stats config BODY (extension detail pane, Settings tab). Chromeless:
 * the detail-pane header carries the title/state/enable toggle.
 */
export function UsageStatsSection({
	theme,
	defaultStatsTimeRange,
	setDefaultStatsTimeRange,
	wakatimeEnabled,
	setWakatimeEnabled,
	wakatimeApiKey,
	wakatimeDetailedTracking,
	setWakatimeDetailedTracking,
	wakatimeState,
}: UsageStatsSectionProps) {
	return (
		<div data-setting-id="encore-usage-stats" className="space-y-3">
			<div className="flex items-center justify-between">
				<p className="text-sm" style={{ color: theme.colors.textMain }}>
					Default lookback window
				</p>
				<div className="relative">
					<select
						value={defaultStatsTimeRange}
						onChange={(event) => setDefaultStatsTimeRange(event.target.value as StatsTimeRange)}
						className="appearance-none text-sm px-3 py-1.5 pr-8 rounded-lg border cursor-pointer"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						aria-label="Select default lookback window"
					>
						<option value="day">Today</option>
						<option value="week">This Week</option>
						<option value="month">This Month</option>
						<option value="quarter">This Quarter</option>
						<option value="year">This Year</option>
						<option value="all">All Time</option>
					</select>
					<ChevronDown
						className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
						style={{ color: theme.colors.textDim }}
					/>
				</div>
			</div>

			<div className="border-t" style={{ borderColor: theme.colors.border }} />

			<WakatimeSettings
				theme={theme}
				wakatimeEnabled={wakatimeEnabled}
				setWakatimeEnabled={setWakatimeEnabled}
				wakatimeApiKey={wakatimeApiKey}
				wakatimeDetailedTracking={wakatimeDetailedTracking}
				setWakatimeDetailedTracking={setWakatimeDetailedTracking}
				wakatimeState={wakatimeState}
			/>
		</div>
	);
}
