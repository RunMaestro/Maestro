import { memo } from 'react';
import { Zap, Clock, Flame, Trophy } from 'lucide-react';
import type { Theme } from '../../../types';
import type { Achievement } from '../../../hooks/symphony/useContributorStats';
import { SymphonyAchievementBadge } from '../components/SymphonyAchievementBadge';

export interface StatsTabProps {
	theme: Theme;
	formattedTotalTokens: string;
	formattedTotalCost: string;
	formattedTotalTime: string;
	uniqueRepos: number;
	currentStreakWeeks: number;
	longestStreakWeeks: number;
	achievements: Achievement[];
}

export const StatsTab = memo(function StatsTab({
	theme,
	formattedTotalTokens,
	formattedTotalCost,
	formattedTotalTime,
	uniqueRepos,
	currentStreakWeeks,
	longestStreakWeeks,
	achievements,
}: StatsTabProps) {
	return (
		<div className="flex-1 overflow-y-auto p-4">
			{/* Stats cards */}
			<div className="grid grid-cols-3 gap-4 mb-6">
				<div
					className="p-4 rounded-lg border"
					style={{
						backgroundColor: theme.colors.bgActivity,
						borderColor: theme.colors.border,
					}}
				>
					<div className="flex items-center gap-2 mb-2">
						<Zap className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Tokens Donated
						</span>
					</div>
					<p className="text-2xl font-semibold" style={{ color: theme.colors.textMain }}>
						{formattedTotalTokens}
					</p>
					<p className="text-xs" style={{ color: theme.colors.textDim }}>
						Worth {formattedTotalCost}
					</p>
				</div>

				<div
					className="p-4 rounded-lg border"
					style={{
						backgroundColor: theme.colors.bgActivity,
						borderColor: theme.colors.border,
					}}
				>
					<div className="flex items-center gap-2 mb-2">
						<Clock className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Time Contributed
						</span>
					</div>
					<p className="text-2xl font-semibold" style={{ color: theme.colors.textMain }}>
						{formattedTotalTime}
					</p>
					<p className="text-xs" style={{ color: theme.colors.textDim }}>
						{uniqueRepos} repositories
					</p>
				</div>

				<div
					className="p-4 rounded-lg border"
					style={{
						backgroundColor: theme.colors.bgActivity,
						borderColor: theme.colors.border,
					}}
				>
					<div className="flex items-center gap-2 mb-2">
						<Flame className="w-5 h-5" style={{ color: '#f97316' }} />
						<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Streak
						</span>
					</div>
					<p className="text-2xl font-semibold" style={{ color: theme.colors.textMain }}>
						{currentStreakWeeks} weeks
					</p>
					<p className="text-xs" style={{ color: theme.colors.textDim }}>
						Best: {longestStreakWeeks} weeks
					</p>
				</div>
			</div>

			{/* Achievements */}
			<div>
				<h3
					className="text-sm font-semibold mb-3 flex items-center gap-2"
					style={{ color: theme.colors.textMain }}
				>
					<Trophy className="w-4 h-4" style={{ color: '#eab308' }} />
					Achievements
				</h3>
				<div className="grid grid-cols-2 gap-3">
					{achievements.map((achievement) => (
						<SymphonyAchievementBadge
							key={achievement.id}
							achievement={achievement}
							theme={theme}
						/>
					))}
				</div>
			</div>
		</div>
	);
});
