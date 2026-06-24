import { Plus } from 'lucide-react';
import type { Theme } from '../../../types';

interface CopyDragIndicatorProps {
	theme: Theme;
	cursorPosition: { x: number; y: number } | null;
	isCopyDrag: boolean;
}

export function CopyDragIndicator({ theme, cursorPosition, isCopyDrag }: CopyDragIndicatorProps) {
	if (!isCopyDrag || !cursorPosition) return null;

	return (
		<div
			className="fixed pointer-events-none z-[10001] flex items-center justify-center"
			style={{
				left: cursorPosition.x + 16,
				top: cursorPosition.y + 16,
				width: 24,
				height: 24,
				borderRadius: '50%',
				backgroundColor: theme.colors.success,
				boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
			}}
		>
			<Plus className="w-4 h-4 stroke-2" style={{ color: theme.colors.bgMain }} />
		</div>
	);
}
