/**
 * tabCloseConfirm - ask before closing a tab that would lose something, then
 * close it.
 *
 * One rule per tab kind, shared by every window that closes a tab: an app
 * window's chip close, and a tab window's (Tab Windows: the confirm runs in the
 * tab window, and only the confirmed close goes to the owner). `close` is the
 * window's own close: the app window's handler, or a tab window's `closeTab`
 * intent. The dialog is the calling window's `confirm` modal.
 */

import type { AITab, FilePreviewTab } from '../types';
import { useModalStore } from '../stores/modalStore';
import { aiTabCloseConfirmMessage } from '../utils/tabHelpers';
import { captureMessage } from '../utils/sentry';

function confirmThen(message: string | null, close: () => void, destructive?: boolean): void {
	if (!message) {
		close();
		return;
	}
	useModalStore.getState().openModal('confirm', {
		message,
		onConfirm: close,
		...(destructive && { destructive: true }),
	});
}

/** An AI tab: ask when a used wizard or an unsent draft would be lost. */
export function closeAiTabWithConfirm(tab: AITab | undefined, close: () => void): void {
	confirmThen(tab ? aiTabCloseConfirmMessage(tab) : null, close);
}

/** A file tab: ask when it has unsaved edits. */
export function closeFileTabWithConfirm(tab: FilePreviewTab | undefined, close: () => void): void {
	confirmThen(
		tab && tab.editContent !== undefined
			? `"${tab.name}${tab.extension}" has unsaved changes. Are you sure you want to close it?`
			: null,
		close
	);
}

/**
 * A terminal tab: ask when its shell is running a command (main answers that).
 * When the check fails, the tab closes without asking; the failure is reported.
 */
export function closeTerminalTabWithConfirm(ptySessionId: string, close: () => void): void {
	window.maestro.process
		.isTerminalBusy(ptySessionId)
		.then((busy) =>
			confirmThen(
				busy ? 'This terminal is running a command. Close it and stop the command?' : null,
				close,
				true
			)
		)
		.catch((err) => {
			captureMessage('isTerminalBusy IPC failed, closing tab without prompt', {
				level: 'warning',
				extra: { ptySessionId, err: String(err) },
			});
			close();
		});
}
