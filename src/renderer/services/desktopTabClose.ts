import { notifyToast } from '../stores/notificationStore';
import { clearLiveDraft } from '../utils/liveDraftStore';
import { logger } from '../utils/logger';

/**
 * The desktop owns AI tab inventory. Let its next inventory snapshot remove
 * the tab in the browser, including any replacement for the last visible tab.
 * A local close would mint a second replacement and let a stale desktop save
 * resurrect the conversation on reload.
 */
export async function requestDesktopTabClose(sessionId: string, tabId: string): Promise<boolean> {
	try {
		const sent = await window.maestro.web.requestCloseTab(sessionId, tabId);
		if (!sent) throw new Error('The desktop could not receive the close request.');
		clearLiveDraft(tabId);
		return true;
	} catch (error) {
		logger.error('[requestDesktopTabClose] Failed to close desktop tab:', undefined, error);
		notifyToast({
			color: 'red',
			title: 'Could not close session',
			message: 'The desktop could not receive the close request. Please try again.',
		});
		return false;
	}
}
