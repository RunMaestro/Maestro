import type React from 'react';
import { useState } from 'react';
import { Bot } from 'lucide-react';
import type { Theme } from '../../../types';
import { formatShortcutKeys } from '../../../utils/shortcutFormatter';
import { getStatusColor } from '../../../utils/theme';
import type { QuickAction } from '../types';
import { RunningAgentSubtext } from './RunningAgentSubtext';

interface QuickActionRowProps {
	action: QuickAction;
	isSelected: boolean;
	showNumber: boolean;
	numberBadge: number;
	now: number;
	theme: Theme;
	selectedItemRef: React.Ref<HTMLButtonElement>;
	onClick: (action: QuickAction) => void;
}

export function QuickActionRow({
	action,
	isSelected,
	showNumber,
	numberBadge,
	now,
	theme,
	selectedItemRef,
	onClick,
}: QuickActionRowProps) {
	const [isHovered, setIsHovered] = useState(false);
	return (
		<button
			ref={isSelected ? selectedItemRef : null}
			onClick={() => onClick(action)}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
			className="w-full text-left px-4 py-3 flex items-center gap-3"
			style={{
				backgroundColor: isSelected
					? theme.colors.accent
					: isHovered
						? `${theme.colors.accent}1a`
						: 'transparent',
				color: isSelected ? theme.colors.accentForeground : theme.colors.textMain,
			}}
		>
			{showNumber ? (
				<div
					className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-xs font-bold"
					style={{
						backgroundColor: theme.colors.bgMain,
						color: theme.colors.textDim,
					}}
				>
					{numberBadge}
				</div>
			) : (
				<div className="flex-shrink-0 w-5 h-5" />
			)}
			<div className="flex flex-col flex-1 min-w-0">
				<div className="flex items-center gap-2 min-w-0">
					{action.runningInfo && (
						<span
							className="flex-shrink-0 inline-block w-2 h-2 rounded-full animate-pulse"
							style={{
								backgroundColor: getStatusColor(action.runningInfo.state, theme),
							}}
							aria-hidden="true"
						/>
					)}
					<span className="font-medium truncate">{action.label}</span>
					{action.isInBatch && (
						<div
							className="flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
							style={{
								backgroundColor: theme.colors.warning + '30',
								color: theme.colors.warning,
							}}
							title="Auto Run active"
						>
							<Bot className="w-2.5 h-2.5" />
							AUTO
						</div>
					)}
				</div>
				{action.runningInfo ? (
					<RunningAgentSubtext
						info={action.runningInfo}
						now={now}
						theme={theme}
						isSelected={isSelected}
					/>
				) : (
					action.subtext && <span className="text-[10px] opacity-50">{action.subtext}</span>
				)}
			</div>
			{action.shortcut && (
				<span className="text-xs font-mono opacity-60">
					{formatShortcutKeys(action.shortcut.keys)}
				</span>
			)}
		</button>
	);
}
