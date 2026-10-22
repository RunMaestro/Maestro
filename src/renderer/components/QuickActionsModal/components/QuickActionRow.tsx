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
	// The resolver's answer is authoritative, including when it is "unbound".
	// `action.shortcut` carries the DEFAULT-mode record the palette was built
	// with, so falling back to it whenever `keys` came back empty re-advertised
	// a chord the live mode does not have: a row the user cleared, or one a Vim
	// override displaced, kept showing its default-mode chord. That is the exact
	// case `resolveShortcutKeys` documents as "must not be shown wearing another
	// table's chord". An empty chord is a real result, not a failed lookup.
	//
	// `shortcutKeys` is the one documented exception: a chord that belongs to the
	// ROW rather than to the action, which no action id can answer for. The hook
	// is still called unconditionally (it must be - hooks cannot be skipped) and
	// simply asked about nothing.
	const literalKeys = action.shortcutKeys;
	const resolved = useShortcutKeys(literalKeys ? undefined : action.shortcut?.id);
	const keys = literalKeys ?? resolved.keys;
	const sequence = literalKeys ? undefined : resolved.sequence;
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
			{/* The two triggers are drawn INDEPENDENTLY: an action can carry a
			    sequence with no chord (Vim mode's `z`, `g g`), and gating the whole
			    cluster on `keys.length` hid that sequence completely. Each half is
			    still length-checked, because an action can ship unbound and a blank
			    key-cap advertises a combo that does nothing. The "or" only appears
			    when there really are two ways to fire the action. */}
			{keys.length > 0 || sequence ? (
				<span className="inline-flex items-center gap-1.5 whitespace-nowrap shrink-0">
					{keys.length > 0 && <ShortcutKeys theme={theme} keys={keys} onAccent={isSelected} />}
					{sequence && (
						<>
							{keys.length > 0 && (
								<span className="text-2xs" style={{ color: theme.colors.textDim }}>
									or
								</span>
							)}
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
