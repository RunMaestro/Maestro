/**
 * Coworking background service: the bundled MCP-server script plus the IPC
 * bridge socket the agents' MCP subprocesses dial.
 *
 * Runs only while the `coworking` Encore flag is on. Boot starts it when the
 * flag is on (`src/main/ipc/bootstrap/index.ts`), and the Encore lifecycle
 * (`src/main/encore-feature-lifecycle.ts`) starts or stops it when the flag
 * changes from any source (the Extensions toggle or `maestro-cli encore`).
 */

import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { ensureCoworkingServerScript } from './coworking-server-paths';
import { startCoworkingBridge, stopCoworkingBridge } from './coworking-bridge';
import { resolveSessionFromPidWalk } from './pid-resolution';

/** The slice of ProcessManager the bridge needs to bind a connection to an agent. */
export interface CoworkingProcessLookup {
	getSessionIdByPid(pid: number): string | null;
}

/**
 * Refresh the MCP-server script and start the bridge. Idempotent. Startup is
 * non-fatal: the feature degrades to "not available" until the next start.
 */
export async function startCoworkingService(
	getProcessManager: () => CoworkingProcessLookup | null
): Promise<void> {
	try {
		await ensureCoworkingServerScript();
		await startCoworkingBridge({
			resolveSessionFromPid: (pid) =>
				resolveSessionFromPidWalk(
					pid,
					(candidate) => getProcessManager()?.getSessionIdByPid(candidate) ?? null
				),
		});
	} catch (err) {
		// EADDRINUSE means another Maestro process already owns the bridge
		// socket/pipe for this userData slug. Bridge startup is deliberately
		// non-fatal (the feature degrades to "not available" until the next
		// launch), so a second instance losing the race is an expected
		// outcome rather than a defect worth reporting (MAESTRO-WH).
		const code = (err as NodeJS.ErrnoException | null)?.code;
		if (code !== 'EADDRINUSE') {
			void captureException(err instanceof Error ? err : new Error(String(err)), {
				operation: 'startup:coworkingBridge',
			});
		}
		logger.warn(`Failed to start coworking bridge: ${String(err)}`, 'Startup');
	}
}

/** Stop the bridge and drop its live connections. Idempotent. */
export async function stopCoworkingService(): Promise<void> {
	try {
		await stopCoworkingBridge();
	} catch (err) {
		void captureException(err instanceof Error ? err : new Error(String(err)), {
			operation: 'coworking:stopBridge',
		});
		logger.warn(`Failed to stop coworking bridge: ${String(err)}`, 'Coworking');
	}
}
