import React from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { AUTO_REFRESH_OPTIONS } from '../types';
import type { Theme } from '../../../types';

interface AutoRefreshOverlayProps {
	theme: Theme;
	position: { top: number; left: number };
	currentInterval: number;
	onIntervalSelect: (interval: number) => void;
	onMouseEnter: () => void;
	onMouseLeave: () => void;
}

export function AutoRefreshOverlay({
	theme,
	position,
	currentInterval,
	onIntervalSelect,
	onMouseEnter,
	onMouseLeave,
}: AutoRefreshOverlayProps) {
	return createPortal(
		<div
			className="fixed z-[100] rounded-lg shadow-xl border overflow-hidden"
			style={{
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
				minWidth: '200px',
				top: position.top,
				left: position.left,
				transform: 'translateX(-100%)',
			}}
			onMouseEnter={onMouseEnter}
			onMouseLeave={onMouseLeave}
		>
			<div
				className="px-3 py-2 text-xs font-medium border-b"
				style={{
					backgroundColor: theme.colors.bgActivity,
					borderColor: theme.colors.border,
					color: theme.colors.textMain,
				}}
			>
				Auto-refresh
			</div>

			<div className="p-1">
				{AUTO_REFRESH_OPTIONS.map((option) => (
					<button
						key={option.value}
						onClick={() => onIntervalSelect(option.value)}
						className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
						style={{
							color: currentInterval === option.value ? theme.colors.accent : theme.colors.textMain,
							backgroundColor:
								currentInterval === option.value ? `${theme.colors.accent}15` : 'transparent',
						}}
					>
						<span className="whitespace-nowrap">{option.label}</span>
						{currentInterval === option.value && (
							<Check className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
						)}
					</button>
				))}

				{currentInterval > 0 && (
					<>
						<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
						<button
							onClick={() => onIntervalSelect(0)}
							className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textDim }}
						>
							Disable auto-refresh
						</button>
					</>
				)}
			</div>
		</div>,
		document.body
	);
}
