/**
 * External Sessions IPC Handlers
 *
 * Exposes the {@link ExternalSessionCoordinator}'s snapshot of on-disk
 * session activity to the renderer. The renderer hydrates with
 * `storage:list-external-sessions` and then subscribes to live updates
 * via the `storage:externalActivity` channel, which mirrors the
 * coordinator's `'state-changed'` event into the renderer over IPC.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { logger } from '../../utils/logger';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import { createSafeSend, type GetMainWindow } from '../../utils/safe-send';
import {
	type ExternalSessionCoordinator,
	type ExternalSessionStateChange,
	STATE_CHANGED_EVENT,
} from '../../storage/external-session-coordinator';
import type { SessionActivityEvent } from '../../../shared/sessionActivity';

const LOG_CONTEXT = '[ExternalSessions]';

/** Renderer-facing channel carrying coalesced coordinator state changes. */
export const EXTERNAL_ACTIVITY_CHANNEL = 'storage:externalActivity';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * Dependencies required for external-sessions handler registration.
 */
export interface ExternalSessionsHandlerDependencies {
	getCoordinator: () => ExternalSessionCoordinator | null;
	getMainWindow: GetMainWindow;
}

/**
 * Register all external-sessions IPC handlers and wire the coordinator's
 * `'state-changed'` event onto the {@link EXTERNAL_ACTIVITY_CHANNEL} so the
 * renderer can subscribe via `window.maestro.storage.onExternalActivity`.
 */
export function registerExternalSessionsHandlers(deps: ExternalSessionsHandlerDependencies): void {
	const { getCoordinator, getMainWindow } = deps;
	const safeSend = createSafeSend(getMainWindow as () => BrowserWindow | null);

	ipcMain.handle(
		'storage:list-external-sessions',
		withIpcErrorLogging(
			handlerOpts('listExternalSessions'),
			async (): Promise<SessionActivityEvent[]> => {
				const coordinator = getCoordinator();
				if (!coordinator) return [];
				return Array.from(coordinator.getState().values());
			}
		)
	);

	const coordinator = getCoordinator();
	if (coordinator) {
		coordinator.on(STATE_CHANGED_EVENT, (payload: ExternalSessionStateChange) => {
			safeSend(EXTERNAL_ACTIVITY_CHANNEL, payload);
		});
	}

	logger.debug(`${LOG_CONTEXT} External sessions IPC handlers registered`);
}
