import { Trophy } from 'lucide-react';
import type { AchievementCardProps } from '../types';
import { AchievementShareButton } from '../../AchievementShareButton';

export function AchievementCardHeader({
	theme,
	autoRunStats,
	globalStats,
	usageStats,
	handsOnTimeMs,
	leaderboardRegistration,
}: AchievementCardProps) {
	return (
		<div className="flex items-center justify-between mb-3">
			<div className="flex items-center gap-2">
				<Trophy className="w-4 h-4" style={{ color: '#FFD700' }} />
				<span className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
					Maestro Achievements
				</span>
			</div>

			<AchievementShareButton
				theme={theme}
				autoRunStats={autoRunStats}
				globalStats={globalStats}
				usageStats={usageStats}
				handsOnTimeMs={handsOnTimeMs}
				leaderboardRegistration={leaderboardRegistration}
			/>
		</div>
	);
}
