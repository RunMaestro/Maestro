import { Star } from 'lucide-react';
import type { Theme } from '../../../types';

interface MaxLevelCelebrationProps {
	theme: Theme;
}

export function MaxLevelCelebration({ theme }: MaxLevelCelebrationProps) {
	return (
		<div
			className="mt-4 p-3 rounded-lg text-center"
			style={{
				background: `linear-gradient(135deg, ${theme.colors.accent}20 0%, #FFD70020 100%)`,
				border: `1px solid #FFD700`,
			}}
		>
			<div className="flex items-center justify-center gap-2 mb-1">
				<Star data-testid="star-icon" className="w-4 h-4" style={{ color: '#FFD700' }} />
				<span className="font-bold" style={{ color: '#FFD700' }}>
					Maximum Level Achieved!
				</span>
				<Star data-testid="star-icon" className="w-4 h-4" style={{ color: '#FFD700' }} />
			</div>
			<p className="text-xs" style={{ color: theme.colors.textDim }}>
				You are a true Titan of the Baton
			</p>
		</div>
	);
}
