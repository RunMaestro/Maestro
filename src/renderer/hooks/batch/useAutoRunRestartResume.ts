/**
 * Start the Auto Runs an update restart saved, once per launch.
 *
 * Mounted in App. Only the lifecycle owner (the primary desktop window) takes
 * the saved runs: `take` deletes them, so a second window or a browser client
 * reaching for them would either race the primary or steal its runs.
 *
 * Waits for the agents to load, then a short beat more so the rest of startup
 * (capability priming, SSH reachability, listeners) is wired before the first
 * task spawns. See `src/renderer/services/autoRunRestartResume.ts`.
 */

import { useEffect, useRef } from 'react';
import type { BatchRunConfig } from '../../types';
import { resumeAutoRunsAfterRestart } from '../../services/autoRunRestartResume';
import { logger } from '../../utils/logger';

export const AUTO_RUN_RESTART_RESUME_DELAY_MS = 5_000;

export interface UseAutoRunRestartResumeOptions {
	enabled: boolean;
	sessionsLoaded: boolean;
	startBatchRun: (sessionId: string, config: BatchRunConfig, folderPath: string) => Promise<void>;
}

export function useAutoRunRestartResume({
	enabled,
	sessionsLoaded,
	startBatchRun,
}: UseAutoRunRestartResumeOptions): void {
	const startedRef = useRef(false);
	const startBatchRunRef = useRef(startBatchRun);
	startBatchRunRef.current = startBatchRun;

	useEffect(() => {
		if (!enabled || !sessionsLoaded || startedRef.current) return;
		startedRef.current = true;
		let fired = false;
		const timer = setTimeout(() => {
			fired = true;
			resumeAutoRunsAfterRestart((...args) => startBatchRunRef.current(...args)).catch(
				(error: unknown) => {
					logger.error('[AutoRunRestartResume] Could not read saved Auto Runs', undefined, {
						error: String(error),
					});
				}
			);
		}, AUTO_RUN_RESTART_RESUME_DELAY_MS);
		return () => {
			// Torn down before the beat elapsed: let the next run of the effect try.
			if (!fired) {
				clearTimeout(timer);
				startedRef.current = false;
			}
		};
	}, [enabled, sessionsLoaded]);
}
