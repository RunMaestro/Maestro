import { ExternalLink } from 'lucide-react';
import type { Theme } from '../../../types';
import type { ConductorBadge } from '../../../constants/conductorBadges';
import { formatCumulativeTime } from '../../../constants/conductorBadges';
import { openUrl } from '../../../utils/openUrl';
import type { BadgeTooltipPosition } from '../types';

interface BadgeTooltipProps {
	badge: ConductorBadge;
	theme: Theme;
	isUnlocked: boolean;
	position: BadgeTooltipPosition;
}

export function BadgeTooltip({ badge, theme, isUnlocked, position }: BadgeTooltipProps) {
	const getPositionStyles = () => {
		switch (position) {
			case 'left':
				return { left: 0, transform: 'translateX(0)' };
			case 'right':
				return { right: 0, transform: 'translateX(0)' };
			default:
				return { left: '50%', transform: 'translateX(-50%)' };
		}
	};

	const getArrowStyles = () => {
		switch (position) {
			case 'left':
				return { left: '16px', transform: 'translateX(0)' };
			case 'right':
				return { right: '16px', left: 'auto', transform: 'translateX(0)' };
			default:
				return { left: '50%', transform: 'translateX(-50%)' };
		}
	};

	return (
		<div
			className="absolute bottom-full mb-2 p-3 rounded-lg shadow-xl z-[100] w-64"
			style={{
				backgroundColor: theme.colors.bgSidebar,
				border: `1px solid ${theme.colors.border}`,
				boxShadow: `0 4px 20px rgba(0,0,0,0.3)`,
				...getPositionStyles(),
			}}
			onClick={(e) => e.stopPropagation()}
		>
			<div className="text-center mb-1">
				<span className="text-lg font-bold" style={{ color: theme.colors.accent }}>
					Level {badge.level}
				</span>
			</div>

			<div className="text-center mb-2">
				<span className="font-bold text-sm" style={{ color: theme.colors.textMain }}>
					{badge.name}
				</span>
			</div>

			<p className="text-xs mb-2 text-center" style={{ color: theme.colors.textDim }}>
				{badge.description}
			</p>

			{isUnlocked && (
				<p className="text-xs italic mb-2 text-center" style={{ color: theme.colors.textMain }}>
					"{badge.flavorText}"
				</p>
			)}

			<div
				className="flex items-center justify-between text-xs pt-2 border-t"
				style={{ borderColor: theme.colors.border }}
			>
				<span style={{ color: theme.colors.textDim }}>
					Required: {formatCumulativeTime(badge.requiredTimeMs)}
				</span>
				{isUnlocked ? (
					<span style={{ color: theme.colors.success }}>Unlocked</span>
				) : (
					<span style={{ color: theme.colors.textDim }}>Locked</span>
				)}
			</div>

			<button
				onClick={(e) => {
					e.stopPropagation();
					openUrl(badge.exampleConductor.wikipediaUrl);
				}}
				className="flex items-center justify-center gap-1 text-xs mt-2 hover:underline w-full"
				style={{ color: theme.colors.accent }}
			>
				<ExternalLink className="w-3 h-3" />
				{badge.exampleConductor.name}
			</button>

			<div
				className="absolute top-full w-0 h-0"
				style={{
					borderLeft: '6px solid transparent',
					borderRight: '6px solid transparent',
					borderTop: `6px solid ${theme.colors.border}`,
					...getArrowStyles(),
				}}
			/>
		</div>
	);
}
