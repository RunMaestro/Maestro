import { useState, useEffect, useCallback, useRef } from 'react';

/** Event types that can trigger a Cue subscription */
type CueEventType = 'time.interval' | 'file.changed' | 'agent.completed';

/** Status of a Cue run */
type CueRunStatus = 'running' | 'completed' | 'failed' | 'timeout' | 'stopped';

/** An event instance produced by a trigger */
interface CueEvent {
	id: string;
	type: CueEventType;
	timestamp: string;
	triggerName: string;
	payload: Record<string, unknown>;
}

/** Result of a completed (or failed/timed-out) Cue run */
export interface CueRunResult {
	runId: string;
	sessionId: string;
	sessionName: string;
	subscriptionName: string;
	event: CueEvent;
	status: CueRunStatus;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	durationMs: number;
	startedAt: string;
	endedAt: string;
}

/** Status summary for a Cue-enabled session */
export interface CueSessionStatus {
	sessionId: string;
	sessionName: string;
	toolType: string;
	projectRoot: string;
	enabled: boolean;
	subscriptionCount: number;
	activeRuns: number;
	lastTriggered?: string;
	nextTrigger?: string;
}

export interface UseCueReturn {
	sessions: CueSessionStatus[];
	activeRuns: CueRunResult[];
	activityLog: CueRunResult[];
	queueStatus: Record<string, number>;
	loading: boolean;
	enable: () => Promise<void>;
	disable: () => Promise<void>;
	stopRun: (runId: string) => Promise<void>;
	stopAll: () => Promise<void>;
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
	const mountedRef = useRef(true);

	const refresh = useCallback(async () => {
		try {
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
		} catch {
			// Let Sentry capture if truly unexpected
		} finally {
			if (mountedRef.current) {
				setLoading(false);
			}
		}
	}, []);

	const enable = useCallback(async () => {
		await window.maestro.cue.enable();
		await refresh();
	}, [refresh]);

	const disable = useCallback(async () => {
		await window.maestro.cue.disable();
		await refresh();
	}, [refresh]);

	const stopRun = useCallback(
		async (runId: string) => {
			await window.maestro.cue.stopRun(runId);
			await refresh();
		},
		[refresh]
	);

	const stopAll = useCallback(async () => {
		await window.maestro.cue.stopAll();
		await refresh();
	}, [refresh]);

	// Initial fetch + event subscription + polling
	useEffect(() => {
		mountedRef.current = true;
		refresh();

		// Subscribe to real-time activity updates
		const unsubscribe = window.maestro.cue.onActivityUpdate(() => {
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
		enable,
		disable,
		stopRun,
		stopAll,
		refresh,
	};
}
