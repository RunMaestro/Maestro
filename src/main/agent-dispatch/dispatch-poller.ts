/**
 * Dispatch Poller (#443).
 *
 * A single long-running setInterval that fires once every `intervalMs`
 * (default: 60 s).  On each tick it:
 *
 *   1. Checks whether the `agentDispatch` Encore Feature is enabled — if not,
 *      skips silently.
 *   2. Queries all projects that have at least one active dispatch slot
 *      (i.e. projects present in `projectRoleSlots`).
 *   3. Calls `runAutoPickup(projectPath)` for each project in sequence.
 *      A per-project try/catch ensures one failure cannot abort the remaining
 *      projects.
 *
 * This supplements the event-driven auto-pickup path (fleet + work-graph
 * events) with a periodic safety net that recovers work items that were
 * missed because no triggering event fired.
 *
 * Start / stop:
 *
 *   const timer = startDispatchPoller(deps);
 *   // … on app quit …
 *   stopDispatchPoller(timer);
 */

export interface DispatchPollerDeps {
	/** How often to run the pickup pass. Default: 60 000 ms (1 minute). */
	intervalMs?: number;
	/** Returns true when the agentDispatch Encore Feature is currently enabled. */
	isEncoreEnabled: () => boolean;
	/**
	 * Returns all projects that have at least one role slot configured.
	 * The poller calls `runAutoPickup` for each of these.
	 */
	getProjectsWithActiveDispatch: () => Array<{ projectPath: string }>;
	/**
	 * Triggers an auto-pickup run for the given project path.
	 * Implementations may scope the pickup to the project or run a global
	 * pass — the contract is fire-and-forget from the poller's perspective.
	 */
	runAutoPickup: (projectPath: string) => Promise<void>;
	/** Optional logger. Falls back to no-op when not provided. */
	logger?: {
		info: (msg: string) => void;
		warn: (msg: string, err?: unknown) => void;
	};
}

/**
 * Start the dispatch poller. Returns the interval handle so the caller can
 * stop it on app shutdown via `stopDispatchPoller`.
 */
export function startDispatchPoller(deps: DispatchPollerDeps): NodeJS.Timeout {
	const intervalMs = deps.intervalMs ?? 60_000;
	const log = deps.logger ?? { info: () => undefined, warn: () => undefined };

	log.info(`Dispatch poller started (intervalMs=${intervalMs})`);

	const handle = setInterval(() => {
		void runTick(deps, log);
	}, intervalMs);

	// Don't block Node from exiting if the poller is the only thing alive.
	if (handle.unref) {
		handle.unref();
	}

	return handle;
}

/**
 * Stop a previously started dispatch poller.
 */
export function stopDispatchPoller(timer: NodeJS.Timeout): void {
	clearInterval(timer);
}

async function runTick(
	deps: DispatchPollerDeps,
	log: NonNullable<DispatchPollerDeps['logger']>
): Promise<void> {
	// Gate: skip when Encore Feature is off.
	if (!deps.isEncoreEnabled()) {
		return;
	}

	const projects = deps.getProjectsWithActiveDispatch();
	if (projects.length === 0) {
		return;
	}

	log.info(`Dispatch poller tick — checking ${projects.length} project(s)`);

	for (const { projectPath } of projects) {
		try {
			await deps.runAutoPickup(projectPath);
		} catch (err) {
			log.warn(
				`Dispatch poller: runAutoPickup failed for project "${projectPath}": ${
					err instanceof Error ? err.message : String(err)
				}`,
				err
			);
		}
	}
}
