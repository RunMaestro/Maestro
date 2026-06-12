import { FlaskConical, X } from 'lucide-react';
import { GhostIconButton } from '../../ui/GhostIconButton';
import type { Theme } from '../../../types';

interface PlaygroundHeaderProps {
	theme: Theme;
	onClose: () => void;
}

export function PlaygroundHeader({ theme, onClose }: PlaygroundHeaderProps) {
	return (
		<div
			className="p-4 border-b flex items-center justify-between"
			style={{ borderColor: theme.colors.border }}
		>
			<div className="flex items-center gap-2">
				<FlaskConical className="w-5 h-5" style={{ color: theme.colors.accent }} />
				<h2 className="text-lg font-bold" style={{ color: theme.colors.textMain }}>
					Developer Playground
				</h2>
			</div>
			<GhostIconButton onClick={onClose} color={theme.colors.textDim}>
				<X className="w-5 h-5" />
			</GhostIconButton>
		</div>
	);
}
