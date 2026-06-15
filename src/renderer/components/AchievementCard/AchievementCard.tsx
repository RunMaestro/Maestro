import type { AchievementCardShellProps } from './types';
import { useBadgeTooltipState } from './hooks/useBadgeTooltipState';
import { createAchievementCardViewModel } from './utils/achievementCardViewModel';
import {
	AchievementCardHeader,
	BadgeHero,
	BadgeHistoryTimeline,
	BadgeProgressionBar,
	BadgeProgressToNext,
	BadgeStatsGrid,
	MaxLevelCelebration,
} from './components';

export function AchievementCard({
	theme,
	autoRunStats,
	globalStats,
	usageStats,
	handsOnTimeMs,
	leaderboardRegistration,
	onEscapeWithBadgeOpen,
}: AchievementCardShellProps) {
	const viewModel = createAchievementCardViewModel(autoRunStats);
	const { selectedBadge, badgeContainerRef, toggleBadge } =
		useBadgeTooltipState(onEscapeWithBadgeOpen);

	return (
		<div
			className="p-4 rounded border"
			style={{
				borderColor: theme.colors.border,
				backgroundColor: theme.colors.bgActivity,
			}}
		>
			<AchievementCardHeader
				theme={theme}
				autoRunStats={autoRunStats}
				globalStats={globalStats}
				usageStats={usageStats}
				handsOnTimeMs={handsOnTimeMs}
				leaderboardRegistration={leaderboardRegistration}
			/>

			<BadgeHero
				currentBadge={viewModel.currentBadge}
				currentLevel={viewModel.currentLevel}
				theme={theme}
			/>

			<BadgeProgressToNext
				theme={theme}
				nextBadge={viewModel.nextBadge}
				timeRemaining={viewModel.timeRemaining}
				progressPercent={viewModel.progressPercent}
			/>

			<BadgeStatsGrid
				theme={theme}
				cumulativeTimeFormatted={viewModel.cumulativeTimeFormatted}
				longestRunFormatted={viewModel.longestRunFormatted}
				totalRuns={viewModel.totalRuns}
			/>

			<BadgeProgressionBar
				theme={theme}
				allBadges={viewModel.allBadges}
				currentLevel={viewModel.currentLevel}
				selectedBadge={selectedBadge}
				badgeContainerRef={badgeContainerRef}
				onToggleBadge={toggleBadge}
			/>

			<BadgeHistoryTimeline theme={theme} badgeHistory={autoRunStats.badgeHistory} />

			{viewModel.hasMaxLevel && <MaxLevelCelebration theme={theme} />}
		</div>
	);
}

export default AchievementCard;
