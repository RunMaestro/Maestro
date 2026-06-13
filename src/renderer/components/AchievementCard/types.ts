import type { AutoRunStats, LeaderboardRegistration, MaestroUsageStats, Theme } from '../../types';
import type { ConductorBadge } from '../../constants/conductorBadges';

export interface GlobalStatsSubset {
	totalSessions: number;
	totalMessages: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheCreationTokens: number;
	totalCostUsd: number;
	totalSizeBytes: number;
	isComplete?: boolean;
	hasCostData?: boolean;
	byProvider?: Record<string, unknown>;
}

export interface AchievementCardProps {
	theme: Theme;
	autoRunStats: AutoRunStats;
	globalStats?: GlobalStatsSubset | null;
	usageStats?: MaestroUsageStats | null;
	handsOnTimeMs?: number;
	leaderboardRegistration?: LeaderboardRegistration | null;
}

export type BadgeTooltipPosition = 'left' | 'center' | 'right';

export type BadgeEscapeHandler = () => boolean;

export type BadgeEscapeHandlerRegistrar = (handler: BadgeEscapeHandler | null) => void;

export interface AchievementCardShellProps extends AchievementCardProps {
	onEscapeWithBadgeOpen?: BadgeEscapeHandlerRegistrar;
}

export interface AchievementCardViewModel {
	currentBadge: ConductorBadge | null;
	nextBadge: ConductorBadge | null;
	progressPercent: number;
	timeRemaining: string;
	currentLevel: number;
	cumulativeTimeFormatted: string;
	longestRunFormatted: string;
	totalRuns: number;
	unlockedCountLabel: string;
	hasMaxLevel: boolean;
	allBadges: ConductorBadge[];
}

export interface BadgeHistoryRow {
	level: number;
	unlockedAt: number;
	badge: ConductorBadge;
	dateLabel: string;
}
