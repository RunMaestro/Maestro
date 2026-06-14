import type { Ref } from 'react';
import type { Theme } from '../../../types';
import type { ConductorBadge } from '../../../constants/conductorBadges';
import { getProgressionSegmentStyle, getTooltipPosition } from '../utils/badgeStyles';
import { BadgeTooltip } from './BadgeTooltip';

interface BadgeProgressionBarProps {
	theme: Theme;
	allBadges: ConductorBadge[];
	currentLevel: number;
	selectedBadge: number | null;
	badgeContainerRef: Ref<HTMLDivElement>;
	onToggleBadge: (level: number) => void;
}

export function BadgeProgressionBar({
	theme,
	allBadges,
	currentLevel,
	selectedBadge,
	badgeContainerRef,
	onToggleBadge,
}: BadgeProgressionBarProps) {
	return (
		<div ref={badgeContainerRef}>
			<div className="flex items-center justify-between mb-2">
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					Badge Progression
				</span>
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					{currentLevel}/{allBadges.length} unlocked
				</span>
			</div>
			<div className="flex gap-1">
				{allBadges.map((badge) => {
					const isUnlocked = badge.level <= currentLevel;
					const isSelected = selectedBadge === badge.level;

					return (
						<div
							key={badge.id}
							className="relative flex-1"
							onClick={() => onToggleBadge(badge.level)}
						>
							<div
								className="h-3 rounded-full cursor-pointer transition-all hover:scale-110"
								style={getProgressionSegmentStyle(badge.level, currentLevel, theme)}
								title={`${badge.name} - Click to view details`}
							/>
							{isSelected && (
								<BadgeTooltip
									badge={badge}
									theme={theme}
									isUnlocked={isUnlocked}
									position={getTooltipPosition(badge.level)}
								/>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
