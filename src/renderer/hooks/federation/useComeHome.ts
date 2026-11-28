/**
 * useComeHome - bring every agent an earlier release moved onto a Federation host home, once per
 * launch (`federation:comeHome`, `src/main/federation/come-home.ts`). Main runs the job; this
 * window only starts it, because each restore is written through this window's
 * `remote:updateSessionConfig` handler. Mounted once, in App, and active only in the lifecycle
 * owner. Main does nothing while hosting is on, or when no agent is moved.
 */

import { useEffect, useRef } from 'react';
import type { ComeHomeReport } from '../../../main/federation/come-home';
import { logger } from '../../utils/logger';

/** A short beat after the agents load, so the window's request handlers are wired. */
export const COME_HOME_START_DELAY_MS = 2_000;

export interface UseComeHomeOptions {
	enabled: boolean;
	sessionsLoaded: boolean;
	/** Called with the report when the job ends. */
	onReport?: (report: ComeHomeReport) => void;
}

export function useComeHome({ enabled, sessionsLoaded, onReport }: UseComeHomeOptions): void {
	const startedRef = useRef(false);
	const onReportRef = useRef(onReport);
	onReportRef.current = onReport;

	useEffect(() => {
		const comeHome = window.maestro?.federation?.comeHome;
		if (!enabled || !sessionsLoaded || !comeHome || startedRef.current) return;
		startedRef.current = true;
		let fired = false;
		const timer = setTimeout(() => {
			fired = true;
			comeHome()
				.then((report) => onReportRef.current?.(report))
				.catch((error: unknown) => {
					logger.error('[ComeHome] The job that brings moved agents home failed', undefined, {
						error: String(error),
					});
				});
		}, COME_HOME_START_DELAY_MS);
		return () => {
			// Torn down before the beat elapsed: let the next run of the effect try.
			if (!fired) {
				clearTimeout(timer);
				startedRef.current = false;
			}
		};
	}, [enabled, sessionsLoaded]);
}
