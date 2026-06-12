import { memo } from 'react';
import { CheckCircle } from 'lucide-react';
import type { Theme } from '../../../types';
import type { Achievement } from '../../../hooks/symphony/useContributorStats';
import { STATUS_COLORS } from '../helpers/statusInfo';

export interface SymphonyAchievementBadgeProps {
	achievement: Achievement;
	theme: Theme;
}

export const SymphonyAchievementBadge = memo(function SymphonyAchievementBadge({
	achievement,
	theme,
}: SymphonyAchievementBadgeProps) {
	const clampedProgress = Math.max(0, Math.min(100, achievement.progress ?? 0));

	return (
		<div
			className="p-3 rounded-lg border"
			style={{
				backgroundColor: theme.colors.bgActivity,
				borderColor: achievement.earned ? theme.colors.accent : theme.colors.border,
				opacity: achievement.earned ? 1 : 0.5,
			}}
		>
			<div className="flex items-center gap-3">
				<div className="text-2xl" style={{ opacity: achievement.earned ? 1 : 0.7 }}>
					{achievement.icon}
				</div>
				<div className="flex-1 min-w-0">
					<h4 className="font-medium text-sm" style={{ color: theme.colors.textMain }}>
						{achievement.title}
					</h4>
					<p className="text-xs" style={{ color: theme.colors.textDim }}>
						{achievement.description}
					</p>
					{!achievement.earned && achievement.progress !== undefined && (
						<div className="mt-1">
							<div
								className="h-1 rounded-full overflow-hidden"
								style={{ backgroundColor: theme.colors.bgMain }}
							>
								<div
									className="h-full rounded-full"
									style={{
										width: `${clampedProgress}%`,
										backgroundColor: theme.colors.accent,
									}}
								/>
							</div>
						</div>
					)}
				</div>
				{achievement.earned && (
					<CheckCircle className="w-5 h-5 shrink-0" style={{ color: STATUS_COLORS.running }} />
				)}
			</div>
		</div>
	);
});
