/**
 * useComeHome - bring every agent an earlier release moved onto a Federation host home, once per
 * launch, and again when hosting turns off (`federation:comeHome`, `src/main/federation/come-home.ts`).
 * Main runs the job; this window only starts it, because each restore is written through this
 * window's `remote:updateSessionConfig` handler. Mounted once, in App, and active only in the
 * lifecycle owner. Main does nothing while hosting is on, or when no agent is moved; main's runner
 * is single flight, so a second start joins the run in flight.
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
import { useSettingsStore } from '../../stores/settingsStore';
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

/** Keep the newest report: a push and the read at mount may arrive in either order. */
function storeNewestReport(report: ComeHomeReport | null | undefined): void {
	if (!report) return;
	const store = useFederationAutoStore.getState();
	const current = store.comeHomeReport;
	if (current && current.finishedAt > report.finishedAt) return;
	store.setComeHomeReport(report);
}

/** A run left some agent still moved, so it is worth another run. */
const leftAgentMoved = (report: ComeHomeReport) =>
	report.agents.some((outcome) => outcome.result === 'failed');

export function useComeHome({ enabled, sessionsLoaded, onReport }: UseComeHomeOptions): void {
	const onReportRef = useRef(onReport);
	onReportRef.current = onReport;
	// Hosting turned off later (it was on at launch) needs a run too: until it runs, a moved agent's
	// messages are held here (`isAwaitingComeHome()`). Main reads the setting again itself.
	const hostingOn = useSettingsStore((s) => s.federationHostedAgents === true);

	// Every window, owner or not, keeps the last report, so its queued cards say why a moved agent's
	// messages wait: main pushes each report, and a window opened later reads the last one.
	useEffect(() => {
		const federation = window.maestro?.federation;
		if (!federation?.onComeHomeReport) return;
		const unsubscribe = federation.onComeHomeReport(storeNewestReport);
		federation
			.lastComeHomeReport?.()
			.then(storeNewestReport)
			.catch((error: unknown) => {
				captureException(error, { tags: { area: 'federation-come-home' } });
			});
		return unsubscribe;
	}, []);

	useEffect(() => {
		const comeHome = window.maestro?.federation?.comeHome;
		if (!enabled || !sessionsLoaded || hostingOn || !comeHome) return;
		// This run of the effect owns what it starts: once it is torn down (the window unmounts, loses
		// the lifecycle, or hosting turns on), a late answer announces nothing and schedules nothing.
		let active = true;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let runs = 0;
		let failureShown = false;
		const run = () => {
			timer = null;
			const first = runs++ === 0;
			comeHome()
				.then((report) => {
					// The report is true for every window that reads it, owner or not.
					storeNewestReport(report);
					if (!active) return;
					// The first run is always told; a retry only when it brought someone home.
					if (first || report.agents.some((outcome) => outcome.result !== 'failed')) {
						onReportRef.current?.(report);
					}
					if (leftAgentMoved(report)) timer = setTimeout(run, COME_HOME_RETRY_INTERVAL_MS);
				})
				.catch((error: unknown) => {
					if (!active) return;
					// Told once per run of the effect; the next try still runs, since the agents are
					// still moved.
					if (!failureShown) showComeHomeFailure(error);
					failureShown = true;
					timer = setTimeout(run, COME_HOME_RETRY_INTERVAL_MS);
				});
		};
		timer = setTimeout(run, COME_HOME_START_DELAY_MS);
		return () => {
			active = false;
			if (timer) clearTimeout(timer);
			timer = null;
		};
	}, [enabled, sessionsLoaded, hostingOn]);
}
