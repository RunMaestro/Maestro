import { memo, useCallback } from 'react';
import { RefreshCw, GitPullRequest, GitBranch, Clock, ExternalLink, Terminal } from 'lucide-react';
import type { Theme } from '../../../types';
import type { ActiveContribution } from '../../../../shared/symphony-types';
import { openUrl } from '../../../utils/openUrl';
import { formatDurationCompact as formatDurationMs } from '../../../../shared/formatters';
import { STATUS_COLORS, getStatusInfo } from '../helpers/statusInfo';

export interface ActiveContributionCardProps {
	contribution: ActiveContribution;
	theme: Theme;
	onFinalize: () => void;
	onSync: () => void;
	isSyncing: boolean;
	sessionName: string | null;
	/** Assigned account name for the owning agent (account multiplexing) */
	accountName?: string | null;
	onNavigateToSession: () => void;
}

export const ActiveContributionCard = memo(function ActiveContributionCard({
	contribution,
	theme,
	onFinalize,
	onSync,
	isSyncing,
	sessionName,
	accountName,
	onNavigateToSession,
}: ActiveContributionCardProps) {
	const statusInfo = getStatusInfo(contribution.status);
	const docProgress =
		contribution.progress.totalDocuments > 0
			? Math.round(
					(contribution.progress.completedDocuments / contribution.progress.totalDocuments) * 100
				)
			: 0;

	const canFinalize = contribution.status === 'ready_for_review';

	const handleOpenExternal = useCallback((url: string) => {
		openUrl(url);
	}, []);

	return (
		<div
			className="p-4 rounded-lg border"
			style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }}
		>
			<div className="flex items-start justify-between mb-2">
				<div className="flex-1 min-w-0">
					<h4
						className="font-medium text-sm truncate flex items-center gap-2"
						style={{ color: theme.colors.textMain }}
					>
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							#{contribution.issueNumber}
						</span>
						{contribution.issueTitle}
					</h4>
					<p className="text-xs truncate" style={{ color: theme.colors.textDim }}>
						{contribution.repoSlug}
					</p>
					{sessionName && (
						<div className="flex items-center gap-1.5 mt-0.5">
							<button
								onClick={onNavigateToSession}
								className="flex items-center gap-1 text-xs hover:underline cursor-pointer"
								style={{ color: theme.colors.accent }}
								title={`Go to session: ${sessionName}`}
							>
								<Terminal className="w-3 h-3" />
								<span className="truncate">{sessionName}</span>
							</button>
							{accountName && (
								<span
									style={{
										fontSize: '9px',
										padding: '1px 4px',
										borderRadius: '3px',
										backgroundColor: `${theme.colors.accent}20`,
										color: theme.colors.accent,
									}}
								>
									{accountName}
								</span>
							)}
						</div>
					)}
				</div>
				<div className="flex items-center gap-2 shrink-0">
					<button
						onClick={onSync}
						disabled={isSyncing}
						className="p-1 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
						title="Sync status with GitHub"
					>
						<RefreshCw
							className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`}
							style={{ color: theme.colors.textDim }}
						/>
					</button>
					<div
						className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs"
						style={{ backgroundColor: statusInfo.color + '20', color: statusInfo.color }}
					>
						{statusInfo.icon}
						<span>{statusInfo.label}</span>
					</div>
				</div>
			</div>

			{contribution.draftPrUrl ? (
				<button
					type="button"
					className="flex items-center gap-1 text-xs mb-2 hover:underline"
					style={{ color: theme.colors.accent }}
					onClick={() => handleOpenExternal(contribution.draftPrUrl!)}
				>
					<GitPullRequest className="w-3 h-3" />
					Draft PR #{contribution.draftPrNumber}
					<ExternalLink className="w-3 h-3" />
				</button>
			) : (
				<div
					className="flex items-center gap-1 text-xs mb-2"
					style={{ color: theme.colors.textDim }}
				>
					<GitBranch className="w-3 h-3" />
					<span>PR will be created on first commit</span>
				</div>
			)}

			<div className="mb-2">
				<div className="flex items-center justify-between text-xs mb-1">
					<span style={{ color: theme.colors.textDim }}>
						{contribution.progress.completedDocuments} / {contribution.progress.totalDocuments}{' '}
						documents
					</span>
					<span style={{ color: theme.colors.textDim }}>
						<Clock className="w-3 h-3 inline mr-1" />
						{formatDurationMs(contribution.timeSpent)}
					</span>
				</div>
				<div
					className="h-1.5 rounded-full overflow-hidden"
					style={{ backgroundColor: theme.colors.bgMain }}
				>
					<div
						className="h-full rounded-full transition-all duration-300"
						style={{ width: `${docProgress}%`, backgroundColor: theme.colors.accent }}
					/>
				</div>
				{contribution.progress.currentDocument && (
					<p className="text-xs mt-1 truncate" style={{ color: theme.colors.textDim }}>
						Current: {contribution.progress.currentDocument}
					</p>
				)}
			</div>

			{contribution.tokenUsage && (
				<div
					className="flex items-center gap-4 text-xs mb-2"
					style={{ color: theme.colors.textDim }}
				>
					<span>In: {Math.round(contribution.tokenUsage.inputTokens / 1000)}K</span>
					<span>Out: {Math.round(contribution.tokenUsage.outputTokens / 1000)}K</span>
					<span>${contribution.tokenUsage.estimatedCost.toFixed(2)}</span>
				</div>
			)}

			{contribution.error && (
				<p
					className="text-xs mb-2 p-2 rounded"
					style={{ backgroundColor: `${STATUS_COLORS.failed}20`, color: STATUS_COLORS.failed }}
				>
					{contribution.error}
				</p>
			)}

			{canFinalize && (
				<button
					onClick={onFinalize}
					className="w-full py-1.5 rounded text-xs flex items-center justify-center gap-1"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
				>
					<GitPullRequest className="w-3 h-3" /> Finalize PR
				</button>
			)}
		</div>
	);
});
