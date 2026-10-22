import { useMemo, useRef } from 'react';
import { ImageIcon, Merge } from 'lucide-react';
import type { Theme, QueuedItem } from '../types';
import { Modal, ModalFooter } from './ui/Modal';
import { MarkdownRenderer } from './MarkdownRenderer';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { generateTerminalProseStyles } from '../utils/markdownConfig';
import { safeClipboardWrite } from '../utils/clipboard';
import { useSettingsStore } from '../stores/settingsStore';

// Scoped prose rules for the two bubbles. The modal portals out of whichever
// surface opened it (the inline chat queue or the Execution Queue browser), so
// it brings its own instead of relying on the opener's.
const MERGE_PROSE_SCOPE = 'queued-merge-prose';

interface QueuedMergeConfirmModalProps {
	theme: Theme;
	/** The message that absorbs the other one and keeps its place. */
	upper: QueuedItem;
	/** The message being folded into `upper`. */
	lower: QueuedItem;
	onConfirm: () => void;
	onCancel: () => void;
}

/**
 * Confirmation for merging one queued message into the message above it, shared
 * by the inline chat queue and the Execution Queue browser. Shows both messages
 * as they will be joined. Merge holds focus, so Enter accepts; Escape cancels.
 */
export function QueuedMergeConfirmModal({
	theme,
	upper,
	lower,
	onConfirm,
	onCancel,
}: QueuedMergeConfirmModalProps) {
	const confirmButtonRef = useRef<HTMLButtonElement>(null);
	// Same global toggle the transcript honors (Cmd+E): raw source or rendered markdown.
	const renderMarkdown = !useSettingsStore((s) => s.chatRawTextMode);
	const proseStyles = useMemo(
		() => generateTerminalProseStyles(theme, `.${MERGE_PROSE_SCOPE}`),
		[theme]
	);

	return (
		<Modal
			theme={theme}
			title="Merge Queued Messages?"
			headerIcon={<Merge className="w-5 h-5" style={{ color: theme.colors.accent }} />}
			priority={MODAL_PRIORITIES.CONFIRM}
			onClose={onCancel}
			width={560}
			initialFocusRef={confirmButtonRef}
			footer={
				<ModalFooter
					theme={theme}
					onCancel={onCancel}
					onConfirm={onConfirm}
					confirmLabel="Merge"
					confirmButtonRef={confirmButtonRef}
				/>
			}
		>
			<div className={`flex flex-col gap-2 ${MERGE_PROSE_SCOPE}`}>
				<style>{proseStyles}</style>
				<MergePreviewBubble item={upper} theme={theme} renderMarkdown={renderMarkdown} />
				<div className="flex justify-center" aria-hidden>
					<Merge className="w-4 h-4" style={{ color: theme.colors.textDim }} />
				</div>
				<MergePreviewBubble item={lower} theme={theme} renderMarkdown={renderMarkdown} />
				<p className="text-sm mt-2" style={{ color: theme.colors.textDim }}>
					Are you sure you want to merge these two messages into one? The second is added to the
					first as a new paragraph, and they send together in the first one&apos;s place. This
					can&apos;t be undone.
				</p>
			</div>
		</Modal>
	);
}

/**
 * One of the two messages in the confirmation. Same accent and markdown
 * treatment as a queued card, capped in height so two long messages still fit.
 */
function MergePreviewBubble({
	item,
	theme,
	renderMarkdown,
}: {
	item: QueuedItem;
	theme: Theme;
	renderMarkdown: boolean;
}) {
	const text = item.text ?? '';
	const imageCount = item.images?.length ?? 0;
	return (
		<div
			className="p-3 rounded-lg max-h-48 overflow-y-auto scrollbar-thin select-text"
			style={{
				backgroundColor: theme.colors.accent + '20',
				borderLeft: `3px solid ${theme.colors.accent}`,
			}}
		>
			<div
				className={`text-sm break-words ${renderMarkdown ? '' : 'whitespace-pre-wrap'}`}
				style={{ color: theme.colors.textMain }}
			>
				{renderMarkdown ? (
					<MarkdownRenderer
						content={text}
						theme={theme}
						onCopy={(copied) => void safeClipboardWrite(copied)}
						chatLineBreaks
						chatMath
					/>
				) : (
					text
				)}
			</div>
			{imageCount > 0 && (
				<div
					className="flex items-center gap-1 mt-1.5 text-xs"
					style={{ color: theme.colors.textDim }}
				>
					<ImageIcon className="w-3.5 h-3.5" />
					{imageCount} image{imageCount > 1 ? 's' : ''} attached
				</div>
			)}
		</div>
	);
}
