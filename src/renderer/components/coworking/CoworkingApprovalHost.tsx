/**
 * Renders the front of the coworking browser-interaction approval queue as a
 * confirm dialog. Confirm settles the awaiting op true; close/cancel settles it
 * false (so a cancelled approval never hangs the agent's tool call).
 *
 * The dialog shows everything the op will do: a request's `detail` (the script
 * an eval runs, the text a type enters) in full, and every hidden character in
 * it and in the message marked by its code point. Each queued request mounts a
 * dialog of its own that answers only a fresh key press, so a held Enter
 * cannot approve the queue behind the request it answered.
 */

import { ConfirmModal } from '../ConfirmModal';
import type { Theme } from '../../types';
import { useCoworkingApprovalStore } from '../../stores/coworkingApprovalStore';
import { revealHiddenCharacters } from '../../../shared/stringUtils';
import { formatCount } from '../../../shared/formatters';

/** Past either size, the dialog says how long the detail is, above its block. */
const LONG_DETAIL_CHARACTERS = 2_000;
const LONG_DETAIL_LINES = 40;

/** A dialog with a detail block is wider, so code wraps less. */
const DETAIL_DIALOG_WIDTH = 640;

function countOf(count: number, noun: string): string {
	return `${formatCount(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** The full detail in a scrollable block that keeps every line break and
 *  wraps long lines, so no part of it sits out of view to the right. */
function ApprovalDetail({ theme, text }: { theme: Theme; text: string }) {
	const revealed = revealHiddenCharacters(text);
	const lineCount = revealed.text.split('\n').length;
	const isLong = text.length > LONG_DETAIL_CHARACTERS || lineCount > LONG_DETAIL_LINES;
	return (
		<div className="mt-4 space-y-2">
			{isLong && (
				<p
					className="text-xs"
					style={{ color: theme.colors.warning }}
					data-testid="coworking-approval-length"
				>
					{countOf(text.length, 'character')} on {countOf(lineCount, 'line')}. Scroll the box to
					read all of it.
				</p>
			)}
			{revealed.hiddenCount > 0 && (
				<p
					className="text-xs"
					style={{ color: theme.colors.warning }}
					data-testid="coworking-approval-hidden"
				>
					This text has {countOf(revealed.hiddenCount, 'hidden character')}. Each one is shown by
					its code point (U+XXXX).
				</p>
			)}
			<pre
				tabIndex={0}
				aria-label="Full text of the browser action"
				className="max-h-72 overflow-auto rounded border p-3 text-xs font-mono whitespace-pre-wrap break-words select-text scrollbar-thin"
				style={{
					backgroundColor: theme.colors.bgMain,
					borderColor: theme.colors.border,
					color: theme.colors.textMain,
				}}
				data-testid="coworking-approval-detail"
			>
				{revealed.text}
			</pre>
		</div>
	);
}

export function CoworkingApprovalHost({ theme }: { theme: Theme }) {
	const front = useCoworkingApprovalStore((s) => s.queue[0]);
	const settle = useCoworkingApprovalStore((s) => s.settle);
	if (!front) return null;
	// Keyed by request: the next queued request mounts a fresh dialog, so no
	// focus or pressed button carries over from the one just answered.
	return (
		<ConfirmModal
			key={front.id}
			theme={theme}
			title={front.title}
			message={revealHiddenCharacters(front.message).text}
			destructive
			confirmLabel="Allow"
			cancelLabel="Deny"
			initialFocus={front.focusDeny ? 'cancel' : 'confirm'}
			ignoreHeldKeys
			width={front.detail !== undefined ? DETAIL_DIALOG_WIDTH : undefined}
			onConfirm={() => settle(front.id, true)}
			onClose={() => settle(front.id, false)}
		>
			{front.detail !== undefined && <ApprovalDetail theme={theme} text={front.detail} />}
		</ConfirmModal>
	);
}
