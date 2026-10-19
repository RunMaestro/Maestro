import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';
import { requestFromRenderer } from './remoteRequest';
import {
	normalizeTabWindowCommandResult,
	resolveTabIdInSessions,
	type TabWindowCommandRequest,
	type TabWindowCommandResult,
	type TabWindowSummary,
} from '../../../shared/tabWindowCommands';

/** The stored agent's name, or null when the store no longer has it. */
function agentNameOf(sessions: ReadonlyArray<unknown>, agentId: string): string | null {
	for (const session of sessions) {
		if (!session || typeof session !== 'object') continue;
		const record = session as { id?: unknown; name?: unknown };
		if (record.id === agentId) return typeof record.name === 'string' ? record.name : null;
	}
	return null;
}

/**
 * `maestro-cli tab pop-out`, `tab dock`, and `tab windows` (Tab Windows, TW-12).
 *
 * `list` is answered here from the window registry, through the same
 * `listTabWindows` the `tabWindows:list` IPC calls. `pop-out` and `dock` are a
 * ROUND TRIP to the agent's owner window, which runs them through
 * `services/tabWindowActions.ts`, the service every UI entry point calls. Pop
 * out must run in the owner (it writes the agent's `Session`, D1).
 *
 * Without `--agent`, the owner is found from the tab id in the sessions store:
 * every tab kind, popped or not, stays in its agent's tab arrays. The store can
 * lag one debounced write, so a tab created a moment ago needs `--agent`; the
 * owner window then resolves the id against its live session.
 */
export function registerTabWindowCommandCallbacks(
	server: WebServer,
	deps: Pick<
		WebServerFactoryDependencies,
		'getMainWindow' | 'getWindowForSession' | 'sessionsStore' | 'getTabWindows'
	>
): void {
	const { getMainWindow, getWindowForSession, sessionsStore, getTabWindows } = deps;

	server.setTabWindowCommandCallback(
		async (request: TabWindowCommandRequest): Promise<TabWindowCommandResult> => {
			const stored = sessionsStore.get<unknown>('sessions', []);
			const sessions: unknown[] = Array.isArray(stored) ? stored : [];

			if (request.action === 'list') {
				if (!getTabWindows) return { success: false, error: 'Tab windows are not configured' };
				const windows: TabWindowSummary[] = getTabWindows().map((info) => ({
					...info,
					agentName: agentNameOf(sessions, info.agentId),
				}));
				return { success: true, windows };
			}

			const tabId = request.tabId ?? '';
			let agentId = request.sessionId;
			let resolvedTabId = tabId;
			if (!agentId) {
				const found = resolveTabIdInSessions(sessions, tabId);
				if (!found.ok) return { success: false, error: found.error };
				agentId = found.resolved.agentId;
				resolvedTabId = found.resolved.tabRef.id;
			}

			const ownerWindow = getWindowForSession?.(agentId) ?? getMainWindow();
			if (!ownerWindow || !isWebContentsAvailable(ownerWindow)) {
				logger.warn('No owning window is available for tabWindowCommand', 'WebServer');
				return { success: false, error: 'Maestro window is not available' };
			}
			return requestFromRenderer<TabWindowCommandResult>(ownerWindow, 'remote:tabWindowCommand', {
				// A first pop-out builds a window, so allow more than the 3s default.
				timeoutMs: 10_000,
				fallback: { success: false, error: 'Maestro did not answer the tab window request' },
				parse: normalizeTabWindowCommandResult,
				args: [{ ...request, sessionId: agentId, tabId: resolvedTabId }],
			});
		}
	);
}
