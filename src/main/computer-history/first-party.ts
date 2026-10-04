/**
 * Computer History - first-party plugin supervisor hooks.
 *
 * The recorder (helper + segment writer) IS the feature's one supervised
 * background service (`computerHistory.observer` in
 * COMPUTER_HISTORY_FIRST_PARTY_PLUGIN). These hooks route the first-party
 * bridge's lifecycle (marketplace tile enable/disable, grant revocation,
 * fail-closed paths) through the SAME start/stop the boot path and the
 * `encoreFeatures` change listener use, so disabling the tile actually stops
 * the helper instead of merely hiding UI.
 *
 * - `reconcile()` starts the service when the flag is on (idempotent).
 * - `stopAll()` stops the helper and closes the open segment (idempotent).
 */

import type { FirstPartySupervisorHooks } from '../plugins/first-party-bridge';
import { captureException } from '../utils/sentry';

/** The narrow slice of ComputerHistoryService the hooks need. */
export interface ComputerHistoryLifecycle {
	start(): Promise<void>;
	stop(): Promise<void>;
}

export function createComputerHistorySupervisorHooks(
	getService: () => ComputerHistoryLifecycle | null
): FirstPartySupervisorHooks {
	const report = (operation: string) => (err: unknown) => {
		void captureException(err instanceof Error ? err : new Error(String(err)), {
			operation: `computerHistory:${operation}`,
		});
	};
	return {
		reconcile: () => {
			void getService()?.start().catch(report('reconcile'));
		},
		stopAll: () => {
			void getService()?.stop().catch(report('stopAll'));
		},
	};
}
