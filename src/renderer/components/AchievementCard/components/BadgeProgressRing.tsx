import type { Theme } from '../../../types';
import { BADGE_TOTAL_LEVELS, getProgressRingSegmentColor } from '../utils/badgeStyles';

interface BadgeProgressRingProps {
	currentLevel: number;
	size: number;
	theme: Theme;
}

export function BadgeProgressRing({ currentLevel, size, theme }: BadgeProgressRingProps) {
	const strokeWidth = 4;
	const gap = 4;
	const radius = (size - strokeWidth) / 2;
	const center = size / 2;
	const totalGapDegrees = gap * BADGE_TOTAL_LEVELS;
	const segmentDegrees = (360 - totalGapDegrees) / BADGE_TOTAL_LEVELS;
	const startAngle = -90;

	const getArcPath = (segmentIndex: number): string => {
		const segmentStart = startAngle + segmentIndex * (segmentDegrees + gap);
		const segmentEnd = segmentStart + segmentDegrees;

		const startRad = (segmentStart * Math.PI) / 180;
		const endRad = (segmentEnd * Math.PI) / 180;

		const x1 = center + radius * Math.cos(startRad);
		const y1 = center + radius * Math.sin(startRad);
		const x2 = center + radius * Math.cos(endRad);
		const y2 = center + radius * Math.sin(endRad);

		return `M ${x1} ${y1} A ${radius} ${radius} 0 0 1 ${x2} ${y2}`;
	};

	return (
		<svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute inset-0">
			{Array.from({ length: BADGE_TOTAL_LEVELS }, (_, i) => {
				const level = i + 1;
				const isUnlocked = level <= currentLevel;
				const color = getProgressRingSegmentColor(level, isUnlocked, theme);

				return (
					<path
						key={i}
						d={getArcPath(i)}
						fill="none"
						stroke={color}
						strokeWidth={strokeWidth}
						strokeLinecap="round"
						opacity={isUnlocked ? 1 : 0.3}
						style={{
							filter: isUnlocked ? `drop-shadow(0 0 2px ${color}60)` : 'none',
							transition: 'all 0.5s ease-out',
						}}
					/>
				);
			})}
		</svg>
	);
}
