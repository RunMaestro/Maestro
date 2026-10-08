/**
 * The one path an event takes from a webhook or the GitHub poller to the run
 * manager: enabled check, filter, SusFactor, emit. It reports how the event
 * ended, so the source writes its "already handled" record (the webhook
 * delivery claim, the `cue_github_seen` row) only AFTER the event has reached
 * the run manager or was deliberately dropped, never before.
 *
 * Outcomes:
 *  - `emitted`: handed to the run manager, which has started the run (its
 *    `cue_events` row is written before the first await) or queued and
 *    persisted it. Durable either way.
 *  - `filtered`: the subscription's filter rejected it (logged).
 *  - `blocked`: SusFactor dropped it (recorded in `cue_susfactor_blocks`).
 *  - `not-running`: Cue was off when it arrived, or was switched off (or
 *    stopping) while it was being scored.
 *  - `dispatch-failed`: the dispatch threw.
 *  The last two are not final: nothing reached the run manager, so nothing
 *  may be recorded as handled. A webhook answers 503 or 500 and the poller
 *  finds the item again.
 *
 * When no scoring can run, the event is dispatched and `onOutcome` called in
 * the same synchronous step. Scoring makes it asynchronous; every event in
 * that state is tracked, and `settle()` resolves once all of them (and their
 * `onOutcome`) are done, which is what the engine's drain waits on.
 */

import type { MainLogLevel } from '../../../shared/logger-types';
import { wouldScoreText, type GuardGitHubEventParams } from '../cue-susfactor';
import { DEFAULT_CUE_SETTINGS, type CueEvent } from '../cue-types';
import { captureException } from '../../utils/sentry';
import { passesFilter } from './cue-trigger-filter';
import type { CueTriggerSourceContext } from './cue-trigger-source';

export type CueEmitOutcome = 'emitted' | 'filtered' | 'blocked' | 'not-running' | 'dispatch-failed';

/** True for an outcome after which the event must not be fired again. */
export function isFinalEmitOutcome(outcome: CueEmitOutcome): boolean {
	return outcome !== 'not-running' && outcome !== 'dispatch-failed';
}

export interface CueGuardedEmitOptions {
	/** Short description for the "triggered" log line, e.g. `github.issue`. */
	label: string;
	/** The attacker-controllable text SusFactor would score; empty skips scoring. */
	scorableText: string;
	/** The SusFactor guard for this kind of event. Must not reject. */
	guard: (params: GuardGitHubEventParams) => Promise<boolean>;
	/**
	 * Called exactly once with the outcome, inside the tracked work, so a drain
	 * that waits on `settle()` also waits for what this writes.
	 */
	onOutcome?: (outcome: CueEmitOutcome) => void;
}

export interface CueGuardedEmitter {
	/** Filter, score and emit one event; resolves with how it ended. Never rejects. */
	emit(event: CueEvent, options: CueGuardedEmitOptions): Promise<CueEmitOutcome>;
	/** Resolves once every event already accepted has reached its outcome. Never rejects. */
	settle(): Promise<void>;
}

export function createCueGuardedEmitter(ctx: CueTriggerSourceContext): CueGuardedEmitter {
	const pending = new Set<Promise<CueEmitOutcome>>();
	const log = (level: MainLogLevel, message: string) => ctx.onLog(level, message);

	function finish(outcome: CueEmitOutcome, options: CueGuardedEmitOptions): CueEmitOutcome {
		try {
			options.onOutcome?.(outcome);
		} catch (err) {
			ctx.onLog(
				'error',
				`[CUE] "${ctx.subscription.name}" could not record a handled event: ${err instanceof Error ? err.message : String(err)}`
			);
			void captureException(err, { operation: 'cue:guardedEmit:onOutcome' });
		}
		return outcome;
	}

	function dispatch(event: CueEvent, options: CueGuardedEmitOptions): CueEmitOutcome {
		// Cue may have been switched off while the score was in flight.
		if (!ctx.enabled()) return finish('not-running', options);
		ctx.onLog('cue', `[CUE] "${ctx.subscription.name}" triggered (${options.label})`);
		try {
			ctx.emit(event);
		} catch (err) {
			ctx.onLog(
				'error',
				`[CUE] "${ctx.subscription.name}" dispatch failed: ${err instanceof Error ? err.message : String(err)}`
			);
			void captureException(err, { operation: 'cue:guardedEmit:dispatch' });
			return finish('dispatch-failed', options);
		}
		return finish('emitted', options);
	}

	return {
		emit(event, options) {
			if (!ctx.enabled()) return Promise.resolve(finish('not-running', options));
			if (!passesFilter(ctx.subscription, event, log)) {
				return Promise.resolve(finish('filtered', options));
			}

			const settings = ctx.registry.get(ctx.session.id)?.config.settings;
			const enabled = settings?.susfactor_enabled !== false;
			if (!wouldScoreText(enabled, options.scorableText)) {
				return Promise.resolve(dispatch(event, options));
			}

			const work = options
				.guard({
					event,
					sessionId: ctx.session.id,
					subscriptionId: `${ctx.session.id}:${ctx.subscription.name}`,
					subscriptionName: ctx.subscription.name,
					enabled,
					threshold:
						settings?.susfactor_threshold ?? DEFAULT_CUE_SETTINGS.susfactor_threshold ?? 0.95,
					onLog: (level, message) => ctx.onLog(level as MainLogLevel, message),
				})
				// The guard fails open by contract; a rejection is treated the same.
				.catch(() => true)
				.then((allowed) => (allowed ? dispatch(event, options) : finish('blocked', options)))
				.finally(() => {
					pending.delete(work);
				});
			pending.add(work);
			return work;
		},

		async settle() {
			await Promise.allSettled([...pending]);
		},
	};
}
