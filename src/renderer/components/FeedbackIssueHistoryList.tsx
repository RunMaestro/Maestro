/**
 * FeedbackIssueHistoryList - Presentational list of GitHub issues the user has
 * submitted through the feedback modal. Each row shows the issue title, an
 * open/closed status pill, when it was submitted, a click target that opens the
 * issue on GitHub, and a delete button that removes the local record only.
 */

import { ExternalLink, Trash2, Inbox } from 'lucide-react';
import type { Theme } from '../types';
import { formatRelativeTime } from '../utils/formatters';
import { openUrl } from '../utils/openUrl';
import type { SubmittedIssue } from '../stores/feedbackIssueHistoryStore';

interface FeedbackIssueHistoryListProps {
	theme: Theme;
	issues: SubmittedIssue[];
	onDelete: (issueNumber: number) => void;
}

export function FeedbackIssueHistoryList({
	theme,
	issues,
	onDelete,
}: FeedbackIssueHistoryListProps) {
	if (issues.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center gap-2 py-12 px-6 text-center">
				<Inbox className="w-8 h-8" style={{ color: theme.colors.textDim }} />
				<p className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
					No submitted feedback yet
				</p>
				<p className="text-xs leading-relaxed max-w-xs" style={{ color: theme.colors.textDim }}>
					Issues you submit are kept here so you can revisit them and check whether they are still
					open or have been closed.
				</p>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-2 p-4 overflow-y-auto">
			{issues.map((issue) => {
				const isOpen = issue.state === 'open';
				return (
					<div
						key={issue.number}
						className="flex items-start gap-3 px-3 py-2.5 rounded-lg border transition-colors"
						style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
					>
						<button
							type="button"
							onClick={() => openUrl(issue.url)}
							className="flex-1 min-w-0 text-left transition-opacity hover:opacity-90"
							title="Open this issue on GitHub"
						>
							<div className="flex items-center gap-2 min-w-0">
								<span
									className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0"
									style={{
										backgroundColor: isOpen
											? `${theme.colors.success}20`
											: `${theme.colors.textDim}20`,
										color: isOpen ? theme.colors.success : theme.colors.textDim,
									}}
								>
									{isOpen ? 'Open' : 'Closed'}
								</span>
								<p
									className="text-xs font-semibold truncate"
									style={{ color: theme.colors.textMain }}
									title={issue.title}
								>
									{issue.title}
								</p>
							</div>
							<div className="flex items-center gap-2 mt-0.5 flex-wrap">
								<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
									#{issue.number}
								</span>
								<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
									Submitted {formatRelativeTime(issue.submittedAt)}
								</span>
								<span
									className="flex items-center gap-0.5 text-[10px]"
									style={{ color: theme.colors.textDim }}
								>
									<ExternalLink className="w-3 h-3" />
									GitHub
								</span>
							</div>
						</button>
						<button
							type="button"
							onClick={() => onDelete(issue.number)}
							className="p-1.5 rounded transition-colors hover:bg-white/5 shrink-0"
							style={{ color: theme.colors.textDim }}
							title="Remove from history"
							aria-label="Remove from history"
						>
							<Trash2 className="w-3.5 h-3.5" />
						</button>
					</div>
				);
			})}
		</div>
	);
}
