import { memo, useCallback } from 'react';
import { GitMerge, GitPullRequest, X, ExternalLink } from 'lucide-react';
import type { Theme } from '../../../types';
import type { CompletedContribution } from '../../../../shared/symphony-types';
import { openUrl } from '../../../utils/openUrl';
import { formatDate } from '../helpers/formatters';
import { STATUS_COLORS } from '../helpers/statusInfo';

export interface CompletedContributionCardProps {
	contribution: CompletedContribution;
	theme: Theme;
}

export const CompletedContributionCard = memo(function CompletedContributionCard({
	contribution,
	theme,
}: CompletedContributionCardProps) {
	const handleOpenPR = useCallback(() => {
		openUrl(contribution.prUrl);
	}, [contribution.prUrl]);

	const isMerged = contribution.wasMerged ?? contribution.merged ?? false;
	const isClosed = contribution.wasClosed ?? false;

	const totalTokens = contribution.tokenUsage.inputTokens + contribution.tokenUsage.outputTokens;
	const formattedTokens =
		totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}K` : String(totalTokens);

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
				</div>
				{isMerged ? (
					<span
						className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs"
						style={{
							backgroundColor: `${STATUS_COLORS.ready_for_review}20`,
							color: STATUS_COLORS.ready_for_review,
						}}
					>
						<GitMerge className="w-3 h-3" /> Merged
					</span>
				) : isClosed ? (
					<span
						className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs"
						style={{
							backgroundColor: `${STATUS_COLORS.cancelled}20`,
							color: STATUS_COLORS.cancelled,
						}}
					>
						<X className="w-3 h-3" /> Closed
					</span>
				) : (
					<span
						className="flex items-center gap-1 px-1.5 py-0.5 rounded text-xs"
						style={{ backgroundColor: `${STATUS_COLORS.running}20`, color: STATUS_COLORS.running }}
					>
						<GitPullRequest className="w-3 h-3" /> Open
					</span>
				)}
			</div>

			<div className="flex items-center gap-3 text-xs mb-2">
				<span style={{ color: theme.colors.textDim }}>
					Completed {formatDate(contribution.completedAt)}
				</span>
				<button
					onClick={handleOpenPR}
					className="flex items-center gap-1 hover:underline"
					style={{ color: theme.colors.accent }}
				>
					<GitPullRequest className="w-3 h-3" />
					PR #{contribution.prNumber}
					<ExternalLink className="w-2.5 h-2.5" />
				</button>
			</div>

			<div className="grid grid-cols-4 gap-2 text-xs">
				<div>
					<span style={{ color: theme.colors.textDim }}>Documents</span>
					<p style={{ color: theme.colors.textMain }}>{contribution.documentsProcessed}</p>
				</div>
				<div>
					<span style={{ color: theme.colors.textDim }}>Tasks</span>
					<p style={{ color: theme.colors.textMain }}>{contribution.tasksCompleted}</p>
				</div>
				<div>
					<span style={{ color: theme.colors.textDim }}>Tokens</span>
					<p style={{ color: theme.colors.textMain }}>{formattedTokens}</p>
				</div>
				<div>
					<span style={{ color: theme.colors.textDim }}>Cost</span>
					<p style={{ color: theme.colors.accent }}>
						${contribution.tokenUsage.totalCost.toFixed(2)}
					</p>
				</div>
			</div>
		</div>
	);
});
