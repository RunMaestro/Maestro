import { useState, useEffect, useCallback, useRef } from 'react';
import type { CueRunResult, CueSessionStatus } from '../../shared/cue';
export type { CueRunResult, CueSessionStatus } from '../../shared/cue';
import { cueService } from '../services/cue';
import { notifyToast } from '../stores/notificationStore';

export interface UseCueReturn {
	sessions: CueSessionStatus[];
	activeRuns: CueRunResult[];
	activityLog: CueRunResult[];
	queueStatus: Record<string, number>;
	loading: boolean;
	error: string | null;
	enable: () => Promise<void>;
	disable: () => Promise<void>;
	stopRun: (runId: string) => Promise<void>;
	stopAll: () => Promise<void>;
	triggerSubscription: (
		subscriptionName: string,
		prompt?: string,
		sourceAgentId?: string
	) => Promise<void>;
	refresh: () => Promise<void>;
}

const POLL_INTERVAL_MS = 10_000;

/**
 * Hook that manages Cue state for the renderer.
 * Fetches status, active runs, and activity log from the Cue IPC API.
 * Auto-refreshes on mount, listens for activity updates, and polls periodically.
 */
export function useCue(): UseCueReturn {
	const [sessions, setSessions] = useState<CueSessionStatus[]>([]);
	const [activeRuns, setActiveRuns] = useState<CueRunResult[]>([]);
	const [activityLog, setActivityLog] = useState<CueRunResult[]>([]);
	const [queueStatus, setQueueStatus] = useState<Record<string, number>>({});
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const mountedRef = useRef(true);

	const refresh = useCallback(async () => {
		try {
			setError(null);
			// NOTE: these reads bypass the cueService wrapper deliberately.
			// cueService.* read methods swallow IPC failures and return safe
			// defaults so the rest of the UI degrades silently — but useCue
			// powers the Cue dashboard, where an IPC failure must surface as
			// a user-visible error banner. Going direct preserves the catch
			// path below; the wrapper would make `err` unreachable here.
			const [statusData, runsData, logData, queueData] = await Promise.all([
				window.maestro.cue.getStatus(),
				window.maestro.cue.getActiveRuns(),
				window.maestro.cue.getActivityLog(100),
				window.maestro.cue.getQueueStatus(),
			]);
			if (!mountedRef.current) return;
			setSessions(statusData);
			setActiveRuns(runsData);
			setActivityLog(logData);
			setQueueStatus(queueData);
		} catch (err) {
			if (!mountedRef.current) return;
			setError(err instanceof Error ? err.message : 'Failed to fetch Cue status');
		} finally {
			if (mountedRef.current) {
				setLoading(false);
			}
		}
	}, []);

	const enable = useCallback(async () => {
		await cueService.enable();
		await refresh();
	}, [refresh]);

	const disable = useCallback(async () => {
		await cueService.disable();
		await refresh();
	}, [refresh]);

	const stopRun = useCallback(
		async (runId: string) => {
			await cueService.stopRun(runId);
			await refresh();
		},
		[refresh]
	);

	const stopAll = useCallback(async () => {
		await cueService.stopAll();
		await refresh();
	}, [refresh]);

	const triggerSubscription = useCallback(
		async (subscriptionName: string, prompt?: string, sourceAgentId?: string) => {
			// Engine returns false when the subscription wasn't found OR every
			// dispatch was skipped (e.g. empty prompts on every fan-out target).
			// Surface both as a toast so the user isn't left wondering why the
			// manual trigger button did nothing.
			const dispatched = await cueService.triggerSubscription(
				subscriptionName,
				prompt,
				sourceAgentId
			);
			if (!dispatched) {
				notifyToast({
					type: 'warning',
					title: `"${subscriptionName}" didn't run`,
					message:
						'No dispatch fired. Check that each agent on this trigger has a prompt configured.',
				});
			}
			await refresh();
		},
		[refresh]
	);

	// Initial fetch + event subscription + polling
	useEffect(() => {
		mountedRef.current = true;
		refresh();

		// Subscribe to real-time activity updates
		const unsubscribe = cueService.onActivityUpdate(() => {
			refresh();
		});

		// Periodic polling for status updates (timer counts, next trigger estimates)
		const intervalId = setInterval(refresh, POLL_INTERVAL_MS);

		return () => {
			mountedRef.current = false;
			unsubscribe();
			clearInterval(intervalId);
		};
	}, [refresh]);

	return {
		sessions,
		activeRuns,
		activityLog,
		queueStatus,
		loading,
		error,
		enable,
		disable,
		stopRun,
		stopAll,
		triggerSubscription,
		refresh,
	};
}
