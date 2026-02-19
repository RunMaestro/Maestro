import { memo } from 'react';
import { Bot, User, ExternalLink, Check, X, Clock, Award } from 'lucide-react';
import type { Theme, HistoryEntry, HistoryEntryType } from '../../types';
import { formatElapsedTime } from '../../utils/formatters';
import { stripMarkdown } from '../../utils/textProcessing';
import { DoubleCheck } from './historyConstants';

// Get pill color based on entry type
const getPillColor = (type: HistoryEntryType, theme: Theme) => {
	switch (type) {
		case 'AUTO':
			return {
				bg: theme.colors.warning + '20',
				text: theme.colors.warning,
				border: theme.colors.warning + '40',
			};
		case 'USER':
			return {
				bg: theme.colors.accent + '20',
				text: theme.colors.accent,
				border: theme.colors.accent + '40',
			};
		default:
			return {
				bg: theme.colors.bgActivity,
				text: theme.colors.textDim,
				border: theme.colors.border,
			};
	}
};

// Get icon for entry type
const getEntryIcon = (type: HistoryEntryType) => {
	switch (type) {
		case 'AUTO':
			return Bot;
		case 'USER':
			return User;
		default:
			return Bot;
	}
};

// Format timestamp
const formatTime = (timestamp: number) => {
	const date = new Date(timestamp);
	const now = new Date();
	const isToday = date.toDateString() === now.toDateString();

	if (isToday) {
		return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
	} else {
		return (
			date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
			' ' +
			date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
		);
	}
};

export interface HistoryEntryItemProps {
	entry: HistoryEntry;
	index: number;
	isSelected: boolean;
	theme: Theme;
	onOpenDetailModal: (entry: HistoryEntry, index: number) => void;
	onOpenSessionAsTab?: (agentSessionId: string) => void;
	onOpenAboutModal?: () => void;
	/** When true, displays the agentName field prominently in the entry header (used in unified history view) */
	showAgentName?: boolean;
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
}: HistoryEntryItemProps) {
	const colors = getPillColor(entry.type, theme);
	const Icon = getEntryIcon(entry.type);

	const agentName = showAgentName
		? (entry as HistoryEntry & { agentName?: string }).agentName
		: undefined;

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
								onOpenSessionAsTab?.(entry.agentSessionId!);
							}}
							className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold transition-colors hover:opacity-80 min-w-0 max-w-[200px] flex-shrink-0 ${entry.sessionName ? '' : 'font-mono uppercase'}`}
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

					{/* Success/Failure Indicator for AUTO entries */}
					{entry.type === 'AUTO' && entry.success !== undefined && (
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
										? 'Task completed successfully and human-validated'
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
						className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase flex-shrink-0"
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
				<span className="text-[10px] flex-shrink-0" style={{ color: theme.colors.textDim }}>
					{formatTime(entry.timestamp)}
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

			{/* Footer Row - Time, Cost, and Achievement Action */}
			{(entry.elapsedTimeMs !== undefined ||
				(entry.usageStats && entry.usageStats.totalCostUsd > 0) ||
				entry.achievementAction) && (
				<div
					className="flex items-center gap-3 mt-2 pt-2 border-t"
					style={{ borderColor: theme.colors.border }}
				>
					{/* Elapsed Time */}
					{entry.elapsedTimeMs !== undefined && (
						<div className="flex items-center gap-1">
							<Clock className="w-3 h-3" style={{ color: theme.colors.textDim }} />
							<span className="text-[10px] font-mono" style={{ color: theme.colors.textDim }}>
								{formatElapsedTime(entry.elapsedTimeMs)}
							</span>
						</div>
					)}
					{/* Cost */}
					{entry.usageStats && entry.usageStats.totalCostUsd > 0 && (
						<span
							className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-full"
							style={{
								backgroundColor: theme.colors.success + '15',
								color: theme.colors.success,
								border: `1px solid ${theme.colors.success}30`,
							}}
						>
							${entry.usageStats.totalCostUsd.toFixed(2)}
						</span>
					)}
					{/* Achievement Action Button */}
					{entry.achievementAction === 'openAbout' && onOpenAboutModal && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								onOpenAboutModal();
							}}
							className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold transition-colors hover:opacity-80 ml-auto"
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
				</div>
			)}
		</div>
	);
});
