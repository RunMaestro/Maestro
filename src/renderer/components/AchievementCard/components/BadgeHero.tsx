import type { Theme } from '../../../types';
import type { ConductorBadge } from '../../../constants/conductorBadges';
import { MaestroSilhouette } from '../../MaestroSilhouette';
import { GOLD_COLOR } from '../utils/badgeStyles';
import { BadgeProgressRing } from './BadgeProgressRing';

interface BadgeHeroProps {
	currentBadge: ConductorBadge | null;
	currentLevel: number;
	theme: Theme;
}

export function BadgeHero({ currentBadge, currentLevel, theme }: BadgeHeroProps) {
	return (
		<div className="flex items-center gap-4 mb-4">
			<div className="relative flex-shrink-0" style={{ width: 72, height: 72 }}>
				<BadgeProgressRing currentLevel={currentLevel} size={72} theme={theme} />

				<div
					className="absolute rounded-full flex items-center justify-center overflow-hidden"
					style={{
						top: 8,
						left: 8,
						width: 56,
						height: 56,
						background: currentLevel > 0 ? '#2d2d44' : theme.colors.bgMain,
						border: `2px solid ${currentLevel > 0 ? GOLD_COLOR : theme.colors.border}`,
					}}
				>
					<MaestroSilhouette
						variant="light"
						size={36}
						style={{ opacity: currentLevel > 0 ? 1 : 0.3 }}
					/>
				</div>

				{currentLevel > 0 && (
					<div
						className="absolute flex items-center justify-center text-xs font-bold"
						style={{
							top: -2,
							right: -2,
							width: 20,
							height: 20,
							borderRadius: '50%',
							background: `linear-gradient(135deg, ${GOLD_COLOR} 0%, #FFA500 100%)`,
							color: '#000',
							boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
						}}
					>
						{currentLevel}
					</div>
				)}
			</div>

			<div className="flex-1 min-w-0">
				{currentBadge ? (
					<>
						<div className="font-medium truncate" style={{ color: theme.colors.textMain }}>
							{currentBadge.name}
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Level {currentBadge.level} of 11
						</div>
					</>
				) : (
					<>
						<div className="font-medium" style={{ color: theme.colors.textDim }}>
							No Badge Yet
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Complete 15 minutes of AutoRun to unlock
						</div>
					</>
				)}
			</div>
		</div>
	);
}
