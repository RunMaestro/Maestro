/**
 * useComeHome - bring every agent an earlier release moved onto a Federation host home, once per
 * launch (`federation:comeHome`, `src/main/federation/come-home.ts`). Main runs the job; this
 * window only starts it, because each restore is written through this window's
 * `remote:updateSessionConfig` handler. Mounted once, in App, and active only in the lifecycle
 * owner. Main does nothing while hosting is on, or when no agent is moved.
 *
 * A run that leaves an agent still moved is run again every {@link COME_HOME_RETRY_INTERVAL_MS}
 * while this window lives, so the hold on its messages ends; no timer is left once every agent is
 * home. The last report is kept in `federationAutoStore`, where the agent's queued cards read why
 * its messages wait.
 */

import { useEffect, useRef } from 'react';
import {
	COME_HOME_RETRY_INTERVAL_MS,
	summarizeComeHomeReport,
	type ComeHomeReport,
} from '../../../shared/federationComeHome';
import { useFederationAutoStore } from '../../stores/federationAutoStore';
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
		message: `${message}\nMaestro tries again every ${Math.round(COME_HOME_RETRY_INTERVAL_MS / 60_000)} minutes. To try now: maestro-cli unlift --all`,
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

/** A run left some agent still moved, so it is worth another run. */
const leftAgentMoved = (report: ComeHomeReport) =>
	report.agents.some((outcome) => outcome.result === 'failed');

export function useComeHome({ enabled, sessionsLoaded, onReport }: UseComeHomeOptions): void {
	const startedRef = useRef(false);
	const onReportRef = useRef(onReport);
	onReportRef.current = onReport;
	const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// The retry belongs to this window: it ends with it.
	useEffect(
		() => () => {
			if (retryRef.current) clearTimeout(retryRef.current);
			retryRef.current = null;
		},
		[]
	);

	useEffect(() => {
		const comeHome = window.maestro?.federation?.comeHome;
		if (!enabled || !sessionsLoaded || !comeHome || startedRef.current) return;
		startedRef.current = true;
		let fired = false;
		let runs = 0;
		let failureShown = false;
		const run = () => {
			retryRef.current = null;
			const first = runs++ === 0;
			comeHome()
				.then((report) => {
					useFederationAutoStore.getState().setComeHomeReport(report);
					// The first run is always told; a retry only when it brought someone home.
					if (first || report.agents.some((outcome) => outcome.result !== 'failed')) {
						onReportRef.current?.(report);
					}
					if (leftAgentMoved(report)) {
						retryRef.current = setTimeout(run, COME_HOME_RETRY_INTERVAL_MS);
					}
				})
				.catch((error: unknown) => {
					// Told once per window; the next try still runs, since the agents are still moved.
					if (!failureShown) showComeHomeFailure(error);
					failureShown = true;
					retryRef.current = setTimeout(run, COME_HOME_RETRY_INTERVAL_MS);
				});
		};
		const timer = setTimeout(() => {
			fired = true;
			run();
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
