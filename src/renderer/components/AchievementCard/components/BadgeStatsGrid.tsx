import type { ReactNode } from 'react';
import { Clock, Radio, Trophy, Zap } from 'lucide-react';
import type { Theme } from '../../../types';

interface BadgeStatsGridProps {
	theme: Theme;
	cumulativeTimeFormatted: string;
	cueTimeFormatted: string;
	autoRunTimeFormatted: string;
	cueSharePercent: number;
	longestRunFormatted: string;
	totalRuns: number;
}

interface StatTileProps {
	theme: Theme;
	icon: ReactNode;
	value: string;
	label: string;
	/** Native tooltip for tiles that need a word of explanation */
	title?: string;
}

function StatTile({ theme, icon, value, label, title }: StatTileProps) {
	return (
		<div
			className="text-center p-2 rounded"
			style={{ backgroundColor: theme.colors.bgMain }}
			title={title}
		>
			<div className="flex items-center justify-center gap-1 mb-1">{icon}</div>
			<div className="text-xs font-mono font-bold" style={{ color: theme.colors.textMain }}>
				{value}
			</div>
			<div className="text-xs" style={{ color: theme.colors.textDim }}>
				{label}
			</div>
		</div>
	);
}

export function BadgeStatsGrid({
	theme,
	cumulativeTimeFormatted,
	cueTimeFormatted,
	autoRunTimeFormatted,
	cueSharePercent,
	longestRunFormatted,
	totalRuns,
}: BadgeStatsGridProps) {
	// Fixed 4 columns rather than a `lg:` breakpoint: Tailwind breakpoints key off
	// the viewport, not this card's container, so a breakpoint here would reflow
	// the tiles on window resize while the card itself stayed the same width.
	return (
		<div className="grid grid-cols-4 gap-2 mb-4">
			<StatTile
				theme={theme}
				icon={<Clock className="w-3 h-3" style={{ color: theme.colors.textDim }} />}
				value={cumulativeTimeFormatted}
				label="Total Time"
				title={`Auto Run ${autoRunTimeFormatted} + Cue ${cueTimeFormatted}`}
			/>

			<StatTile
				theme={theme}
				icon={<Radio className="w-3 h-3" style={{ color: theme.colors.accent }} />}
				value={cueTimeFormatted}
				label={`Cue Time (${cueSharePercent}%)`}
				title={`Autonomous Cue time, counted inside Total Time. The other ${autoRunTimeFormatted} came from Auto Run. Cue time is tracked separately starting with this release, so earlier Cue runs still count toward Auto Run.`}
			/>

			<StatTile
				theme={theme}
				icon={<Trophy className="w-3 h-3" style={{ color: '#FFD700' }} />}
				value={longestRunFormatted}
				label="Longest Run"
			/>

			<StatTile
				theme={theme}
				icon={<Zap className="w-3 h-3" style={{ color: theme.colors.accent }} />}
				value={String(totalRuns)}
				label="Total Runs"
			/>
		</div>
	);
}
