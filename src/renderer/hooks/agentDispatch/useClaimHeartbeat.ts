/**
 * useClaimHeartbeat — renderer-side heartbeat loop (#435).
 *
 * Emits a pm:heartbeat IPC call every 60 s while the given workItemId is
 * non-null. Stops automatically when the workItemId becomes null (claim
 * released) or when the component unmounts.
 *
 * If the handler returns success=false (e.g. claim was auto-released by the
 * sweeper), the interval is cancelled — no zombie beats.
 *
 * Usage:
 *   const claimedItemId = useSelector(selectMyActiveClaimId); // null if not claimed
 *   useClaimHeartbeat(claimedItemId);
 */

import { useEffect, useRef } from 'react';

const HEARTBEAT_INTERVAL_MS = 60_000; // 60 seconds

/**
 * Fire-and-forget heartbeat loop.
 *
 * @param workItemId - ID of the currently-claimed work item, or null/undefined
 *   when no claim is held. Passing null/undefined stops the loop.
 */
export function useClaimHeartbeat(workItemId: string | null | undefined): void {
	// Keep a mutable ref to the workItemId so the interval callback always sees
	// the latest value without needing to re-register the interval.
	const workItemIdRef = useRef<string | null | undefined>(workItemId);
	workItemIdRef.current = workItemId;

	useEffect(() => {
		if (!workItemId) return;

		// Emit once immediately so the first heartbeat is not delayed 60 s.
		void beat(workItemId);

		const handle = setInterval(async () => {
			const id = workItemIdRef.current;
			if (!id) {
				clearInterval(handle);
				return;
			}

			const stopped = await beat(id);
			if (stopped) {
				clearInterval(handle);
			}
		}, HEARTBEAT_INTERVAL_MS);

		return () => {
			clearInterval(handle);
		};
		// Re-run only when the claimed item changes (new claim or release).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [workItemId]);
}

/**
 * Send a single heartbeat. Returns true if the loop should stop
 * (claim gone or feature disabled).
 */
async function beat(workItemId: string): Promise<boolean> {
	try {
		const result = await window.maestro.pmHeartbeat.beat(workItemId);
		if (!result.success) {
			// Claim is gone or feature disabled — stop the loop.
			return true;
		}
		return false;
	} catch {
		// IPC error — keep the loop alive; transient failures shouldn't kill the beat.
		return false;
	}
}
