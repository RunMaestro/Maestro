import { memo } from 'react';
import {
	ExternalLink,
	Check,
	X,
	Clock,
	Award,
	Server,
	User,
	ChevronDown,
	ChevronRight,
} from 'lucide-react';
import type { Theme, HistoryEntry } from '../../types';
import { formatElapsedTime } from '../../utils/formatters';
import { stripMarkdown } from '../../utils/textProcessing';
import { DoubleCheck, getPillColor, getEntryIcon, hasRunOutcome } from './historyConstants';
import { formatCount, formatTimestamp } from '../../../shared/formatters';
import { humanizeCueEventType } from '../../../shared/cue/cue-summary';
import { getTokenSourcePill } from '../../../shared/claudeTokenModeLabel';
import { useSettingsStore } from '../../stores/settingsStore';
import { CueGroupRuns } from './CueGroupRuns';
import type { CueGroupExpansionApi } from '../../hooks/history/useExpandedCueGroups';

export interface HistoryEntryItemProps {
	entry: HistoryEntry;
	index: number;
	isSelected: boolean;
	theme: Theme;
	onOpenDetailModal: (entry: HistoryEntry, index: number) => void;
	onOpenSessionAsTab?: (agentSessionId: string, projectPath?: string, sessionName?: string) => void;
	onOpenAboutModal?: () => void;
	/** When true, displays the agentName field prominently in the entry header (used in unified history view) */
	showAgentName?: boolean;
	/**
	 * Toggle + loader for the runs behind a collapsed Cue group, from
	 * `useExpandedCueGroups`. Omitted by surfaces that never request grouped
	 * rows, which turns the expander off rather than drawing a control with
	 * nothing behind it.
	 */
	cueGroupExpansion?: CueGroupExpansionApi;
	/** Whether THIS row's group is currently open. */
	isCueGroupExpanded?: boolean;
}

export const HistoryEntryItem = memo(function HistoryEntryItem({
	entry,
	index,
	isSelected,
	theme,
	onOpenDetailModal,
	onOpenSessionAsTab,
	onOpenAboutModal,
	showAgentName,
	cueGroupExpansion,
	isCueGroupExpanded = false,
}: HistoryEntryItemProps) {
	const colors = getPillColor(entry.type, theme);
	const Icon = getEntryIcon(entry.type);
	const showProviderModePill = useSettingsStore((s) => s.showProviderModePill);

	// Claude-only per-turn token source pill (TUI = maestro-p / Max plan, API =
	// claude --print). Absent on non-Claude and older entries, and hidden entirely
	// when the "Provider Mode Pill" display setting is off. Shares its label and
	// tooltip with the live chat pill so the two can never drift.
	const tokenPill =
		showProviderModePill && entry.tokenSource
			? getTokenSourcePill({ mode: entry.tokenSource, reason: entry.tokenSourceReason })
			: null;
	const tokenPillColor = tokenPill
		? tokenPill.isTui
			? theme.colors.accent
			: (theme.colors.warning ?? theme.colors.accent)
		: theme.colors.accent;

	const agentName = showAgentName
		? (entry as HistoryEntry & { agentName?: string }).agentName
		: undefined;

	// A collapsed run of Cue triggers. The row is still the group's NEWEST run,
	// so everything below reads the same fields as an ungrouped row; the group
	// only changes what the header names it and swaps the per-run success dot
	// for the group's failure tally, which is the honest summary of N runs.
	const cueGroup = entry.cueGroup;
	// The expander only exists when a caller supplied somewhere to get the runs
	// from. `cueGroupToHistoryEntry()` never attaches `cueGroup` to a group of
	// one, so a row that has one is always standing for runs worth opening.
	const expandable = Boolean(cueGroup && cueGroupExpansion);
	const expanded = expandable && isCueGroupExpanded;

	return (
		<div
			onClick={() => onOpenDetailModal(entry, index)}
			className="p-3 rounded border transition-colors cursor-pointer hover:bg-white/5"
			style={{
				borderColor: isSelected ? theme.colors.accent : theme.colors.border,
				backgroundColor: isSelected ? theme.colors.accent + '10' : 'transparent',
				outline: isSelected ? `2px solid ${theme.colors.accent}` : 'none',
				outlineOffset: '1px',
			}}
		>
			{/* Header Row - agent name, session pill, type pill left-justified; timestamp right-justified */}
			<div className="flex items-center justify-between mb-2 gap-2">
				<div className="flex items-center gap-2 min-w-0 flex-1">
					{/* Expander for a collapsed group. Sized to the success dot it
					    replaces so a grouped row is the same height as any other. */}
					{expandable && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								cueGroupExpansion!.toggle(entry.id);
							}}
							className="flex items-center justify-center w-5 h-5 rounded flex-shrink-0 hover:bg-white/10 transition-colors"
							aria-expanded={expanded}
							title={expanded ? 'Hide individual runs' : 'Show individual runs'}
						>
							{expanded ? (
								<ChevronDown className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
							) : (
								<ChevronRight className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
							)}
						</button>
					)}

					{/* Agent Name - shown in unified history view */}
					{agentName && (
						<h3
							className="text-sm font-bold truncate flex-shrink-0"
							style={{ color: theme.colors.textMain, maxWidth: '40%' }}
							title={agentName}
						>
							{agentName}
						</h3>
					)}

					{/* Session Name or ID Octet (clickable) */}
					{entry.agentSessionId && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								// Hand the label on this pill to the restore: it IS the tab's name,
								// and nothing downstream can recover it once the tab is closed.
								onOpenSessionAsTab?.(entry.agentSessionId!, entry.projectPath, entry.sessionName);
							}}
							className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-bold transition-colors hover:opacity-80 min-w-0 flex-shrink ${entry.sessionName ? '' : 'font-mono uppercase'}`}
							style={{
								backgroundColor: theme.colors.accent + '20',
								color: theme.colors.accent,
								border: `1px solid ${theme.colors.accent}40`,
							}}
							title={entry.sessionName || entry.agentSessionId}
						>
							<span className="truncate">
								{entry.sessionName || entry.agentSessionId.split('-')[0].toUpperCase()}
							</span>
							<ExternalLink className="w-2.5 h-2.5 flex-shrink-0" />
						</button>
					)}

					{/*
					 * Static label when there is no provider session to jump to. A failed
					 * consult never captures an agentSessionId, so gating the pill above
					 * on it silently dropped the subject line the writer had already
					 * computed - the exact entries where "what was this?" matters most.
					 */}
					{!entry.agentSessionId && entry.sessionName && (
						<span
							className="px-2 py-0.5 rounded-full text-2xs font-bold min-w-0 flex-shrink truncate"
							style={{
								backgroundColor: theme.colors.bgActivity,
								color: theme.colors.textDim,
								border: `1px solid ${theme.colors.border}`,
							}}
							title={entry.sessionName}
						>
							{entry.sessionName}
						</span>
					)}

					{/* Trigger name for a collapsed group of Cue runs */}
					{cueGroup && (
						<h3
							className="text-sm font-bold truncate min-w-0"
							style={{ color: theme.colors.textMain }}
							title={cueGroup.label}
						>
							{cueGroup.label}
						</h3>
					)}

					{/* Success/Failure Indicator for dispatched work (AUTO / CUE / AGENT).
					    Suppressed on a grouped row: one run's outcome cannot speak for
					    the group, whose tally is on the meta line below instead. */}
					{!cueGroup && hasRunOutcome(entry.type) && entry.success !== undefined && (
						<span
							className="flex items-center justify-center w-5 h-5 rounded-full flex-shrink-0"
							style={{
								backgroundColor: entry.success
									? entry.validated
										? theme.colors.success
										: theme.colors.success + '20'
									: theme.colors.error + '20',
								border: `1px solid ${
									entry.success
										? entry.validated
											? theme.colors.success
											: theme.colors.success + '40'
										: theme.colors.error + '40'
								}`,
							}}
							title={
								entry.success
									? entry.validated
										? 'Task completed successfully, and you marked it as checked'
										: 'Task completed successfully'
									: 'Task failed'
							}
						>
							{entry.success ? (
								entry.validated ? (
									<DoubleCheck className="w-3 h-3" style={{ color: '#ffffff' }} />
								) : (
									<Check className="w-3 h-3" style={{ color: theme.colors.success }} />
								)
							) : (
								<X className="w-3 h-3" style={{ color: theme.colors.error }} />
							)}
						</span>
					)}

					{/* Type Pill */}
					<span
						className="flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-bold uppercase flex-shrink-0"
						style={{
							backgroundColor: colors.bg,
							color: colors.text,
							border: `1px solid ${colors.border}`,
						}}
					>
						<Icon className="w-2.5 h-2.5" />
						{entry.type}
					</span>
				</div>

				{/* Timestamp */}
				<span className="text-2xs flex-shrink-0" style={{ color: theme.colors.textDim }}>
					{formatTimestamp(entry.timestamp, 'smart')}
				</span>
			</div>

			{/* Summary - 3 lines max, strip markdown for list view */}
			<p
				className="text-xs leading-relaxed overflow-hidden"
				style={{
					color: theme.colors.textMain,
					display: '-webkit-box',
					WebkitLineClamp: 3,
					WebkitBoxOrient: 'vertical' as const,
				}}
			>
				{entry.summary ? stripMarkdown(entry.summary) : 'No summary available'}
			</p>

			{/* CUE metadata subtitle. A grouped row spends the same line on what
			    the group is standing in for - how many runs, how many of them
			    failed - and keeps the trigger type on the end of it. */}
			{cueGroup ? (
				<p
					data-cue-group={cueGroup.key}
					className="text-2xs mt-1 flex items-center gap-1.5 truncate"
					style={{ color: theme.colors.textDim }}
					title={`${formatCount(cueGroup.runCount)} runs collapsed into this row`}
				>
					<span style={{ color: theme.colors.textMain }}>
						{formatCount(cueGroup.runCount)} runs
					</span>
					{cueGroup.failureCount > 0 && (
						<>
							<span aria-hidden="true">·</span>
							<span style={{ color: theme.colors.error }}>
								{formatCount(cueGroup.failureCount)} failed
							</span>
						</>
					)}
					{entry.cueEventType && (
						<>
							<span aria-hidden="true">·</span>
							<span className="truncate" title={entry.cueEventType}>
								{humanizeCueEventType(entry.cueEventType)}
							</span>
						</>
					)}
				</p>
			) : (
				entry.type === 'CUE' &&
				entry.cueEventType && (
					<p
						className="text-2xs mt-1"
						style={{ color: theme.colors.textDim }}
						title={entry.cueEventType}
					>
						Triggered by: {humanizeCueEventType(entry.cueEventType)}
					</p>
				)
			)}

			{/* Footer Row - Time, Cost, Token Source, Achievement Action, Sender, and Remote Origin */}
			{(entry.elapsedTimeMs !== undefined ||
				(entry.usageStats && entry.usageStats.totalCostUsd > 0) ||
				tokenPill ||
				entry.achievementAction ||
				entry.userName ||
				entry.hostname) && (
				<div
					className="flex items-center gap-3 mt-2 pt-2 border-t"
					style={{ borderColor: theme.colors.border }}
				>
					{/* Elapsed Time */}
					{entry.elapsedTimeMs !== undefined && (
						<div className="flex items-center gap-1">
							<Clock className="w-3 h-3" style={{ color: theme.colors.textDim }} />
							<span className="text-2xs font-mono" style={{ color: theme.colors.textDim }}>
								{formatElapsedTime(entry.elapsedTimeMs)}
							</span>
						</div>
					)}
					{/* Cost */}
					{entry.usageStats && entry.usageStats.totalCostUsd > 0 && (
						<span
							className="text-2xs font-mono font-bold px-1.5 py-0.5 rounded-full"
							style={{
								backgroundColor: theme.colors.success + '15',
								color: theme.colors.success,
								border: `1px solid ${theme.colors.success}30`,
							}}
						>
							${entry.usageStats.totalCostUsd.toFixed(2)}
						</span>
					)}
					{/* Token Source Pill (Claude-only): TUI vs API for this turn */}
					{tokenPill && (
						<span
							className="text-2xs font-mono font-bold px-1.5 py-0.5 rounded-full"
							style={{
								backgroundColor: tokenPillColor + '20',
								color: tokenPillColor,
								border: `1px solid ${tokenPillColor}40`,
							}}
							title={tokenPill.title}
						>
							{tokenPill.label}
						</span>
					)}
					{/* Achievement Action Button */}
					{entry.achievementAction === 'openAbout' && onOpenAboutModal && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								onOpenAboutModal();
							}}
							className="flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-bold transition-colors hover:opacity-80 ml-auto"
							style={{
								backgroundColor: theme.colors.warning + '20',
								color: theme.colors.warning,
								border: `1px solid ${theme.colors.warning}40`,
							}}
							title="View achievements"
						>
							<Award className="w-3 h-3" />
							View Achievements
						</button>
					)}
					{/* Sender pill - shown for turns a logged-in browser sent */}
					{entry.userName && (
						<span
							className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-2xs font-mono font-bold ${entry.achievementAction ? '' : 'ml-auto'}`}
							style={{
								backgroundColor: theme.colors.bgActivity,
								color: theme.colors.textDim,
								border: `1px solid ${theme.colors.border}`,
							}}
							title={`Sent by ${entry.userName}`}
						>
							<User className="w-2.5 h-2.5" />
							{entry.userDisplayName ?? entry.userName}
						</span>
					)}
					{/* Remote hostname pill - shown for entries from other hosts */}
					{entry.hostname && (
						<span
							className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full text-2xs font-mono font-bold ${entry.achievementAction || entry.userName ? '' : 'ml-auto'}`}
							style={{
								backgroundColor: theme.colors.bgActivity,
								color: theme.colors.textDim,
								border: `1px solid ${theme.colors.border}`,
							}}
							title={`Origin: ${entry.hostname}`}
						>
							<Server className="w-2.5 h-2.5" />
							{entry.hostname}
						</span>
					)}
				</div>
			)}

			{/* The runs this row stands for. Mounted only while expanded, which
			    is what fetches them - see CueGroupRuns. */}
			{expanded && (
				<CueGroupRuns
					entry={entry}
					theme={theme}
					expansion={cueGroupExpansion!}
					onOpenRun={(run) => onOpenDetailModal(run, index)}
				/>
			)}
		</div>
	);
});
