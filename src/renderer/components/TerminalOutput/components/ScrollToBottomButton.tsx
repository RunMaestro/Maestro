import { ArrowDown } from 'lucide-react';
import type { Theme } from '../../../types';

interface ScrollToBottomButtonProps {
	theme: Theme;
	userMessageAlignment: 'left' | 'right';
	isAutoScrollActive: boolean;
	hasNewMessages: boolean;
	newMessageCount: number;
	onClick: () => void;
}

export function ScrollToBottomButton({
	theme,
	userMessageAlignment,
	isAutoScrollActive,
	hasNewMessages,
	newMessageCount,
	onClick,
}: ScrollToBottomButtonProps) {
	return (
		<button
			onClick={onClick}
			className={`absolute bottom-4 ${userMessageAlignment === 'right' ? 'left-6' : 'right-6'} flex items-center gap-2 px-3 py-2 rounded-full shadow-lg transition-all hover:scale-105 z-20 outline-none`}
			style={{
				backgroundColor: isAutoScrollActive
					? theme.colors.accent
					: hasNewMessages
						? theme.colors.accent
						: theme.colors.bgSidebar,
				color: isAutoScrollActive
					? theme.colors.accentForeground
					: hasNewMessages
						? theme.colors.accentForeground
						: theme.colors.textDim,
				border: `1px solid ${isAutoScrollActive || hasNewMessages ? 'transparent' : theme.colors.border}`,
				animation:
					hasNewMessages && !isAutoScrollActive
						? 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite'
						: undefined,
			}}
			title={
				hasNewMessages ? 'New messages (click to pin to bottom)' : 'Scroll to bottom (click to pin)'
			}
		>
			<ArrowDown className="w-4 h-4" />
			{newMessageCount > 0 && !isAutoScrollActive && (
				<span className="text-xs font-bold">{newMessageCount > 99 ? '99+' : newMessageCount}</span>
			)}
		</button>
	);
}
