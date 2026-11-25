/**
 * Line review comments, as GitHub draws them: the comment box and the saved
 * comment drawn under the last line a comment covers, and the tray that
 * collects every pending comment and sends them to the agent as one review.
 *
 * Shared by the Git Diff viewer (issue #1475) and the File Preview. Neither
 * component knows what a comment is pinned to: the view hands each one the
 * `path:lines` label to show. The models live in `utils/diffReviewComments.ts`
 * and `utils/fileReviewComments.ts`; pending comments live in the stores made
 * by `stores/reviewCommentStore.ts`.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { MessageSquare, Pencil, Send, PencilLine, Trash2 } from 'lucide-react';
import type { Theme } from '../types';
import type { ReviewCommentBase } from '../stores/reviewCommentStore';
import { formatCommentCount } from '../utils/reviewPrompt';
import { useFocusOnMount } from '../hooks/utils/useFocusAfterRender';
import { HeaderActionButton } from './ui/HeaderActionButton';
import { MiniBadge } from './ui/MiniBadge';
import { ShortcutHint, shortcutSuffix } from './ui/ShortcutHint';
import { FIXED_SHORTCUTS } from '../constants/shortcuts';
import { trackShortcutUsage } from '../utils/shortcutTracking';

const SAVE_KEYS = FIXED_SHORTCUTS.gitDiffSaveComment.keys;

/** How long the Discard button stays armed waiting for its confirming click. */
const DISCARD_CONFIRM_MS = 3000;

interface ReviewCommentEditorProps {
	theme: Theme;
	/** The `path:lines` the comment is pinned to, as the agent will be told. */
	location: string;
	initialBody: string;
	isNew: boolean;
	/** Every edit, so the viewer can restore a draft when the box remounts. */
	onDraftChange?: (body: string) => void;
	onSave: (body: string) => void;
	onCancel: () => void;
	/**
	 * Escape cancels the box. Off where the host's own Escape handling already
	 * peels the box first (the Git Diff viewer's modal layer); on where nothing
	 * else would see the key (a box inside the code editor).
	 */
	cancelOnEscape?: boolean;
}

/** Textarea for writing or editing one comment, rendered under its last line. */
export const ReviewCommentEditor = memo(function ReviewCommentEditor({
	theme,
	location,
	initialBody,
	isNew,
	onDraftChange,
	onSave,
	onCancel,
	cancelOnEscape = false,
}: ReviewCommentEditorProps) {
	const [body, setBody] = useState(initialBody);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	useFocusOnMount(textareaRef, 0);
	const canSave = body.trim().length > 0;

	return (
		<div
			className="p-2 flex flex-col gap-2 font-sans select-text"
			style={{
				backgroundColor: theme.colors.bgSidebar,
				borderLeft: `3px solid ${theme.colors.accent}`,
			}}
			data-testid="review-comment-editor"
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
					if (cancelOnEscape && e.key === 'Escape') {
						e.preventDefault();
						e.stopPropagation();
						onCancel();
						return;
					}
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
					testId="review-comment-save"
					title={`${isNew ? 'Add comment' : 'Save comment'}${shortcutSuffix(SAVE_KEYS)}`}
				>
					{isNew ? 'Add Comment' : 'Save'}
				</HeaderActionButton>
			</div>
		</div>
	);
});

interface ReviewCommentCardProps {
	theme: Theme;
	/** The `path:lines` the comment is pinned to. */
	location: string;
	body: string;
	onEdit: () => void;
	onRemove: () => void;
}

/** A saved comment, rendered under the last line it covers. */
export const ReviewCommentCard = memo(function ReviewCommentCard({
	theme,
	location,
	body,
	onEdit,
	onRemove,
}: ReviewCommentCardProps) {
	return (
		<div
			className="px-3 py-2 flex items-start gap-2 font-sans text-sm"
			style={{
				backgroundColor: theme.colors.bgSidebar,
				borderLeft: `3px solid ${theme.colors.accent}`,
			}}
			data-testid="review-comment-card"
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
					{body}
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

interface ReviewTrayProps<C extends ReviewCommentBase> {
	theme: Theme;
	comments: C[];
	/** The `path:lines` label of one comment. */
	formatLocation: (comment: C) => string;
	/** What the tray calls the review it collects: "Review" in the diff viewer. */
	title?: string;
	/** The chord that sends the review, when the view binds one. Named in the Send tooltip. */
	sendKeys?: string[];
	/**
	 * Comments whose lines changed since they were written. They stay listed
	 * (the user wrote them) but cannot be edited or sent.
	 */
	outdatedIds: ReadonlySet<string>;
	/** Agent the review goes to, for the button labels. */
	targetName?: string;
	onEdit: (comment: C) => void;
	onRemove: (id: string) => void;
	onDiscard: () => void;
	onSend: () => void;
	onEditInComposer: () => void;
}

/** Every pending comment of one review, plus the ways out. */
function ReviewTrayImpl<C extends ReviewCommentBase>({
	theme,
	comments,
	formatLocation,
	title = 'Review',
	sendKeys,
	outdatedIds,
	targetName,
	onEdit,
	onRemove,
	onDiscard,
	onSend,
	onEditInComposer,
}: ReviewTrayProps<C>) {
	// Discard throws away work, so it takes a second click to confirm.
	const [discardArmed, setDiscardArmed] = useState(false);
	useEffect(() => {
		if (!discardArmed) return;
		const timer = setTimeout(() => setDiscardArmed(false), DISCARD_CONFIRM_MS);
		return () => clearTimeout(timer);
	}, [discardArmed]);

	const count = formatCommentCount(comments.length);
	const agent = targetName ?? 'the agent';
	const outdatedCount = comments.filter((c) => outdatedIds.has(c.id)).length;
	const nothingToSend = outdatedCount === comments.length;
	const blockedTitle = 'Every comment is outdated: its lines changed since it was written';
	return (
		<div
			className="border-t flex flex-col"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
			data-testid="review-tray"
			role="region"
			aria-label={title}
		>
			<div className="flex items-center justify-between gap-2 px-6 py-2">
				<span className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
					{title}: {count}
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
						testId="review-discard"
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
						testId="review-edit-in-composer"
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
						testId="review-send"
						onClick={onSend}
						disabled={nothingToSend}
						title={
							nothingToSend
								? blockedTitle
								: `Send every current comment to ${agent} as one prompt${shortcutSuffix(sendKeys)}`
						}
					>
						{targetName ? `Send Review to ${targetName}` : 'Send Review'}
					</HeaderActionButton>
				</div>
			</div>
			<ul className="max-h-36 overflow-y-auto px-6 pb-2 flex flex-col gap-1">
				{comments.map((comment) => {
					const location = formatLocation(comment);
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
								data-testid={outdated ? 'review-outdated' : undefined}
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
}

export const ReviewTray = memo(ReviewTrayImpl) as typeof ReviewTrayImpl;
