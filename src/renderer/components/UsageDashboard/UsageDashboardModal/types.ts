import type { StatsTimeRange } from '../../../../shared/stats-types';
import type {
	Theme,
	Session,
	AutoRunStats as AutoRunStatsType,
	MaestroUsageStats,
	LeaderboardRegistration,
	UsageDashboardViewMode as ViewMode,
} from '../../../types';
import type { AchievementShareGlobalStats } from '../../AchievementShareButton';

export interface UsageDashboardModalProps {
	isOpen: boolean;
	onClose: () => void;
	theme: Theme;
	/** Enable colorblind-friendly colors for charts */
	colorBlindMode?: boolean;
	/** Default time range from settings, defaulting to week */
	defaultTimeRange?: StatsTimeRange;
	/** Sessions for displaying session statistics in Agents tab */
	sessions?: Session[];
	/** Cumulative AutoRun stats required for the achievement share button. */
	autoRunStats?: AutoRunStatsType;
	/** Optional global stats used by the share image. */
	globalStats?: AchievementShareGlobalStats | null;
	/** Maestro peak-usage stats used by the share image. */
	usageStats?: MaestroUsageStats | null;
	/** Global hands-on time, in ms, sourced from settings. */
	handsOnTimeMs?: number;
	/** Leaderboard registration for personalization. */
	leaderboardRegistration?: LeaderboardRegistration | null;
}

export interface UsageDashboardTab {
	value: ViewMode;
	label: string;
}

export interface UsageDashboardLayout {
	isNarrow: boolean;
	isMedium: boolean;
	isWide: boolean;
	chartGridCols: number;
	summaryCardsCols: number;
	autoRunStatsCols: number;
}
