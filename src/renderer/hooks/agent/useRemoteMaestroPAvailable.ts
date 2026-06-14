/**
 * useRemoteMaestroPAvailable.ts
 *
 * Resolve whether `maestro-p` is on the PATH of an SSH remote, so the Claude
 * Token Source selector can disable the TUI option (and default to API) when the
 * remote can't run it. The main process probes the remote (`command -v
 * maestro-p`) and caches the result; this hook fetches it on demand.
 *
 *   - `true`      maestro-p present on the remote
 *   - `false`     known-absent (disable the TUI option)
 *   - `undefined` unknown: not an SSH remote, still probing, or unreachable
 *
 * `refresh()` re-probes the remote, bypassing the main-process TTL cache - wired
 * to the Refresh button so a user who just installed maestro-p on the remote can
 * re-check immediately. `isProbing` is true while a probe (initial or refresh)
 * is in flight, for a spinner.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { logger } from '../../utils/logger';

export interface RemoteMaestroPAvailability {
	/** true present, false known-absent, undefined unknown/probing. */
	available: boolean | undefined;
	/** A probe (initial or forced refresh) is in flight. */
	isProbing: boolean;
	/** Re-probe the remote, bypassing the cache. No-op when no remote is set. */
	refresh: () => void;
}

/**
 * @param sshRemoteId The SSH remote id to probe, or null/undefined to skip
 *                    (local agent, or SSH not yet configured).
 */
export function useRemoteMaestroPAvailable(
	sshRemoteId: string | null | undefined
): RemoteMaestroPAvailability {
	const [available, setAvailable] = useState<boolean | undefined>(undefined);
	const [isProbing, setIsProbing] = useState(false);
	// Bumped by refresh() to re-run the effect with a forced (cache-bypassing) probe.
	const [refreshNonce, setRefreshNonce] = useState(0);
	// Whether the next probe should force a re-probe. Reset to false after a
	// natural (remote-change) probe so only refresh() forces.
	const forceNextRef = useRef(false);

	const refresh = useCallback(() => {
		if (!sshRemoteId) {
			return;
		}
		forceNextRef.current = true;
		setRefreshNonce((n) => n + 1);
	}, [sshRemoteId]);

	useEffect(() => {
		if (!sshRemoteId) {
			setAvailable(undefined);
			setIsProbing(false);
			return;
		}
		let stale = false;
		const force = forceNextRef.current;
		forceNextRef.current = false;
		// On a remote change (not a refresh), reset to "unknown" so a stale answer
		// from a previously-selected remote never leaks into the gating. A refresh
		// keeps the current value on screen until the new result lands.
		if (!force) {
			setAvailable(undefined);
		}
		setIsProbing(true);
		void window.maestro.agents
			.getRemoteMaestroPAvailable(sshRemoteId, force)
			.then((result) => {
				if (!stale) {
					setAvailable(result ?? undefined);
				}
			})
			.catch((error: unknown) => {
				logger.error('Failed to probe remote maestro-p availability', undefined, error);
				if (!stale) {
					setAvailable(undefined);
				}
			})
			.finally(() => {
				if (!stale) {
					setIsProbing(false);
				}
			});
		return () => {
			stale = true;
		};
	}, [sshRemoteId, refreshNonce]);

	return { available, isProbing, refresh };
}
