/**
 * Tap vs hold classification for a global hotkey.
 *
 * Electron's `globalShortcut` fires on PRESS and never on release. That is fine
 * for "show Maestro" and useless for push-to-talk, where the release is the
 * entire gesture: it is what says the sentence is finished. So this module turns
 * one press callback into three outcomes - tap, hold-start, hold-end - by
 * polling a platform key-state probe until the combo comes back up.
 *
 * **The probe is a seam, and today every platform returns null.** There is no
 * way to read live key state from Electron's own API: macOS would need
 * `CGEventSourceKeyState`, Windows `GetAsyncKeyState`, X11 `XQueryKeymap`, and
 * all three mean a native module Maestro does not ship. Rather than fake it
 * (auto-repeat timing is not a release signal - the OS repeat delay is longer
 * than any usable hold threshold) the detector reports `tap-only` and SAYS SO.
 * A push-to-talk key that silently behaves like a toggle is the kind of bug a
 * user blames themselves for.
 *
 * The seam is real, not decorative: `setKeyStateProbe()` is what a future native
 * module plugs into, and it is how both branches are tested. Surfaces that DO
 * have a real release event - the HUD button, the Phase 10 phone button - never
 * come through here; they call `FloorController.press()`/`release()` directly,
 * which is the same state machine this ends up driving.
 */

import { resolveHoldThresholdMs } from '../../../shared/acappella/voice-controls';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = 'ACappella';

/** What the hotkey can actually do on this machine. */
export type PressHoldCapability =
	/** Both gestures: a quick tap toggles, holding keeps the floor open. */
	| 'hold-and-tap'
	/** Press only. Every press is a tap, and hold-to-talk is unavailable. */
	| 'tap-only';

export {
	DEFAULT_HOLD_THRESHOLD_MS,
	MAX_HOLD_THRESHOLD_MS,
	MIN_HOLD_THRESHOLD_MS,
	/**
	 * Re-exported so this module stays the one import site for press-hold, even
	 * though the clamp itself moved to `shared/` when the HUD's talk button
	 * needed to classify a press against exactly the same number.
	 */
	resolveHoldThresholdMs,
} from '../../../shared/acappella/voice-controls';

/** How often the probe is asked whether the combo is still down. */
export const DEFAULT_KEY_POLL_MS = 25;

/**
 * A hold this long is a stuck key or a lying probe, not a sentence. The floor's
 * idle timeout is the real backstop; this stops the poll timer leaking.
 */
export const MAX_HOLD_MS = 60_000;

/**
 * Reports whether the combo behind an accelerator is still physically down.
 *
 * Returning `false` on the first poll is a legal answer: it means the key came
 * up between the shortcut firing and the first tick, which is exactly what a
 * tap is.
 */
export type KeyStateProbe = (accelerator: string) => boolean;

let installedProbe: KeyStateProbe | null = null;

/**
 * Install the process-wide key-state probe.
 *
 * Pass `null` to remove it, which puts every detector built afterwards back on
 * tap-only. Tests use this; a native input module would too.
 */
export function setKeyStateProbe(probe: KeyStateProbe | null): void {
	installedProbe = probe;
}

/**
 * The probe for this platform, or null when there is no reliable release signal.
 *
 * Null on every platform today - see the module header. It is a function rather
 * than a constant so installing a probe at runtime takes effect.
 */
export function resolvePlatformKeyStateProbe(): KeyStateProbe | null {
	return installedProbe;
}

/** What a detector built right now would be able to do. */
export function resolvePressHoldCapability(probe: KeyStateProbe | null): PressHoldCapability {
	return probe ? 'hold-and-tap' : 'tap-only';
}

/** The sentence the settings panel and the HUD show. Never silently degrade. */
export function describePressHoldCapability(capability: PressHoldCapability): string {
	return capability === 'hold-and-tap'
		? 'Tap to toggle the microphone, or hold the key and talk.'
		: 'Tap to toggle the microphone. Hold-to-talk needs a key-release signal this platform does not provide, so holding the key behaves like a tap.';
}

export interface PressHoldOptions {
	/** The Electron accelerator the probe is asked about. */
	accelerator: string;
	holdThresholdMs?: number;
	pollIntervalMs?: number;
	/**
	 * Override the process-wide probe. `undefined` takes the installed one;
	 * `null` forces tap-only, which is what a caller that wants toggle semantics
	 * regardless of platform passes.
	 */
	probe?: KeyStateProbe | null;
	/** A short press. Toggles the floor. */
	onTap: () => void;
	/** The key has been down past the threshold. Opens the floor. */
	onHoldStart: () => void;
	/** The key came up after a hold. Ends the utterance and closes the floor. */
	onHoldEnd: () => void;
	/** Injected clock, for tests. */
	now?: () => number;
}

/**
 * One hotkey's press classifier.
 *
 * Stateless between gestures: a press resolves to exactly one of tap or
 * hold-start/hold-end, and nothing is remembered afterwards.
 */
export class PressHoldDetector {
	readonly capability: PressHoldCapability;

	private readonly options: PressHoldOptions;
	private readonly probe: KeyStateProbe | null;
	private readonly thresholdMs: number;
	private readonly pollMs: number;
	private readonly now: () => number;

	private pressedAt: number | null = null;
	private holding = false;
	private timer: NodeJS.Timeout | null = null;
	private disposed = false;

	constructor(options: PressHoldOptions) {
		this.options = options;
		this.probe = options.probe === undefined ? resolvePlatformKeyStateProbe() : options.probe;
		this.capability = resolvePressHoldCapability(this.probe);
		this.thresholdMs = resolveHoldThresholdMs(options.holdThresholdMs);
		this.pollMs = Math.max(1, Math.round(options.pollIntervalMs ?? DEFAULT_KEY_POLL_MS));
		this.now = options.now ?? Date.now;
	}

	/** True between `onHoldStart` and `onHoldEnd`. */
	get isHolding(): boolean {
		return this.holding;
	}

	/** True while a press is being classified. */
	get isPressed(): boolean {
		return this.pressedAt !== null;
	}

	/**
	 * The global shortcut fired.
	 *
	 * Idempotent while a press is in flight, because a held key auto-repeats on
	 * Windows and Linux and a repeat is not a second gesture.
	 */
	trigger(): void {
		if (this.disposed) return;

		if (!this.probe) {
			// Tap-only: there is nothing to wait for, and delaying the toggle to find
			// out would add latency to buy an answer that never arrives.
			this.options.onTap();
			return;
		}

		if (this.pressedAt !== null) return;
		this.pressedAt = this.now();
		this.startPolling();
	}

	/**
	 * Abandon any press in flight, ending a hold cleanly.
	 *
	 * Called on rebind and on shutdown: a hold whose detector is torn down must
	 * still close the floor, or the microphone stays open with nothing watching it.
	 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopPolling();
		if (this.holding) {
			this.holding = false;
			this.pressedAt = null;
			this.safely(this.options.onHoldEnd, 'onHoldEnd');
			return;
		}
		this.pressedAt = null;
	}

	// -- Internals -----------------------------------------------------------

	private startPolling(): void {
		this.stopPolling();
		this.timer = setInterval(() => this.poll(), this.pollMs);
		// A key being watched is not a reason to keep the process alive.
		this.timer.unref?.();
	}

	private stopPolling(): void {
		if (this.timer === null) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	/**
	 * One tick.
	 *
	 * Release is checked BEFORE the threshold on purpose: a press that came up
	 * just past the threshold but before the tick resolves as a tap rather than as
	 * an instantaneous open-and-close of the floor, which is the outcome a user
	 * would read as a glitch.
	 */
	private poll(): void {
		if (this.pressedAt === null) {
			this.stopPolling();
			return;
		}

		const elapsed = this.now() - this.pressedAt;
		let down: boolean;
		try {
			down = this.probe!(this.options.accelerator);
		} catch (err) {
			// A probe that throws is a probe that cannot be trusted to report the
			// release either, so end the gesture rather than hold the floor on it.
			logger.warn(`Key state probe failed: ${(err as Error).message}`, LOG_CONTEXT);
			down = false;
		}

		if (!down) {
			this.finish(elapsed);
			return;
		}

		if (elapsed >= MAX_HOLD_MS) {
			logger.warn(
				`Hold-to-talk key reported down for ${elapsed}ms; releasing the floor`,
				LOG_CONTEXT
			);
			this.finish(elapsed);
			return;
		}

		if (!this.holding && elapsed >= this.thresholdMs) {
			this.holding = true;
			this.safely(this.options.onHoldStart, 'onHoldStart');
		}
	}

	private finish(elapsed: number): void {
		this.stopPolling();
		this.pressedAt = null;
		if (this.holding) {
			this.holding = false;
			this.safely(this.options.onHoldEnd, 'onHoldEnd');
			return;
		}
		logger.debug(`Voice hotkey tap (${elapsed}ms)`, LOG_CONTEXT);
		this.safely(this.options.onTap, 'onTap');
	}

	/**
	 * A subscriber's failure is not the classifier's failure.
	 *
	 * These callbacks drive the floor, which sends IPC; a window destroyed
	 * mid-gesture must not leave the poll timer running with a half-finished
	 * press behind it.
	 */
	private safely(fn: () => void, name: string): void {
		try {
			fn();
		} catch (err) {
			logger.error(`Press-hold ${name} threw: ${(err as Error).message}`, LOG_CONTEXT);
		}
	}
}

/** Sugar, matching the rest of A Cappella's factories. */
export function createPressHoldDetector(options: PressHoldOptions): PressHoldDetector {
	return new PressHoldDetector(options);
}
