import { notifyToast } from '../../stores/notificationStore';
import { safeClipboardWrite } from '../../utils/clipboard';
import { flashCopiedToClipboard } from '../../utils/flashCopiedToClipboard';
import { captureException } from '../../utils/sentry';

/**
 * Copy the loaded file's name.
 *
 * The player's title strip is the only place that name exists in the UI, and
 * it is a drag handle with a truncated label rather than selectable text - the
 * frame is `select-none`, so a user who wants the name to paste into a note or
 * a prompt cannot get at it any other way. The button copies the name rather
 * than the path, matching what is on screen; the path is not shown there.
 *
 * Goes through `safeClipboardWrite` like every other copy in the app: the
 * Clipboard API rejects while the document is unfocused, and a player the user
 * is clicking on while another window has focus is exactly that case.
 */
export async function copyMediaFileName(name: string): Promise<void> {
	try {
		if (await safeClipboardWrite(name)) {
			flashCopiedToClipboard(name, 'File Name Copied');
			return;
		}
	} catch (err) {
		captureException(err);
	}
	notifyToast({
		color: 'red',
		title: 'Failed to Copy File Name',
		message: 'Clipboard write was rejected. Check browser permissions and try again.',
	});
}
