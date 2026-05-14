/**
 * External Sessions IPC Handlers
 *
 * Exposes the {@link ExternalSessionCoordinator}'s snapshot of on-disk
 * session activity to the renderer. The renderer hydrates with
 * `storage:list-external-sessions` and then subscribes to live updates
 * via the `state-changed` event (forwarded over IPC by the preload bridge
 * in Phase 4 task 3).
 */

import { ipcMain } from 'electron';
import { logger } from '../../utils/logger';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import type { ExternalSessionCoordinator } from '../../storage/external-session-coordinator';
import type { SessionActivityEvent } from '../../../shared/sessionActivity';

const LOG_CONTEXT = '[ExternalSessions]';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * Dependencies required for external-sessions handler registration.
 */
export interface ExternalSessionsHandlerDependencies {
	getCoordinator: () => ExternalSessionCoordinator | null;
}

/**
 * Register all external-sessions IPC handlers.
 */
export function registerExternalSessionsHandlers(deps: ExternalSessionsHandlerDependencies): void {
	const { getCoordinator } = deps;

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

	logger.debug(`${LOG_CONTEXT} External sessions IPC handlers registered`);
}
