import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentDispatchFleetEntry } from '../../shared/agent-dispatch-types';
import { agentDispatchService } from '../services/agentDispatch';
import { workGraphService } from '../services/workGraph';

// #444: workGraph broadcast events are gone; workGraphService.onChanged is a no-op stub.
// Fleet changes now come via agentDispatch:claimStarted/claimEnded IPC events.
// The polling fallback below keeps the fleet up-to-date until callers migrate fully.

/**
 * Fetches and keeps the agent dispatch fleet up-to-date.
 *
 * Real-time updates arrive via the Work Graph broadcast channel —
 * fleet changes are published there with agentDispatch.* operation prefixes.
 * A 30-second polling fallback is included as a safety net.
 */
export function useAgentDispatchFleet() {
	const [fleet, setFleet] = useState<AgentDispatchFleetEntry[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const pendingRef = useRef(false);

	const refresh = useCallback(async () => {
		if (pendingRef.current) return;
		pendingRef.current = true;
		setLoading(true);
		setError(null);
		try {
			setFleet(await agentDispatchService.getFleet());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
			pendingRef.current = false;
		}
	}, []);

	// Subscribe to Work Graph broadcast for fleet events.
	// Fleet state changes flow through this channel with agentDispatch.* operations.
	useEffect(() => {
		void refresh();

		// #444: workGraph broadcast is gone — onChanged is a stub that never fires.
		// We keep the subscription wiring so the unsubscribe call is still valid.
		const handleEvent = (_event: unknown) => {
			void refresh();
		};

		const unsubscribe = workGraphService.onChanged(handleEvent);

		// Polling fallback: 30 s interval in case events are missed.
		const interval = setInterval(() => void refresh(), 30_000);

		return () => {
			unsubscribe();
			clearInterval(interval);
		};
	}, [refresh]);

	const pauseAgent = useCallback(
		async (agentId: string) => {
			await agentDispatchService.pauseAgent(agentId);
			await refresh();
		},
		[refresh]
	);

	const resumeAgent = useCallback(
		async (agentId: string) => {
			await agentDispatchService.resumeAgent(agentId);
			await refresh();
		},
		[refresh]
	);

	return {
		fleet,
		loading,
		error,
		refresh,
		pauseAgent,
		resumeAgent,
	};
}
