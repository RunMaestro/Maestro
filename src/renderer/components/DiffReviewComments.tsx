/**
 * The review half of the Git Diff viewer (issue #1475): the comment box and the
 * saved comment drawn under the last line a comment covers, and the tray that
 * collects every pending comment and sends them to the agent as one review.
 *
 * The model and the prompt it becomes live in `utils/diffReviewComments.ts`;
 * pending comments live in `stores/diffReviewStore.ts`.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { MessageSquare, Pencil, Send, PencilLine, Trash2 } from 'lucide-react';
import type { Theme } from '../types';
import type { DiffComment, DiffCommentAnchor } from '../utils/diffReviewComments';
import { formatCommentLocation } from '../utils/diffReviewComments';
import { useFocusOnMount } from '../hooks/utils/useFocusAfterRender';
import { HeaderActionButton } from './ui/HeaderActionButton';
import { MiniBadge } from './ui/MiniBadge';
import { ShortcutHint, shortcutSuffix } from './ui/ShortcutHint';
import { FIXED_SHORTCUTS } from '../constants/shortcuts';
import { trackShortcutUsage } from '../utils/shortcutTracking';

const SAVE_KEYS = FIXED_SHORTCUTS.gitDiffSaveComment.keys;
const SEND_KEYS = FIXED_SHORTCUTS.gitDiffSendReview.keys;

/** How long the Discard button stays armed waiting for its confirming click. */
const DISCARD_CONFIRM_MS = 3000;

interface DiffCommentEditorProps {
	theme: Theme;
	anchor: DiffCommentAnchor;
	initialBody: string;
	isNew: boolean;
	/** Every edit, so the viewer can restore a draft when the box remounts. */
	onDraftChange?: (body: string) => void;
	onSave: (body: string) => void;
	onCancel: () => void;
}

/** Textarea for writing or editing one comment, rendered under its last line. */
export const DiffCommentEditor = memo(function DiffCommentEditor({
	theme,
	anchor,
	initialBody,
	isNew,
	onDraftChange,
	onSave,
	onCancel,
}: DiffCommentEditorProps) {
	const [body, setBody] = useState(initialBody);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	useFocusOnMount(textareaRef, 0);
	const canSave = body.trim().length > 0;
	const location = formatCommentLocation(anchor);

	return (
		<div
			className="p-2 flex flex-col gap-2 font-sans select-text"
			style={{
				backgroundColor: theme.colors.bgSidebar,
				borderLeft: `3px solid ${theme.colors.accent}`,
			}}
			data-testid="diff-comment-editor"
		>
			<span className="text-xs font-mono" style={{ color: theme.colors.textDim }}>
				{isNew ? 'Comment on' : 'Edit comment on'} {location}
			</span>
			<textarea
				ref={textareaRef}
				value={body}
				onChange={(e) => {
					setBody(e.target.value);
					onDraftChange?.(e.target.value);
				}}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
						e.preventDefault();
						// Stop here: the viewer's own Enter (view toggle) and
						// Shift+Cmd+Enter (send) listen on the window.
						e.stopPropagation();
						if (canSave) {
							onSave(body);
							trackShortcutUsage('gitDiffSaveComment');
						}
					}
				}}
				rows={3}
				placeholder="Tell the agent what to change here (Markdown allowed)"
				aria-label={`Comment on ${location}`}
				className="w-full rounded p-2 text-sm outline-none resize-y"
				style={{
					backgroundColor: theme.colors.bgMain,
					color: theme.colors.textMain,
					border: `1px solid ${theme.colors.border}`,
				}}
			/>
			<div className="flex items-center justify-end gap-2 text-xs">
				<ShortcutHint theme={theme} keys={SAVE_KEYS} label="Save:" />
				<HeaderActionButton theme={theme} variant="ghost" onClick={onCancel} className="row-hover">
					Cancel
				</HeaderActionButton>
				<HeaderActionButton
					theme={theme}
					onClick={() => onSave(body)}
					disabled={!canSave}
					testId="diff-comment-save"
					title={`${isNew ? 'Add comment' : 'Save comment'}${shortcutSuffix(SAVE_KEYS)}`}
				>
					{isNew ? 'Add Comment' : 'Save'}
				</HeaderActionButton>
			</div>
		</div>
	);
});

interface DiffCommentCardProps {
	theme: Theme;
	comment: DiffComment;
	onEdit: () => void;
	onRemove: () => void;
}

/** A saved comment, rendered under the last line it covers. */
export const DiffCommentCard = memo(function DiffCommentCard({
	theme,
	comment,
	onEdit,
	onRemove,
}: DiffCommentCardProps) {
	const location = formatCommentLocation(comment);
	return (
		<div
			className="px-3 py-2 flex items-start gap-2 font-sans text-sm"
			style={{
				backgroundColor: theme.colors.bgSidebar,
				borderLeft: `3px solid ${theme.colors.accent}`,
			}}
			data-testid="diff-comment-card"
		>
			<MessageSquare
				className="w-3.5 h-3.5 mt-0.5 shrink-0"
				style={{ color: theme.colors.accent }}
			/>
			<div className="flex-1 min-w-0 flex flex-col gap-0.5 select-text">
				<span className="text-xs font-mono" style={{ color: theme.colors.textDim }}>
					{location}
				</span>
				<p className="whitespace-pre-wrap break-words" style={{ color: theme.colors.textMain }}>
					{comment.body}
				</p>
			</div>
			<button
				type="button"
				onClick={onEdit}
				className="p-1 rounded row-hover"
				style={{ color: theme.colors.textDim }}
				aria-label={`Edit comment on ${location}`}
				title="Edit comment"
			>
				<Pencil className="w-3.5 h-3.5" />
			</button>
			<button
				type="button"
				onClick={onRemove}
				className="p-1 rounded row-hover"
				style={{ color: theme.colors.textDim }}
				aria-label={`Remove comment on ${location}`}
				title="Remove comment"
			>
				<Trash2 className="w-3.5 h-3.5" />
			</button>
		</div>
	);
});

interface DiffReviewTrayProps {
	theme: Theme;
	comments: DiffComment[];
	/**
	 * Comments whose lines changed since they were written. They stay listed
	 * (the user wrote them) but cannot be edited or sent.
	 */
	outdatedIds: ReadonlySet<string>;
	/** Agent the review goes to, for the button labels. */
	targetName?: string;
	onEdit: (comment: DiffComment) => void;
	onRemove: (id: string) => void;
	onDiscard: () => void;
	onSend: () => void;
	onEditInComposer: () => void;
}

/** Pending comments across every file in the diff, plus the ways out. */
export const DiffReviewTray = memo(function DiffReviewTray({
	theme,
	comments,
	outdatedIds,
	targetName,
	onEdit,
	onRemove,
	onDiscard,
	onSend,
	onEditInComposer,
}: DiffReviewTrayProps) {
	// Discard throws away work, so it takes a second click to confirm.
	const [discardArmed, setDiscardArmed] = useState(false);
	useEffect(() => {
		if (!discardArmed) return;
		const timer = setTimeout(() => setDiscardArmed(false), DISCARD_CONFIRM_MS);
		return () => clearTimeout(timer);
	}, [discardArmed]);

	const count = comments.length === 1 ? '1 comment' : `${comments.length} comments`;
	const agent = targetName ?? 'the agent';
	const outdatedCount = comments.filter((c) => outdatedIds.has(c.id)).length;
	const nothingToSend = outdatedCount === comments.length;
	const blockedTitle = 'Every comment is outdated: its lines changed since it was written';
	return (
		<div
			className="border-t flex flex-col"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
			data-testid="diff-review-tray"
			role="region"
			aria-label="Review"
		>
			<div className="flex items-center justify-between gap-2 px-6 py-2">
				<span className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
					Review: {count}
					{outdatedCount > 0 && (
						<span className="font-normal" style={{ color: theme.colors.textDim }}>
							{' · '}
							{outdatedCount} outdated, not sent
						</span>
					)}
				</span>
				<div className="flex items-center gap-2">
					<HeaderActionButton
						theme={theme}
						variant="ghost"
						className="row-hover"
						testId="diff-review-discard"
						onClick={() => {
							if (!discardArmed) {
								setDiscardArmed(true);
								return;
							}
							setDiscardArmed(false);
							onDiscard();
						}}
						title="Throw away every comment in this review"
					>
						<span style={discardArmed ? { color: theme.colors.error } : undefined}>
							{discardArmed ? `Discard ${count}?` : 'Discard'}
						</span>
					</HeaderActionButton>
					<HeaderActionButton
						theme={theme}
						variant="ghost"
						className="row-hover"
						icon={<PencilLine />}
						testId="diff-review-edit-in-composer"
						onClick={onEditInComposer}
						disabled={nothingToSend}
						title={
							nothingToSend
								? blockedTitle
								: `Put the review in ${agent}'s message box to edit before sending`
						}
					>
						Edit in Composer
					</HeaderActionButton>
					<HeaderActionButton
						theme={theme}
						icon={<Send />}
						testId="diff-review-send"
						onClick={onSend}
						disabled={nothingToSend}
						title={
							nothingToSend
								? blockedTitle
								: `Send every current comment to ${agent} as one prompt${shortcutSuffix(SEND_KEYS)}`
						}
					>
						{targetName ? `Send Review to ${targetName}` : 'Send Review'}
					</HeaderActionButton>
				</div>
			</div>
			<ul className="max-h-36 overflow-y-auto px-6 pb-2 flex flex-col gap-1">
				{comments.map((comment) => {
					const location = formatCommentLocation(comment);
					const outdated = outdatedIds.has(comment.id);
					return (
						<li key={comment.id} className="flex items-center gap-2 text-xs">
							<button
								type="button"
								onClick={() => onEdit(comment)}
								disabled={outdated}
								className={`flex-1 min-w-0 flex items-center gap-2 text-left rounded px-1 py-0.5 ${
									outdated ? 'cursor-default select-text' : 'row-hover'
								}`}
								title={
									outdated
										? 'Outdated: these lines changed since you commented. It will not be sent; remove it or comment on the new lines.'
										: `Edit comment on ${location}`
								}
								data-testid={outdated ? 'diff-review-outdated' : undefined}
							>
								<span
									className={`font-mono shrink-0 ${outdated ? 'line-through' : ''}`}
									style={{ color: outdated ? theme.colors.textDim : theme.colors.accent }}
								>
									{location}
								</span>
								{outdated && (
									<MiniBadge label="Outdated" theme={theme} color={theme.colors.warning} />
								)}
								<span className="truncate" style={{ color: theme.colors.textDim }}>
									{comment.body}
								</span>
							</button>
							<button
								type="button"
								onClick={() => onRemove(comment.id)}
								className="p-1 rounded row-hover shrink-0"
								style={{ color: theme.colors.textDim }}
								aria-label={`Remove comment on ${location}`}
								title="Remove comment"
							>
								<Trash2 className="w-3 h-3" />
							</button>
						</li>
					);
				})}
			</ul>
		</div>
	);
});
