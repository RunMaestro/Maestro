/**
 * useComeHome - bring every agent an earlier release moved onto a Federation host home, once per
 * launch (`federation:comeHome`, `src/main/federation/come-home.ts`). Main runs the job; this
 * window only starts it, because each restore is written through this window's
 * `remote:updateSessionConfig` handler. Mounted once, in App, and active only in the lifecycle
 * owner. Main does nothing while hosting is on, or when no agent is moved.
 */

import { useEffect, useRef } from 'react';
import { summarizeComeHomeReport, type ComeHomeReport } from '../../../shared/federationComeHome';
import { notifyToast } from '../../stores/notificationStore';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';

/** A short beat after the agents load, so the window's request handlers are wired. */
export const COME_HOME_START_DELAY_MS = 2_000;

/**
 * The job itself failed (not one agent's return: those are in the report). Reported to Sentry, and
 * told to the person, since the agents it was to bring home are still moved.
 */
export function showComeHomeFailure(error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	logger.error('[ComeHome] The job that brings moved agents home failed', undefined, {
		error: message,
	});
	captureException(error, { tags: { area: 'federation-come-home' } });
	notifyToast({
		color: 'red',
		title: 'Agents moved onto a host could not be brought back',
		message: `${message}\nMaestro tries again at the next launch. To try now: maestro-cli unlift --all`,
		dismissible: true,
	});
}

/**
 * The one notice after the job: which agents came home, and for one that came back offline, what
 * may be missing and where it still is. Dismissible, with no button: nothing here turns hosting or
 * automatic moves on. Nothing to say (no agent was moved) shows nothing.
 */
export function showComeHomeNotice(report: ComeHomeReport): void {
	const summary = summarizeComeHomeReport(report);
	if (!summary) return;
	notifyToast({
		color: summary.needsReview ? 'yellow' : 'green',
		title: summary.title,
		message: summary.lines.join('\n'),
		dismissible: true,
	});
}

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
				.catch(showComeHomeFailure);
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
