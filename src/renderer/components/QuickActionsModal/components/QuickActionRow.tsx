import type React from 'react';
import { useState } from 'react';
import { Bot } from 'lucide-react';
import type { Theme } from '../../../types';
import { ShortcutKeys } from '../../ui/ShortcutHint';
import { formatShortcutSequence } from '../../../utils/shortcutFormatter';
import { useShortcutKeys } from '../../../hooks/keyboard/useShortcutKeys';
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
	const resolved = useShortcutKeys(action.shortcut?.id);
	// Fall back to the shortcut passed in if resolver returns unbound (e.g., in tests).
	// In the real app, all shortcuts are registered and the resolver will find them.
	const keys = resolved.keys && resolved.keys.length > 0 ? resolved.keys : action.shortcut?.keys;
	const sequence =
		resolved.keys && resolved.keys.length > 0 ? resolved.sequence : action.shortcut?.sequence;
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
					{/* data-action-label lets tests read the label without having to strip
					    number badges, subtext, and shortcut hints out of textContent. */}
					<span className="font-medium truncate" data-action-label={action.label}>
						{action.label}
					</span>
					{action.isInBatch && <AutoRunPill progress={action.autoRunProgress} theme={theme} />}
				</div>
				{action.runningInfo ? (
					<RunningAgentSubtext
						info={action.runningInfo}
						now={now}
						theme={theme}
						isSelected={isSelected}
					/>
				) : (
					action.subtext && <span className="text-2xs opacity-50">{action.subtext}</span>
				)}
			</div>
			{/* Length check, not just presence: an action can ship UNBOUND and still
			    be handed its shortcut record, and an empty chip would draw a blank
			    box where a chord belongs. Route through the resolver to show the active
			    mode's chord and sequence. */}
			{keys?.length ? (
				<span className="inline-flex items-center gap-1.5 whitespace-nowrap shrink-0">
					<ShortcutKeys theme={theme} keys={keys} onAccent={isSelected} />
					{sequence && (
						<>
							<span className="text-2xs" style={{ color: theme.colors.textDim }}>
								or
							</span>
							<span className="text-2xs font-mono">{formatShortcutSequence(sequence)}</span>
						</>
					)}
				</span>
			) : null}
		</button>
	);
}

/**
 * The AUTO pill, filled left to right by how far the run is. A goal-mode run
 * reports the agent's own estimate, so its percent carries a `~`.
 */
function AutoRunPill({
	progress,
	theme,
}: {
	progress: QuickAction['autoRunProgress'];
	theme: Theme;
}) {
	const percentLabel = progress ? `${progress.goalMode ? '~' : ''}${progress.percent}%` : null;
	return (
		<div
			className="relative flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded overflow-hidden text-3xs font-bold uppercase"
			style={{
				backgroundColor: theme.colors.warning + '30',
				color: theme.colors.warning,
			}}
			title={percentLabel ? `Auto Run active: ${percentLabel} complete` : 'Auto Run active'}
		>
			{progress && (
				<span
					className="absolute inset-y-0 left-0 transition-[width] duration-500"
					style={{ width: `${progress.percent}%`, backgroundColor: theme.colors.warning + '40' }}
					data-testid="auto-run-pill-fill"
					aria-hidden="true"
				/>
			)}
			<Bot className="relative w-2.5 h-2.5" />
			<span className="relative">AUTO</span>
			{percentLabel && <span className="relative tabular-nums">{percentLabel}</span>}
		</div>
	);
}
