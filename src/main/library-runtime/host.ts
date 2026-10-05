/**
 * Electron main's host for the maestro-lib runtime (Phase 9, behind the `libraryRuntime` setting).
 *
 * With the setting OFF nothing here runs a runtime: `status()` says why and the desktop keeps its
 * renderer-owned agent state. With it ON, the desktop's data-dir guard has already taken
 * `maestro-runtime.lock` (CO-5), and this hands that lock to `createMaestroRuntime` (DG1) so there is
 * one lock, one heartbeat, and one release (DM1).
 *
 * A runtime that refuses to start never blocks startup (DM4): this run takes the OFF path, and the
 * guard goes back to beating the lock it still holds.
 *
 * Design: `Plans/maestro-tui-desktop-migration.md` sections 4.1 and 5.
 */

import { LIBRARY_RUNTIME_OFF, type LibraryRuntimeStatus } from '../../shared/libraryRuntime';
import {
	createMaestroRuntime,
	type MaestroRuntime,
	type RuntimeDeps,
} from '../../shared/maestro-lib/runtime';
import type { DataDirClaim } from '../app-lifecycle/data-dir-guard';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[LibraryRuntime]';

export interface LibraryRuntimeHost {
	/** Fixed for the run (DM2). */
	status(): LibraryRuntimeStatus;
	/** The runtime, when this run hosts one. */
	runtime(): MaestroRuntime | undefined;
	/**
	 * Drain the runtime's writes, stop what it started, and release the lock. A no-op when this run
	 * hosts no runtime. Safe to call twice.
	 */
	close(): Promise<void>;
}

export interface StartLibraryRuntimeOptions {
	/** The `libraryRuntime` setting, read once by the caller (DM2). */
	enabled: boolean;
	/** What the data-dir guard found at module load. */
	claim: DataDirClaim;
	/** The user data dir the guard locked. */
	dataDir: string;
	/** Where agent configs live in a dev run (the production directory `dataDir` maps to). */
	productionDataDir?: string;
	/** The desktop's seams: the process source and the tab defaults (`desktop-deps.ts`). */
	deps?: Partial<RuntimeDeps>;
	/** Called once with the refusal's message when the runtime did not start, so the caller can toast it. */
	onRefused?: (message: string) => void;
	/** A test seam. */
	create?: typeof createMaestroRuntime;
}

function off(reason: string): LibraryRuntimeHost {
	return {
		status: () => ({ hosting: false, reason }),
		runtime: () => undefined,
		close: async () => undefined,
	};
}

/**
 * Start the runtime, or say why this run has none. Never throws: every failure is an OFF run.
 *
 * Call it after the stores are initialized and before the windows load (step 5 of 4.1), so no window
 * asks `status()` before the answer is known.
 */
export async function startLibraryRuntimeHost(
	options: StartLibraryRuntimeOptions
): Promise<LibraryRuntimeHost> {
	if (!options.enabled) return off(LIBRARY_RUNTIME_OFF.reason ?? 'The setting is off.');

	const { claim } = options;
	if (claim.outcome !== 'claimed') {
		// `blocked` never reaches here (the desktop quit). `proceed`: another desktop owns the directory,
		// or the lock could not be taken, and a runtime without the lock would be a second unguarded writer.
		const reason =
			claim.outcome === 'proceed'
				? `The data directory lock is not held: ${claim.reason}`
				: 'The data directory is held by another Maestro.';
		logger.warn(`The library runtime is not started. ${reason}`, LOG_CONTEXT);
		options.onRefused?.(reason);
		return off(reason);
	}

	const create = options.create ?? createMaestroRuntime;
	// The runtime beats the lock from here, and a second beat would double the touches (DM1).
	claim.pauseHeartbeat();
	try {
		const started = await create({
			dataDir: options.dataDir,
			...(options.productionDataDir ? { productionDataDir: options.productionDataDir } : {}),
			mode: 'desktop',
			lock: claim.lock,
			// The desktop writes a synced data dir today; refusing would remove no risk it does not take (DM3).
			allowSyncedDataDir: true,
			quarantineCorruptStores: true,
			...(options.deps ? { deps: options.deps } : {}),
		});
		if (!started.ok) {
			claim.resumeHeartbeat();
			logger.warn(
				`The library runtime refused to start (${started.refusal.reason}): ${started.refusal.message}`,
				LOG_CONTEXT
			);
			options.onRefused?.(started.refusal.message);
			return off(started.refusal.message);
		}

		const { runtime } = started;
		logger.info(
			`The library runtime is hosting agent state (pid ${runtime.lock.pid}).`,
			LOG_CONTEXT
		);
		let closed: Promise<void> | undefined;
		return {
			status: () => ({ hosting: true }),
			runtime: () => runtime,
			close: () => {
				closed ??= runtime.connection.close();
				return closed;
			},
		};
	} catch (error) {
		claim.resumeHeartbeat();
		const message = error instanceof Error ? error.message : String(error);
		logger.error(`The library runtime failed to start: ${message}`, LOG_CONTEXT);
		options.onRefused?.(message);
		return off(message);
	}
}
