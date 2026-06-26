/**
 * FeedbackDraftsList - Presentational list of persisted, resumable feedback
 * drafts. Each row shows the suggested name, created/updated times, an
 * attachment indicator, a resume click target, and a delete button. The
 * most-recent draft (drafts[0] after the list handler's updatedAt-desc sort)
 * is highlighted with an accent border.
 */

import { Paperclip, Trash2, MessageSquarePlus } from 'lucide-react';
import type { Theme } from '../types';
import { formatRelativeTime } from '../utils/formatters';
import type { FeedbackDraft } from '../stores/feedbackDraftStore';

interface FeedbackDraftsListProps {
	theme: Theme;
	drafts: FeedbackDraft[];
	onResume: (id: string) => void;
	onDelete: (id: string) => void;
}

export function FeedbackDraftsList({ theme, drafts, onResume, onDelete }: FeedbackDraftsListProps) {
	if (drafts.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center gap-2 py-12 px-6 text-center">
				<MessageSquarePlus className="w-8 h-8" style={{ color: theme.colors.textDim }} />
				<p className="text-sm font-semibold" style={{ color: theme.colors.textMain }}>
					No saved drafts
				</p>
				<p className="text-xs leading-relaxed max-w-xs" style={{ color: theme.colors.textDim }}>
					Drafts you save are kept here so you can resume your feedback later, even after closing
					Maestro.
				</p>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-2 p-4 overflow-y-auto">
			{drafts.map((draft, index) => {
				const isMostRecent = index === 0;
				return (
					<div
						key={draft.id}
						className="flex items-start gap-3 px-3 py-2.5 rounded-lg border transition-colors"
						style={{
							borderColor: isMostRecent ? theme.colors.accent : theme.colors.border,
							backgroundColor: theme.colors.bgMain,
						}}
					>
						<button
							type="button"
							onClick={() => onResume(draft.id)}
							className="flex-1 min-w-0 text-left transition-opacity hover:opacity-90"
							title="Resume this draft"
						>
							<p
								className="text-xs font-semibold truncate"
								style={{ color: theme.colors.textMain }}
								title={draft.suggestedName || 'Untitled feedback'}
							>
								{draft.suggestedName || 'Untitled feedback'}
							</p>
							<div className="flex items-center gap-2 mt-0.5 flex-wrap">
								<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
									Created {formatRelativeTime(draft.createdAt)}
								</span>
								<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
									Updated {formatRelativeTime(draft.updatedAt)}
								</span>
								{draft.attachments.length > 0 && (
									<span
										className="flex items-center gap-0.5 text-[10px]"
										style={{ color: theme.colors.textDim }}
										title={`${draft.attachments.length} attachment${draft.attachments.length === 1 ? '' : 's'}`}
									>
										<Paperclip className="w-3 h-3" />
										{draft.attachments.length}
									</span>
								)}
								{isMostRecent && (
									<span
										className="text-[10px] px-1.5 py-0.5 rounded-full"
										style={{
											backgroundColor: `${theme.colors.accent}20`,
											color: theme.colors.accent,
										}}
									>
										Most recent
									</span>
								)}
							</div>
						</button>
						<button
							type="button"
							onClick={() => onDelete(draft.id)}
							className="p-1.5 rounded transition-colors hover:bg-white/5 shrink-0"
							style={{ color: theme.colors.textDim }}
							title="Delete draft"
							aria-label="Delete draft"
						>
							<Trash2 className="w-3.5 h-3.5" />
						</button>
					</div>
				);
			})}
		</div>
	);
}
