import { Clock, Trophy, Zap } from 'lucide-react';
import type { Theme } from '../../../types';

interface BadgeStatsGridProps {
	theme: Theme;
	cumulativeTimeFormatted: string;
	longestRunFormatted: string;
	totalRuns: number;
}

export function BadgeStatsGrid({
	theme,
	cumulativeTimeFormatted,
	longestRunFormatted,
	totalRuns,
}: BadgeStatsGridProps) {
	return (
		<div className="grid grid-cols-3 gap-2 mb-4">
			<div className="text-center p-2 rounded" style={{ backgroundColor: theme.colors.bgMain }}>
				<div className="flex items-center justify-center gap-1 mb-1">
					<Clock className="w-3 h-3" style={{ color: theme.colors.textDim }} />
				</div>
				<div className="text-xs font-mono font-bold" style={{ color: theme.colors.textMain }}>
					{cumulativeTimeFormatted}
				</div>
				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					Total Time
				</div>
			</div>

			<div className="text-center p-2 rounded" style={{ backgroundColor: theme.colors.bgMain }}>
				<div className="flex items-center justify-center gap-1 mb-1">
					<Trophy className="w-3 h-3" style={{ color: '#FFD700' }} />
				</div>
				<div className="text-xs font-mono font-bold" style={{ color: theme.colors.textMain }}>
					{longestRunFormatted}
				</div>
				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					Longest Run
				</div>
			</div>

			<div className="text-center p-2 rounded" style={{ backgroundColor: theme.colors.bgMain }}>
				<div className="flex items-center justify-center gap-1 mb-1">
					<Zap className="w-3 h-3" style={{ color: theme.colors.accent }} />
				</div>
				<div className="text-xs font-mono font-bold" style={{ color: theme.colors.textMain }}>
					{totalRuns}
				</div>
				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					Total Runs
				</div>
			</div>
		</div>
	);
}
