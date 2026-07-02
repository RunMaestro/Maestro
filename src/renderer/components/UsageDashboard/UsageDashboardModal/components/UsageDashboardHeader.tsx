import { BarChart3, Calendar, Download, X } from 'lucide-react';
import type { StatsTimeRange } from '../../../../../shared/stats-types';
import { AchievementShareButton } from '../../../AchievementShareButton';
import { TIME_RANGE_OPTIONS } from '../constants';
import type { UsageDashboardModalProps } from '../types';

interface UsageDashboardHeaderProps {
	theme: UsageDashboardModalProps['theme'];
	showNewDataIndicator: boolean;
	timeRange: StatsTimeRange;
	onTimeRangeChange: (timeRange: StatsTimeRange) => void;
	onExport: () => void;
	isExporting: boolean;
	onClose: () => void;
	autoRunStats: UsageDashboardModalProps['autoRunStats'];
	globalStats: UsageDashboardModalProps['globalStats'];
	usageStats: UsageDashboardModalProps['usageStats'];
	handsOnTimeMs: UsageDashboardModalProps['handsOnTimeMs'];
	leaderboardRegistration: UsageDashboardModalProps['leaderboardRegistration'];
}

export function UsageDashboardHeader({
	theme,
	showNewDataIndicator,
	timeRange,
	onTimeRangeChange,
	onExport,
	isExporting,
	onClose,
	autoRunStats,
	globalStats,
	usageStats,
	handsOnTimeMs,
	leaderboardRegistration,
}: UsageDashboardHeaderProps) {
	return (
		<div
			className="px-6 py-4 border-b flex items-center justify-between flex-shrink-0"
			style={{ borderColor: theme.colors.border }}
		>
			<div className="flex items-center gap-3">
				<BarChart3 className="w-5 h-5" style={{ color: theme.colors.accent }} />
				<h2 className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
					Usage Dashboard
				</h2>
				{showNewDataIndicator && (
					<div
						className="flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium"
						style={{
							backgroundColor: `${theme.colors.accent}20`,
							color: theme.colors.accent,
							animation: 'pulse-fade 3s ease-out forwards',
						}}
						data-testid="new-data-indicator"
					>
						<span
							className="w-2 h-2 rounded-full"
							style={{
								backgroundColor: theme.colors.accent,
								animation: 'pulse-dot 1s ease-in-out 3',
							}}
						/>
						Updated
					</div>
				)}
			</div>

			<div className="flex items-center gap-3">
				<div className="relative flex items-center">
					<Calendar
						className="w-4 h-4 absolute left-2.5 pointer-events-none"
						style={{ color: theme.colors.textDim }}
					/>
					<select
						value={timeRange}
						onChange={(event) => onTimeRangeChange(event.target.value as StatsTimeRange)}
						className="pl-8 pr-6 py-1.5 rounded text-sm border cursor-pointer outline-none appearance-none"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					>
						{TIME_RANGE_OPTIONS.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
					<div
						className="absolute right-2 pointer-events-none"
						style={{ color: theme.colors.textDim }}
					>
						<svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor">
							<path
								d="M1 1L5 5L9 1"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
								fill="none"
							/>
						</svg>
					</div>
				</div>

				<button
					onClick={onExport}
					className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm hover:bg-opacity-10 transition-colors"
					style={{
						color: theme.colors.textMain,
						backgroundColor: `${theme.colors.accent}15`,
					}}
					onMouseEnter={(event) =>
						(event.currentTarget.style.backgroundColor = `${theme.colors.accent}25`)
					}
					onMouseLeave={(event) =>
						(event.currentTarget.style.backgroundColor = `${theme.colors.accent}15`)
					}
					disabled={isExporting}
				>
					<Download className={`w-4 h-4 ${isExporting ? 'animate-pulse' : ''}`} />
					Export CSV
				</button>

				{autoRunStats && (
					<AchievementShareButton
						theme={theme}
						autoRunStats={autoRunStats}
						globalStats={globalStats}
						usageStats={usageStats}
						handsOnTimeMs={handsOnTimeMs}
						leaderboardRegistration={leaderboardRegistration}
						variant="header"
						title="Share achievements"
					/>
				)}

				<button
					onClick={onClose}
					className="p-1.5 rounded hover:bg-opacity-10 transition-colors"
					style={{ color: theme.colors.textDim }}
					onMouseEnter={(event) =>
						(event.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
					}
					onMouseLeave={(event) => (event.currentTarget.style.backgroundColor = 'transparent')}
					title="Close (Esc)"
				>
					<X className="w-4 h-4" />
				</button>
			</div>
		</div>
	);
}
