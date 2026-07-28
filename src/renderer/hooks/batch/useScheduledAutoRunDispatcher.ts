/**
 * useScheduledAutoRunDispatcher.ts
 *
 * Fires Auto Runs that the user parked for a future date/time in the Auto Run
 * modal (see scheduledAutoRunStore). Mounted once from App.tsx.
 *
 * Polling (rather than a per-entry setTimeout) is deliberate: a long timer
 * silently under-fires when the machine sleeps, and schedules here are routinely
 * hours out ("start this when my token limit resets"). A cheap 15s tick against
 * the wall clock is correct across sleep/wake and across a hot reload.
 */

import { useEffect, useRef } from 'react';
import type { BatchRunConfig, Session } from '../../types';
import { useSessionStore, selectSessionById } from '../../stores/sessionStore';
import { useBatchStore } from '../../stores/batchStore';
import {
	useScheduledAutoRunStore,
	partitionScheduledAutoRuns,
	type ScheduledAutoRun,
} from '../../stores/scheduledAutoRunStore';
import { notifyToast } from '../../stores/notificationStore';
import { formatFutureTime } from '../../../shared/formatters';

/** How often the wall clock is checked against pending schedules. */
export const SCHEDULED_AUTO_RUN_TICK_MS = 15_000;

export interface UseScheduledAutoRunDispatcherDeps {
	/**
	 * Launches a run immediately. Wired to `handleStartBatchRun` from
	 * useAutoRunHandlers, which owns worktree dispatch and folder resolution.
	 * The config passed here never carries `scheduledFor`.
	 */
	onLaunch: (config: BatchRunConfig, options: { session: Session }) => void | Promise<void>;
}

/** True when the agent can't accept a run right now (mirrors the modal's Go gate). */
function isBlocked(session: Session, entry: ScheduledAutoRun): boolean {
	// Dispatching to a separate worktree spawns/uses a different agent, so this
	// agent being mid-thought is irrelevant - same carve-out the modal makes.
	const busyBlocks =
		(session.state === 'busy' || session.state === 'connecting') && !entry.config.worktreeTarget;
	const alreadyRunning = !!useBatchStore.getState().batchRunStates[session.id]?.isRunning;
	return busyBlocks || alreadyRunning;
}

export function useScheduledAutoRunDispatcher({ onLaunch }: UseScheduledAutoRunDispatcherDeps) {
	// Keep the launcher in a ref so the polling effect never re-subscribes when
	// App.tsx re-renders (handleStartBatchRun is not referentially stable).
	const onLaunchRef = useRef(onLaunch);
	onLaunchRef.current = onLaunch;

	useEffect(() => {
		const { hydrate } = useScheduledAutoRunStore.getState();
		let disposed = false;

		const tick = () => {
			if (disposed) return;
			const store = useScheduledAutoRunStore.getState();
			if (!store.hydrated) return;

			const { due, expired } = partitionScheduledAutoRuns(store.scheduled, Date.now());

			// Missed by more than the grace window (app was closed/asleep). Drop
			// rather than surprising the user with a run hours after they expected it.
			for (const entry of expired) {
				store.cancel(entry.sessionId);
				notifyToast({
					color: 'yellow',
					title: 'Scheduled Auto Run Missed',
					message: `Maestro was not running at the scheduled time, so the Auto Run for this agent was skipped.`,
					sessionId: entry.sessionId,
				});
			}

			for (const entry of due) {
				const session = selectSessionById(entry.sessionId)(useSessionStore.getState());
				if (!session) {
					store.cancel(entry.sessionId);
					notifyToast({
						color: 'yellow',
						title: 'Scheduled Auto Run Cancelled',
						message: 'The agent this run was scheduled for no longer exists.',
					});
					continue;
				}

				// Busy / already running: leave the entry parked and retry on the next
				// tick. It stays eligible until the grace window closes.
				if (isBlocked(session, entry)) continue;

				// Clear before launching so a slow launch can't be double-fired by the
				// next tick.
				store.cancel(entry.sessionId);
				const { scheduledFor: _scheduledFor, ...config } = entry.config;
				void Promise.resolve(onLaunchRef.current(config, { session })).catch(() => {
					// handleStartBatchRun surfaces its own failures via toasts.
				});
				notifyToast({
					color: 'green',
					title: 'Scheduled Auto Run Started',
					message: `Starting the Auto Run you scheduled for ${session.name}.`,
					sessionId: session.id,
				});
			}
		};

		void hydrate().then(() => tick());
		const interval = setInterval(tick, SCHEDULED_AUTO_RUN_TICK_MS);
		return () => {
			disposed = true;
			clearInterval(interval);
		};
	}, []);
}

/** Human-readable "starts ..." label for a pending schedule. */
export function formatScheduledAutoRunLabel(entry: ScheduledAutoRun): string {
	return formatFutureTime(entry.scheduledFor);
}
