import type { Theme } from '../../../types';
import type { ConductorBadge } from '../../../constants/conductorBadges';

interface BadgeProgressToNextProps {
	theme: Theme;
	nextBadge: ConductorBadge | null;
	timeRemaining: string;
	progressPercent: number;
}

export function BadgeProgressToNext({
	theme,
	nextBadge,
	timeRemaining,
	progressPercent,
}: BadgeProgressToNextProps) {
	if (!nextBadge) return null;

	const clampedProgress = Math.max(0, Math.min(100, progressPercent));

	return (
		<div className="mb-4">
			<div className="flex items-center justify-between text-xs mb-1">
				<span style={{ color: theme.colors.textDim }}>Next: {nextBadge.shortName}</span>
				<span style={{ color: theme.colors.accent }}>{timeRemaining}</span>
			</div>
			<div
				className="h-2 rounded-full overflow-hidden"
				style={{ backgroundColor: theme.colors.bgMain }}
			>
				<div
					className="h-full rounded-full transition-all duration-500"
					style={{
						width: `${clampedProgress}%`,
						background: `linear-gradient(90deg, ${theme.colors.accent} 0%, #FFD700 100%)`,
					}}
				/>
			</div>
		</div>
	);
}
