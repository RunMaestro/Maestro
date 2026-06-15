import { useState } from 'react';
import { ChevronDown, History } from 'lucide-react';
import type { AutoRunStats, Theme } from '../../../types';
import { getBadgeHistoryRows, shouldShowBadgeHistory } from '../utils/badgeHistory';
import { getProgressionSegmentColor } from '../utils/badgeStyles';

interface BadgeHistoryTimelineProps {
	theme: Theme;
	badgeHistory: AutoRunStats['badgeHistory'];
}

export function BadgeHistoryTimeline({ theme, badgeHistory }: BadgeHistoryTimelineProps) {
	const [historyExpanded, setHistoryExpanded] = useState(false);

	if (!shouldShowBadgeHistory(badgeHistory)) {
		return null;
	}

	const rows = getBadgeHistoryRows(badgeHistory);

	return (
		<div className="mt-3">
			<button
				onClick={() => setHistoryExpanded((current) => !current)}
				className="flex items-center gap-1.5 text-xs w-full hover:opacity-80 transition-opacity"
				style={{ color: theme.colors.textDim }}
			>
				<History className="w-3 h-3" />
				<span>Path to the Podium: Timeline</span>
				<ChevronDown
					className={`w-3 h-3 ml-auto transition-transform duration-200 ${
						historyExpanded ? 'rotate-180' : ''
					}`}
				/>
			</button>
			{historyExpanded && (
				<div
					className="mt-2 p-2 rounded space-y-1.5 max-h-32 overflow-y-auto"
					style={{ backgroundColor: theme.colors.bgMain }}
				>
					{rows.map((row, index) => (
						<div
							key={`${row.level}-${index}`}
							className="flex items-center justify-between text-xs"
						>
							<div className="flex items-center gap-2">
								<div
									className="w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold"
									style={{
										background: getProgressionSegmentColor(row.badge.level, true, theme),
										color: '#000',
									}}
								>
									{row.badge.level}
								</div>
								<span style={{ color: theme.colors.textMain }}>{row.badge.shortName}</span>
							</div>
							<span style={{ color: theme.colors.textDim }}>{row.dateLabel}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
