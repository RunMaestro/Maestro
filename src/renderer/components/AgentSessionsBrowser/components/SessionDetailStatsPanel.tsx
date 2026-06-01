import React from 'react';
import {
	DollarSign,
	Timer,
	Zap,
	MessageSquare,
	ArrowDownToLine,
	ArrowUpFromLine,
	Database,
	Hash,
	HardDrive,
} from 'lucide-react';
import { FALLBACK_CONTEXT_WINDOW } from '../../../../shared/agentConstants';
import type { Theme } from '../../../types';
import type { AgentSession } from '../../../hooks/agent/useSessionViewer';
import { formatNumber, formatSize } from '../../../utils/formatters';

interface SessionDetailStatsPanelProps {
	viewingSession: AgentSession;
	theme: Theme;
}

function formatSessionDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export const SessionDetailStatsPanel = React.memo(function SessionDetailStatsPanel({
	viewingSession,
	theme,
}: SessionDetailStatsPanelProps) {
	const totalTokens = viewingSession.inputTokens + viewingSession.outputTokens;
	const usagePercent = (totalTokens / FALLBACK_CONTEXT_WINDOW) * 100;
	const contextColor =
		usagePercent >= 90
			? theme.colors.error
			: usagePercent >= 70
				? theme.colors.warning
				: theme.colors.accent;

	return (
		<div
			className="px-6 py-4 border-b shrink-0"
			style={{
				borderColor: theme.colors.border,
				backgroundColor: theme.colors.bgActivity + '30',
			}}
		>
			<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
				<div className="flex flex-col">
					<div className="flex items-center gap-2 mb-1">
						<DollarSign className="w-4 h-4" style={{ color: theme.colors.success }} />
						<span
							className="text-xs font-medium uppercase tracking-wider"
							style={{ color: theme.colors.textDim }}
						>
							Cost
						</span>
					</div>
					<span className="text-lg font-mono font-semibold" style={{ color: theme.colors.success }}>
						${(viewingSession.costUsd ?? 0).toFixed(2)}
					</span>
				</div>

				<div className="flex flex-col">
					<div className="flex items-center gap-2 mb-1">
						<Timer className="w-4 h-4" style={{ color: theme.colors.warning }} />
						<span
							className="text-xs font-medium uppercase tracking-wider"
							style={{ color: theme.colors.textDim }}
						>
							Duration
						</span>
					</div>
					<span
						className="text-lg font-mono font-semibold"
						style={{ color: theme.colors.textMain }}
					>
						{formatSessionDuration(viewingSession.durationSeconds)}
					</span>
				</div>

				<div className="flex flex-col">
					<div className="flex items-center gap-2 mb-1">
						<Zap className="w-4 h-4" style={{ color: theme.colors.accent }} />
						<span
							className="text-xs font-medium uppercase tracking-wider"
							style={{ color: theme.colors.textDim }}
						>
							Total Tokens
						</span>
					</div>
					<div className="flex items-baseline gap-2">
						<span
							className="text-lg font-mono font-semibold"
							style={{ color: theme.colors.textMain }}
						>
							{formatNumber(totalTokens)}
						</span>
						<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
							of 200k context{' '}
							<span className="font-mono font-medium" style={{ color: contextColor }}>
								{Math.min(100, usagePercent).toFixed(1)}%
							</span>
						</span>
					</div>
				</div>

				<div className="flex flex-col">
					<div className="flex items-center gap-2 mb-1">
						<MessageSquare className="w-4 h-4" style={{ color: theme.colors.textDim }} />
						<span
							className="text-xs font-medium uppercase tracking-wider"
							style={{ color: theme.colors.textDim }}
						>
							Messages
						</span>
					</div>
					<span
						className="text-lg font-mono font-semibold"
						style={{ color: theme.colors.textMain }}
					>
						{viewingSession.messageCount}
					</span>
				</div>
			</div>

			<div
				className="mt-4 pt-3 border-t flex flex-wrap gap-x-6 gap-y-2"
				style={{ borderColor: theme.colors.border + '50' }}
			>
				<div className="flex items-center gap-2">
					<ArrowDownToLine className="w-3 h-3" style={{ color: theme.colors.textDim }} />
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Input:{' '}
						<span className="font-mono font-medium" style={{ color: theme.colors.textMain }}>
							{formatNumber(viewingSession.inputTokens)}
						</span>
					</span>
				</div>
				<div className="flex items-center gap-2">
					<ArrowUpFromLine className="w-3 h-3" style={{ color: theme.colors.textDim }} />
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Output:{' '}
						<span className="font-mono font-medium" style={{ color: theme.colors.textMain }}>
							{formatNumber(viewingSession.outputTokens)}
						</span>
					</span>
				</div>
				{viewingSession.cacheReadTokens > 0 && (
					<div className="flex items-center gap-2">
						<Database className="w-3 h-3" style={{ color: theme.colors.success }} />
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							Cache Read:{' '}
							<span className="font-mono font-medium" style={{ color: theme.colors.success }}>
								{formatNumber(viewingSession.cacheReadTokens)}
							</span>
						</span>
					</div>
				)}
				{viewingSession.cacheCreationTokens > 0 && (
					<div className="flex items-center gap-2">
						<Hash className="w-3 h-3" style={{ color: theme.colors.warning }} />
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							Cache Write:{' '}
							<span className="font-mono font-medium" style={{ color: theme.colors.warning }}>
								{formatNumber(viewingSession.cacheCreationTokens)}
							</span>
						</span>
					</div>
				)}
				<div className="flex items-center gap-2">
					<HardDrive className="w-3 h-3" style={{ color: theme.colors.textDim }} />
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Size:{' '}
						<span className="font-mono font-medium" style={{ color: theme.colors.textMain }}>
							{formatSize(viewingSession.sizeBytes)}
						</span>
					</span>
				</div>
			</div>
		</div>
	);
});
