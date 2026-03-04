import { memo } from 'react';
import { Folder, GitBranch, Bot, Clock, Server } from 'lucide-react';
import type { Session, Theme } from '../../types';
import { getContextColor, formatActiveTime } from '../../utils/theme';

interface SessionTooltipContentProps {
	session: Session;
	theme: Theme;
	gitFileCount?: number;
	groupName?: string;
	isInBatch?: boolean;
	contextWarningYellowThreshold?: number;
	contextWarningRedThreshold?: number;
}

export const SessionTooltipContent = memo(function SessionTooltipContent({
	session,
	theme,
	gitFileCount,
	groupName,
	isInBatch = false,
	contextWarningYellowThreshold = 60,
	contextWarningRedThreshold = 80,
}: SessionTooltipContentProps) {
	const clampedContextUsage = Math.max(0, Math.min(100, session.contextUsage));

	return (
		<>
			{groupName && (
				<div
					className="text-[10px] font-bold uppercase mb-1"
					style={{ color: theme.colors.textDim }}
				>
					{groupName}
				</div>
			)}
			<div className="flex items-center gap-2 mb-2">
				<span className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
					{session.name}
				</span>
				{session.toolType !== 'terminal' && (
					<>
						{session.sessionSshRemoteConfig?.enabled && session.sshConnectionFailed && (
							<span
								className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold"
								style={{
									backgroundColor: theme.colors.error + '30',
									color: theme.colors.error,
								}}
								title="SSH connection failed"
							>
								<Server className="w-3 h-3" />
								{!(session.isGitRepo || session.worktreeBranch) && (
									<span className="uppercase">REMOTE</span>
								)}
							</span>
						)}
						{session.isGitRepo || session.worktreeBranch ? (
							<>
								{session.sessionSshRemoteConfig?.enabled && !session.sshConnectionFailed && (
									<span
										className="flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold"
										style={{
											backgroundColor: theme.colors.success + '30',
											color: theme.colors.success,
										}}
										title="Remote SSH"
									>
										<Server className="w-3 h-3" />
									</span>
								)}
								<span
									className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
									style={{
										backgroundColor: theme.colors.accent + '30',
										color: theme.colors.accent,
									}}
								>
									GIT
								</span>
							</>
						) : session.sessionSshRemoteConfig?.enabled ? (
							!session.sshConnectionFailed && (
								<span
									className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
									style={{
										backgroundColor: theme.colors.warning + '30',
										color: theme.colors.warning,
									}}
								>
									REMOTE
								</span>
							)
						) : (
							<span
								className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
								style={{
									backgroundColor: theme.colors.textDim + '20',
									color: theme.colors.textDim,
								}}
							>
								LOCAL
							</span>
						)}
					</>
				)}
				{isInBatch && (
					<span
						className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase animate-pulse"
						style={{
							backgroundColor: theme.colors.warning + '30',
							color: theme.colors.warning,
						}}
					>
						<Bot className="w-2.5 h-2.5" />
						AUTO
					</span>
				)}
			</div>
			<div className="text-[10px] capitalize mb-2" style={{ color: theme.colors.textDim }}>
				{session.state} • {session.toolType}
				{session.sessionSshRemoteConfig?.enabled ? ' (SSH)' : ''}
			</div>

			<div
				className="pt-2 mt-2 space-y-1.5"
				style={{ borderTop: `1px solid ${theme.colors.border}` }}
			>
				<div className="flex items-center justify-between text-[10px]">
					<span style={{ color: theme.colors.textDim }}>Context Window</span>
					<span style={{ color: theme.colors.textMain }}>{clampedContextUsage}%</span>
				</div>
				<div
					className="w-full h-1 rounded-full overflow-hidden"
					style={{ backgroundColor: theme.colors.border }}
				>
					<div
						className="h-full transition-all"
						style={{
							width: `${clampedContextUsage}%`,
							backgroundColor: getContextColor(
								clampedContextUsage,
								theme,
								contextWarningYellowThreshold,
								contextWarningRedThreshold
							),
						}}
					/>
				</div>

				{session.isGitRepo && gitFileCount !== undefined && gitFileCount > 0 && (
					<div className="flex items-center justify-between text-[10px] pt-1">
						<span className="flex items-center gap-1" style={{ color: theme.colors.textDim }}>
							<GitBranch className="w-3 h-3" />
							Git Changes
						</span>
						<span style={{ color: theme.colors.warning }}>{gitFileCount} files</span>
					</div>
				)}

				{session.usageStats && session.usageStats.totalCostUsd > 0 && (
					<div className="flex items-center justify-between text-[10px] pt-1">
						<span style={{ color: theme.colors.textDim }}>Agent Cost</span>
						<span className="font-mono font-bold" style={{ color: theme.colors.success }}>
							${session.usageStats.totalCostUsd.toFixed(2)}
						</span>
					</div>
				)}

				{session.activeTimeMs > 0 && (
					<div className="flex items-center justify-between text-[10px] pt-1">
						<span className="flex items-center gap-1" style={{ color: theme.colors.textDim }}>
							<Clock className="w-3 h-3" />
							Active Time
						</span>
						<span className="font-mono font-bold" style={{ color: theme.colors.accent }}>
							{formatActiveTime(session.activeTimeMs)}
						</span>
					</div>
				)}

				<div
					className="flex items-center gap-1.5 text-[10px] font-mono pt-1"
					style={{ color: theme.colors.textDim }}
				>
					<Folder className="w-3 h-3 shrink-0" />
					<span className="truncate">{session.cwd}</span>
				</div>
			</div>
		</>
	);
});
