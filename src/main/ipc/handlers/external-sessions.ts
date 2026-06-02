/**
 * External Sessions IPC Handlers
 *
 * Phase 4 of Remote Agent Visibility. Bridges the {@link ExternalSessionCoordinator}
 * (a main-process `EventEmitter`) to the renderer:
 *
 * - `'storage:list-external-sessions'` (invoke) — hydration: returns a snapshot
 *   of every currently-tracked session as `SessionActivityEvent[]`.
 * - `'storage:externalActivity'` (push) — live updates: the coordinator's
 *   `'state-changed'` event is forwarded to the renderer over this channel.
 *
 * Both paths degrade gracefully: if the coordinator failed to construct (e.g.
 * the ProcessManager wasn't ready at boot), the hydration handler returns `[]`
 * and no live subscription is wired.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { withIpcErrorLogging } from '../../utils/ipcHandler';
import { createSafeSend } from '../../utils/safe-send';
import {
	STATE_CHANGED_EVENT,
	type ExternalSessionCoordinator,
	type ExternalSessionStateChange,
} from '../../storage/external-session-coordinator';
import type { SessionActivityEvent } from '../../../shared/sessionActivity';

const LOG_CONTEXT = '[ExternalSessions]';

/** Channel used to push coalesced activity snapshots to the renderer. */
export const EXTERNAL_ACTIVITY_CHANNEL = 'storage:externalActivity';

/**
 * Dependencies for the external-sessions handlers.
 *
 * Both accessors are indirected (matching the `getProcessManager` /
 * `getMainWindow` pattern used across handlers) so the handler module never
 * captures a stale reference and tolerates a not-yet-constructed coordinator.
 */
export interface ExternalSessionsHandlerDependencies {
	getCoordinator: () => ExternalSessionCoordinator | null;
	getMainWindow: () => BrowserWindow | null;
}

/**
 * Register the external-sessions IPC handler and wire the live activity bridge.
 */
export function registerExternalSessionsHandlers(deps: ExternalSessionsHandlerDependencies): void {
	const { getCoordinator, getMainWindow } = deps;

	// Hydration: snapshot of the coordinator's tracked-session map. Returns an
	// empty array (not an error) when the coordinator is unavailable so the
	// renderer's "no external activity" state is the natural fallback.
	ipcMain.handle(
		'storage:list-external-sessions',
		withIpcErrorLogging(
			{ context: LOG_CONTEXT, operation: 'listExternalSessions' },
			async (): Promise<SessionActivityEvent[]> => {
				const coordinator = getCoordinator();
				if (!coordinator) return [];
				return Array.from(coordinator.getState().values());
			}
		)
	);

	// Live updates: forward the coordinator's debounced `'state-changed'`
	// snapshots to the renderer. Only wired if the coordinator constructed.
	const coordinator = getCoordinator();
	if (coordinator) {
		const safeSend = createSafeSend(getMainWindow);
		coordinator.on(STATE_CHANGED_EVENT, (payload: ExternalSessionStateChange) => {
			safeSend(EXTERNAL_ACTIVITY_CHANNEL, payload);
		});
	}
}
