/**
 * ContinuityPreviewModal - Context: Preview Continuity, for one AI tab.
 *
 * Shows what a continuation of the tab would have to keep: the user's own
 * constraints, what is still pending, what was checked, what failed, and what
 * could not be established, with the History excerpts it may show and the reason
 * for each one it refused. It is the same text `maestro-cli tab continuity`
 * prints, from the same function (`useSummarizeAndContinue().previewContinuity`),
 * cleaned by the same normalizer (`normalizeContinuity()`), so the notices, the
 * refused-by-reason counts and the Unknown list read the same on both surfaces.
 *
 * Read only, by construction:
 *   - The text is drawn in a <pre> as a plain string. It is never Markdown: the
 *     excerpts are model text and quoted tool output, and rendering them would
 *     turn that text into links, images and markup.
 *   - Nothing is kept. The preview lives in this component's state and goes when
 *     the modal closes: no log entry, no tab, no store, no queue item.
 *   - The only controls are Copy and Close. There is no send, no continue and no
 *     compact-with-this: the digest is evidence to read, never a prompt.
 *
 * Opened from the AI tab menu, the tiled pane menu and the command palette, each
 * with `openModal('continuityPreview', { sessionId, tabId })`. It does not follow
 * the active tab: it previews the tab it was opened for.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Theme } from '../types';
import { Modal, ModalFooter, MODAL_BUTTON_SECONDARY_CLASS } from './ui/Modal';
import { Spinner } from './ui/Spinner';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useSummarizeAndContinue } from '../hooks/agent/useSummarizeAndContinue';
import { selectSessionById, useSessionStore } from '../stores/sessionStore';
import { getTabDisplayName } from '../utils/tabHelpers';
import { safeClipboardWrite } from '../utils/clipboard';
import { flashCopiedToClipboard } from '../utils/flashCopiedToClipboard';
import { captureException } from '../utils/sentry';
import { stripControlCharacters } from '../../shared/stringUtils';
import { normalizeContinuity } from '../../shared/tabContextOps';
import type { TabContextOpResult, TabContinuityPreview } from '../../shared/tabContextOps';

export interface ContinuityPreviewModalProps {
	theme: Theme;
	/** The agent that owns the tab. */
	sessionId: string;
	/** The tab to preview. Not the active tab: the one the modal was opened for. */
	tabId: string;
	onClose: () => void;
}

type PreviewState =
	| { status: 'loading' }
	| { status: 'ready'; preview: TabContinuityPreview }
	| { status: 'failed'; error: string };

const LOADING: PreviewState = { status: 'loading' };
const UNEXPECTED_FAILURE = 'The preview could not be read. Nothing was changed.';
const EMPTY_PREVIEW = 'The preview came back empty. Nothing was changed.';
const REFUSED = 'The preview was refused. Nothing was changed.';

/**
 * Turn what `previewContinuity` answered into what the modal draws. A refusal is
 * an answer, not an exception: it says why, in plain text.
 */
function readResult(result: TabContextOpResult): PreviewState {
	if (!result.success) {
		return {
			status: 'failed',
			error: stripControlCharacters(result.error ?? '').trim() || REFUSED,
		};
	}
	const preview = normalizeContinuity(result.continuity);
	return preview ? { status: 'ready', preview } : { status: 'failed', error: EMPTY_PREVIEW };
}

export function ContinuityPreviewModal({
	theme,
	sessionId,
	tabId,
	onClose,
}: ContinuityPreviewModalProps) {
	const { previewContinuity } = useSummarizeAndContinue();
	const tabName = useSessionStore((state) => {
		const tab = selectSessionById(sessionId)(state)?.aiTabs.find((t) => t.id === tabId);
		return tab ? getTabDisplayName(tab) : null;
	});
	const [state, setState] = useState<PreviewState>(LOADING);

	useEffect(() => {
		// A late answer for a tab the modal no longer shows is dropped.
		let current = true;
		setState((previous) => (previous.status === 'loading' ? previous : LOADING));
		previewContinuity(sessionId, tabId).then(
			(result) => {
				if (current) setState(readResult(result));
			},
			(error: unknown) => {
				// Every refusal comes back as a result, so a rejection is a bug: report it.
				captureException(error, { extra: { operation: 'continuityPreview' } });
				if (current) setState({ status: 'failed', error: UNEXPECTED_FAILURE });
			}
		);
		return () => {
			current = false;
		};
	}, [previewContinuity, sessionId, tabId]);

	const text = state.status === 'ready' ? state.preview.text : '';
	const handleCopy = useCallback(() => {
		void safeClipboardWrite(text).then((copied) => {
			if (copied) flashCopiedToClipboard();
		});
	}, [text]);

	return (
		<Modal
			theme={theme}
			title="Context: Preview Continuity"
			subtitle={tabName}
			priority={MODAL_PRIORITIES.CONTINUITY_PREVIEW}
			onClose={onClose}
			width={680}
			maxHeight="80vh"
			resizeKey="modal-continuity-preview"
			defaultSize={{ width: 680, height: 460 }}
			minSize={{ width: 420, height: 260 }}
			closeOnBackdropClick
			contentClassName="flex-1 min-h-0 flex flex-col p-4"
			testId="continuity-preview-modal"
			footer={
				<div className="flex items-center gap-2 w-full">
					<span className="mr-auto text-xs" style={{ color: theme.colors.textDim }}>
						Esc closes. Nothing here is saved or sent.
					</span>
					<ModalFooter
						theme={theme}
						onCancel={onClose}
						onConfirm={onClose}
						showCancel={false}
						confirmLabel="Close"
						between={
							<button
								type="button"
								onClick={handleCopy}
								disabled={!text}
								className={`${MODAL_BUTTON_SECONDARY_CLASS} disabled:opacity-50 disabled:cursor-not-allowed`}
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								data-testid="continuity-preview-copy"
							>
								Copy
							</button>
						}
					/>
				</div>
			}
		>
			{state.status === 'loading' && (
				<div
					className="flex items-center gap-2 text-xs"
					style={{ color: theme.colors.textDim }}
					data-testid="continuity-preview-loading"
				>
					<Spinner size={14} />
					<span>Reading the tab...</span>
				</div>
			)}
			{state.status === 'failed' && (
				<p
					className="m-0 text-sm select-text"
					style={{ color: theme.colors.error }}
					role="alert"
					data-testid="continuity-preview-error"
				>
					{state.error}
				</p>
			)}
			{state.status === 'ready' && (
				<pre
					className="flex-1 min-h-0 overflow-auto scrollbar-thin p-3 m-0 rounded border text-xs font-mono whitespace-pre-wrap break-words select-text"
					style={{
						backgroundColor: theme.colors.bgMain,
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
					}}
					data-testid="continuity-preview-text"
				>
					{state.preview.text}
				</pre>
			)}
		</Modal>
	);
}

export default ContinuityPreviewModal;
