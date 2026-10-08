/**
 * Tab lifecycle IPC handlers.
 *
 * Main has no positive tab-close signal of its own: even a web/CLI `close_tab`
 * is forwarded to the renderer for execution (`remote:closeTab`), so tab state
 * only ever lives in the renderer. This is the one channel that reports it back,
 * so main-process subsystems holding a tab-scoped promise can retire it.
 *
 * Today the only consumer is the dispatch-callback registry: a callback armed
 * against a tab that the user then closes would otherwise sit armed until its
 * timeout and wake the caller with a bogus `timeout` up to an hour later (W1).
 */

import { ipcMain } from 'electron';
import { getDispatchCallbackRegistry } from '../../dispatch-callbacks';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = '[IPC:Tabs]';

export function registerTabsHandlers(): void {
	// Fire-and-forget: the renderer has already removed the tab, and nothing it
	// does next depends on the answer.
	ipcMain.on('tabs:aiTabClosed', (_event, agentId: unknown, tabId: unknown) => {
		if (typeof agentId !== 'string' || typeof tabId !== 'string' || !agentId || !tabId) {
			logger.warn(`Ignoring malformed tabs:aiTabClosed notification`, LOG_CONTEXT);
			return;
		}
		const cancelled = getDispatchCallbackRegistry()?.cancelForTab(agentId, tabId) ?? 0;
		if (cancelled > 0) {
			logger.info(
				`Tab ${tabId} closed - cancelled ${cancelled} armed dispatch callback(s)`,
				LOG_CONTEXT
			);
		}
	});

	logger.info('Tabs IPC handlers registered', LOG_CONTEXT);
}
