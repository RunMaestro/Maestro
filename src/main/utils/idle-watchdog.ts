/**
 * @file idle-watchdog.ts
 * @description A silence budget for a supervised agent process.
 *
 * Every place Maestro spawns an agent on the user's behalf and waits for it to
 * finish needs the same answer to "is it still working, or is it wedged?", and
 * a plain `setTimeout` armed at spawn cannot tell those apart: it measures TOTAL
 * wall clock, so an agent emitting output every second and one that died a
 * minute in look identical to it. That is not a hypothetical - Group Chat's
 * participant timeout was exactly that shape, and it declared a participant dead
 * at ten minutes while the transcript showed 19-41 events per minute right
 * through the cutoff.
 *
 * So the budget here is SILENCE, not duration: the caller `touch()`es on every
 * proof of life and the clock restarts. A separate, optional hard ceiling bounds
 * the run regardless, because an agent stuck in a tool loop can chatter forever
 * and never let the idle budget expire - the two failure modes are different and
 * one timer cannot cover both.
 *
 * Deliberately free of any EventEmitter or process-manager coupling. What counts
 * as proof of life differs per caller (cross-agent consults listen to four
 * process-manager events; Group Chat is pinged from the shared data listener
 * that already resolves a session id to a room and a participant), and pushing
 * that decision into the watchdog would force one of them to fake the other's
 * event shape.
 */

export interface IdleWatchdogOptions {
	/**
	 * How long the supervised process may stay silent before `onIdle` fires.
	 * Restarted by every `touch()`.
	 */
	idleMs: number;
	/**
	 * Optional absolute ceiling on the whole run, measured from `start()` and
	 * never reset. Omit when the caller genuinely has no upper bound.
	 */
	maxMs?: number;
	/** The process went silent for `idleMs`. Fires at most once. */
	onIdle: () => void;
	/**
	 * The run exceeded `maxMs` while still producing output. Fires at most once,
	 * and never after `onIdle`. Defaults to `onIdle` when omitted, so a caller
	 * that treats the two the same does not have to pass the handler twice.
	 */
	onMax?: () => void;
}

export interface IdleWatchdog {
	/**
	 * Record proof of life and restart the silence budget. Safe to call at any
	 * frequency and after the watchdog has fired or been disarmed, where it is a
	 * no-op - output can arrive from a process that was already given up on, and
	 * re-arming then would resurrect a timer nobody is waiting for.
	 */
	touch(): void;
	/**
	 * Stop watching and release both timers. Idempotent, and the only thing a
	 * caller must do on the normal completion path.
	 */
	disarm(): void;
}

/**
 * Start watching a supervised run. The idle budget is armed immediately, so the
 * caller does not need an initial `touch()`.
 */
export function createIdleWatchdog(options: IdleWatchdogOptions): IdleWatchdog {
	const { idleMs, maxMs, onIdle, onMax } = options;

	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let maxTimer: ReturnType<typeof setTimeout> | undefined;
	// One flag guards both callbacks. A run that goes silent exactly as it hits
	// its ceiling must report one outcome, not two, and both handlers below tend
	// to kill the same process.
	let settled = false;

	const clearTimers = (): void => {
		if (idleTimer) clearTimeout(idleTimer);
		if (maxTimer) clearTimeout(maxTimer);
		idleTimer = undefined;
		maxTimer = undefined;
	};

	const settle = (fire: () => void): void => {
		if (settled) return;
		settled = true;
		clearTimers();
		fire();
	};

	const armIdle = (): void => {
		if (settled) return;
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => settle(onIdle), idleMs);
	};

	if (maxMs !== undefined) {
		maxTimer = setTimeout(() => settle(onMax ?? onIdle), maxMs);
	}
	armIdle();

	return {
		touch: armIdle,
		disarm: (): void => {
			settled = true;
			clearTimers();
		},
	};
}
