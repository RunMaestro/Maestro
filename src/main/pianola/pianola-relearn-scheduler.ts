/**
 * Pianola scheduled re-learn host (main process).
 *
 * Fires the supervised, Encore-gated re-learn job on a fixed cadence (default
 * 6h), reusing the same "managed, self-gating, unref'd timer" lifecycle as the
 * plugin scheduler (PluginSchedulerHost) and the Pianola supervisor. The job
 * itself only PROPOSES (stages suggestions) and relaunches stale supervised
 * targets; it never overwrites the user's live profile or rules.
 *
 * Last-run marker: we deliberately do NOT persist a separate timestamp. The
 * staged suggestions file's `generatedAt` IS the durable last-run marker - a
 * successful run rewrites it - so "when did we last learn" is always re-derivable
 * from what was actually produced and can never drift from a side-channel
 * counter. The in-process interval simply re-fires on cadence; a tick missed
 * across an app restart is harmless because the job is idempotent (it re-stages,
 * never mutating live state).
 */

import { logger } from '../utils/logger';

/** Default re-learn cadence: 6 hours. */
const DEFAULT_INTERVAL_MS = 21_600_000;

const LOG_CONTEXT = '[PianolaRelearn]';

export interface PianolaRelearnSchedulerDeps {
	/** Whether the `pianola` Encore flag is on. Re-read on every tick. */
	isEnabled: () => boolean;
	/** Run one re-learn pass. Rejections are swallowed so the loop survives. */
	runJob: () => Promise<void>;
	/** Cadence in ms; defaults to 6h. */
	intervalMs?: number;
}

export class PianolaRelearnScheduler {
	private timer: NodeJS.Timeout | null = null;
	/**
	 * Serializes ticks: set while a re-learn pass is in flight, cleared in a
	 * finally so a slow mine can never overlap the next cadence fire.
	 */
	private inFlight = false;

	constructor(private readonly deps: PianolaRelearnSchedulerDeps) {}

	/** Start the cadence. Idempotent. Self-gates per tick on the Encore flag. */
	start(): void {
		if (this.timer) return;
		const intervalMs = this.deps.intervalMs ?? DEFAULT_INTERVAL_MS;
		this.timer = setInterval(() => this.tick(), intervalMs);
		// Unref so the cadence never keeps the process alive on its own.
		this.timer.unref?.();
	}

	/** Stop the cadence. Idempotent. */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/**
	 * One re-learn pass. Public for tests; safe to call directly. No-op when the
	 * feature is off. Serialized: while a previous pass is still in flight a new
	 * tick is skipped, so a mine slower than the cadence can never overlap runs.
	 * Any rejection is swallowed so a failed run never tears down the interval,
	 * and the in-flight flag is always cleared in a finally so a crash or
	 * rejection can never wedge the scheduler.
	 */
	tick(): void {
		if (!this.deps.isEnabled()) return;
		if (this.inFlight) return;
		this.inFlight = true;
		void this.deps
			.runJob()
			.catch((err) => {
				logger.warn(`${LOG_CONTEXT} re-learn job rejected: ${String(err)}`, LOG_CONTEXT);
			})
			.finally(() => {
				this.inFlight = false;
			});
	}
}
