import { memo } from 'react';
import { Lock, GitPullRequest, FileText, ExternalLink } from 'lucide-react';
import type { Theme } from '../../../types';
import type { SymphonyIssue } from '../../../../shared/symphony-types';
import { SYMPHONY_BLOCKING_LABEL } from '../../../../shared/symphony-constants';
import { openUrl } from '../../../utils/openUrl';
import { STATUS_COLORS } from '../helpers/statusInfo';

export interface IssueCardProps {
	issue: SymphonyIssue;
	theme: Theme;
	isSelected: boolean;
	onSelect: () => void;
}

export const IssueCard = memo(function IssueCard({
	issue,
	theme,
	isSelected,
	onSelect,
}: IssueCardProps) {
	const isBlocked = issue.labels?.some(
		(l) => l.name.toLowerCase() === SYMPHONY_BLOCKING_LABEL.toLowerCase()
	);
	const isAvailable = issue.status === 'available' && !isBlocked;
	const isClaimed = issue.status === 'in_progress';
	const isSelectable = isAvailable || isBlocked;

	return (
		<div
			role={isSelectable ? 'button' : undefined}
			tabIndex={isSelectable ? 0 : -1}
			onClick={isSelectable ? onSelect : undefined}
			onKeyDown={
				isSelectable
					? (e) => {
							if (e.target !== e.currentTarget) return;
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								onSelect();
							}
						}
					: undefined
			}
			className={`w-full p-3 rounded-lg border text-left transition-all outline-none focus-visible:ring-2 ${
				isBlocked
					? 'opacity-75 hover:bg-white/5 cursor-pointer'
					: !isAvailable
						? 'opacity-60'
						: 'hover:bg-white/5 cursor-pointer'
			} ${isSelected ? 'ring-2' : ''}`}
			style={{
				backgroundColor: isSelected ? theme.colors.bgActivity : theme.colors.bgMain,
				borderColor: isSelected ? theme.colors.accent : theme.colors.border,
				...(isSelected && { boxShadow: `0 0 0 2px ${theme.colors.accent}` }),
			}}
		>
			<div className="flex items-start justify-between gap-2 mb-1">
				<h4
					className="font-medium text-sm flex items-center gap-2"
					style={{ color: isBlocked ? theme.colors.textDim : theme.colors.textMain }}
				>
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						#{issue.number}
					</span>
					{issue.title}
				</h4>
				<div className="flex items-center gap-1.5 shrink-0">
					{isBlocked && (
						<span
							className="px-1.5 py-0.5 rounded text-xs flex items-center gap-1"
							style={{
								backgroundColor: `${STATUS_COLORS.cancelled}20`,
								color: STATUS_COLORS.cancelled,
							}}
						>
							<Lock className="w-3 h-3" />
							Blocked
						</span>
					)}
					{isClaimed && (
						<span
							className="px-1.5 py-0.5 rounded text-xs flex items-center gap-1"
							style={{
								backgroundColor: `${STATUS_COLORS.running}20`,
								color: STATUS_COLORS.running,
							}}
						>
							<GitPullRequest className="w-3 h-3" />
							Claimed
						</span>
					)}
				</div>
			</div>

			<div
				className="flex flex-wrap items-center gap-3 text-xs"
				style={{ color: theme.colors.textDim }}
			>
				<span className="flex items-center gap-1">
					<FileText className="w-3 h-3" />
					{issue.documentPaths.length} {issue.documentPaths.length === 1 ? 'document' : 'documents'}
				</span>
				{isClaimed && issue.claimedByPr && (
					<button
						type="button"
						className="flex items-center gap-1 cursor-pointer hover:underline"
						style={{ color: theme.colors.accent, pointerEvents: 'auto' }}
						onClick={(e) => {
							e.stopPropagation();
							openUrl(issue.claimedByPr!.url);
						}}
					>
						<GitPullRequest className="w-3 h-3" />
						{issue.claimedByPr.isDraft ? 'Draft ' : ''}PR #{issue.claimedByPr.number} by @
						{issue.claimedByPr.author}
						<ExternalLink className="w-2.5 h-2.5" />
					</button>
				)}
			</div>

			{issue.documentPaths.length > 0 && (
				<div className="mt-2 text-xs" style={{ color: theme.colors.textDim }}>
					{issue.documentPaths.slice(0, 2).map((doc) => (
						<div key={doc.path} className="truncate">
							• {doc.name}
						</div>
					))}
					{issue.documentPaths.length > 2 && (
						<div>...and {issue.documentPaths.length - 2} more</div>
					)}
				</div>
			)}
		</div>
	);
});
