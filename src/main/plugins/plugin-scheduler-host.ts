/**
 * Supervised plugin scheduler (main process).
 *
 * Fires the declarative cue triggers that active plugins contribute, on a fixed
 * poll cadence, reusing the same "managed, encore-gated, survives app restart"
 * lifecycle pattern as the Pianola supervisor. It does NOT touch the per-project
 * Cue engine - plugin triggers are global and plugin-scoped - so it cannot
 * destabilize that subsystem.
 *
 * Tier 0 executes only the safe `notify` action (a toast). The `dispatch` action
 * is honored ONLY when a dispatch implementation is injected (it requires the
 * agents:dispatch capability path, which is reviewed/wired separately); until
 * then dispatch triggers are skipped with a log line, not silently dropped.
 */

import { logger } from '../utils/logger';
import {
	computeDueTriggers,
	schedulerNowFromDate,
	type TriggerState,
} from '../../shared/plugins/plugin-scheduler';
import type { CueTriggerContribution } from '../../shared/plugins/contributions';
import type { PluginDispatchVerdict } from '../../shared/plugins/plugin-dispatch-gate';

const DEFAULT_POLL_MS = 30_000;

export interface PluginSchedulerDeps {
	/** Whether the `plugins` Encore flag is on. Re-read each tick. */
	isEnabled: () => boolean;
	/** The cue triggers contributed by currently-active plugins. */
	getTriggers: () => CueTriggerContribution[];
	/** Raise a notification (notify action). */
	notify: (trigger: CueTriggerContribution) => void;
	/** Optional: dispatch a prompt to an agent (dispatch action). */
	dispatch?: (trigger: CueTriggerContribution) => void;
	/** Risk gate for a dispatch trigger (the Pianola risk engine). When it judges
	 * a prompt ineligible (high-risk) - or when no `dispatch` sink is wired - the
	 * trigger is surfaced to the user via `notify` instead of being auto-run. */
	evaluateDispatch?: (trigger: CueTriggerContribution) => PluginDispatchVerdict;
	/** Poll cadence; defaults to 30s. */
	pollMs?: number;
}

export class PluginSchedulerHost {
	private state: Record<string, TriggerState> = {};
	private timer: NodeJS.Timeout | null = null;

	constructor(private readonly deps: PluginSchedulerDeps) {}

	/** Start the poll loop. Idempotent. Self-gates per tick on the Encore flag. */
	start(): void {
		if (this.timer) return;
		const pollMs = this.deps.pollMs ?? DEFAULT_POLL_MS;
		this.timer = setInterval(() => this.tick(), pollMs);
		// Unref so the timer never keeps the process alive on its own.
		this.timer.unref?.();
	}

	/** Stop the poll loop and clear fire state. */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.state = {};
	}

	/** One scheduling pass. Public for tests; safe to call directly. */
	tick(): void {
		if (!this.deps.isEnabled()) {
			// Feature off: drop state so re-enabling re-seeds intervals cleanly.
			this.state = {};
			return;
		}
		const triggers = this.deps.getTriggers();
		const { due, nextState } = computeDueTriggers(
			triggers,
			this.state,
			schedulerNowFromDate(new Date())
		);
		this.state = nextState;
		for (const trigger of due) {
			try {
				if (trigger.action === 'notify') {
					this.deps.notify(trigger);
				} else if (trigger.action === 'dispatch') {
					const verdict = this.deps.evaluateDispatch?.(trigger);
					if (verdict?.eligible && this.deps.dispatch) {
						this.deps.dispatch(trigger);
						logger.info(
							`[Plugins] dispatched cue trigger "${trigger.id}" (risk ${verdict.risk})`,
							'[Plugins]'
						);
					} else {
						// Blocked by risk, or auto-execution not wired (agents:dispatch
						// stays inert pending the Phase-3 sandbox): surface the intent to
						// the user instead of silently dropping it.
						this.deps.notify(trigger);
						logger.info(
							`[Plugins] cue trigger "${trigger.id}" not auto-dispatched (${verdict?.reason ?? 'dispatch gate not wired'})`,
							'[Plugins]'
						);
					}
				}
			} catch (err) {
				logger.warn(`[Plugins] cue trigger "${trigger.id}" failed: ${String(err)}`, '[Plugins]');
			}
		}
	}
}
