/**
 * A Cappella floor control - who holds the microphone, and until when.
 *
 * Every surface that can take or release the floor drives this one object: the
 * Phase 06 global hotkey, the HUD button, the Phase 10 phone's push-to-talk
 * button, and (later) the wake word. They differ only in the `WakeSource` they
 * pass. That matters because floor semantics are where a voice UI feels either
 * telepathic or broken, and three independent implementations of "what does a
 * second press mean" would drift within a week.
 *
 * Two modes, and the difference is entirely in what a release means:
 *
 *   - **`tap-to-toggle`**: press opens the floor and the session stays open,
 *     hands-free, until the stop word, another press, or the idle timeout. The
 *     release is ignored, so a tap and a two-second hold do the same thing.
 *   - **`hold-to-talk`**: the floor is open exactly while the control is held.
 *     Release ends the utterance IMMEDIATELY, bypassing the VAD's endpoint
 *     silence: the user has told us the sentence is finished, so waiting 700 ms
 *     to agree with them is 700 ms of latency bought with nothing.
 *
 * **The idle timeout is the backstop for every way the floor can get stuck
 * open**: a VAD that latched on a noisy room, a hotkey release that never
 * arrived because the window lost focus mid-chord, a user who walked away. It
 * runs only while the session is `listening` - the states that follow are
 * progress, not idleness, and a slow agent must never be mistaken for a
 * forgotten microphone.
 *
 * Free of Electron, of the concrete session service, and of any input library:
 * the session arrives as an injected seam and the inputs are two methods. The
 * whole state machine is therefore testable without a keyboard, a phone, or an
 * audio device.
 */

import type {
	InterruptSource,
	VoiceEvent,
	VoiceScope,
	WakeSource,
} from '../../../shared/acappella/protocol';
import type { VoiceSessionState } from '../../../shared/acappella/session-state';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';

const LOG_CONTEXT = 'ACappella';

export type FloorMode = 'tap-to-toggle' | 'hold-to-talk';

export const FLOOR_MODES: readonly FloorMode[] = ['tap-to-toggle', 'hold-to-talk'] as const;

/**
 * Hands-free by default. Holding a key for the length of a spoken request is a
 * choice, not something to impose on someone who just wants to talk.
 */
export const DEFAULT_FLOOR_MODE: FloorMode = 'tap-to-toggle';

/**
 * Silence that closes a listening session on its own. Long enough to survive
 * someone thinking about how to phrase a request, short enough that a mic left
 * open in an empty room goes cold before anyone forgets it is there.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/** Below this an ordinary pause would hang up on the user. */
export const MIN_IDLE_TIMEOUT_MS = 5_000;

/** A half hour open microphone is already a bug; this is the ceiling on it. */
export const MAX_IDLE_TIMEOUT_MS = 30 * 60_000;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface FloorControlConfig {
	mode: FloorMode;
	/**
	 * Listening silence after which the session closes itself. `0` disables the
	 * timeout entirely, which is a supported choice for a desk setup with a
	 * hardware mute switch and a terrible one everywhere else.
	 */
	idleTimeoutMs: number;
}

export const DEFAULT_FLOOR_CONTROL_CONFIG: FloorControlConfig = {
	mode: DEFAULT_FLOOR_MODE,
	idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
};

/**
 * Fill in and sanitise a partial config.
 *
 * Clamped rather than rejected, for the same reason as `resolveVadConfig`: these
 * numbers arrive from user settings, and a typo in a preference must not be able
 * to throw somewhere that leaves the microphone open.
 */
export function resolveFloorControlConfig(
	overrides: Partial<FloorControlConfig> = {}
): FloorControlConfig {
	const merged = { ...DEFAULT_FLOOR_CONTROL_CONFIG, ...overrides };
	return {
		mode: FLOOR_MODES.includes(merged.mode) ? merged.mode : DEFAULT_FLOOR_MODE,
		idleTimeoutMs: resolveIdleTimeoutMs(merged.idleTimeoutMs),
	};
}

/** Zero passes through as "disabled"; anything else is pulled into the usable band. */
function resolveIdleTimeoutMs(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return value === 0 ? 0 : DEFAULT_IDLE_TIMEOUT_MS;
	return Math.min(MAX_IDLE_TIMEOUT_MS, Math.max(MIN_IDLE_TIMEOUT_MS, Math.round(value)));
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The slice of `VoiceSessionService` floor control needs. Narrow on purpose: it
 * opens sessions, closes them, and cuts speech off. It never routes, never
 * speaks, and never touches a provider.
 */
export interface FloorControlSession {
	getState(): VoiceSessionState;
	startSession(params: { scope: VoiceScope; source?: WakeSource }): Promise<unknown>;
	stopSession(reason: FloorSessionStopReason): Promise<void>;
	/** Barge-in. False when nothing was speaking. */
	interrupt(source?: InterruptSource): boolean;
}

/** The subset of `VoiceStopReason` floor control can produce. */
export type FloorSessionStopReason = 'user' | 'timeout' | 'shutdown';

/** Why the floor closed. Wider than the session stop reasons: not every close ends a session. */
export type FloorCloseReason =
	/** A second press in `tap-to-toggle`. */
	| 'toggle'
	/** The control was released in `hold-to-talk`. */
	| 'release'
	/** Nothing was heard for `idleTimeoutMs`. */
	| 'idle-timeout'
	/** The session ended elsewhere: the stop word, an error, a replaced session. */
	| 'session-ended'
	/** The controller was disposed. */
	| 'shutdown';

export interface FloorControlOptions extends Partial<FloorControlConfig> {
	session: FloorControlSession;
	/** What a floor opened by this controller binds to. Defaults to the conductor. */
	getScope?: () => VoiceScope;
	/**
	 * Force the recogniser to endpoint now. The hold-to-talk release path, and the
	 * only reason this module knows the recogniser exists: a user who let go of
	 * the key has already told us the utterance is over.
	 */
	endUtterance?: () => void | Promise<void>;
	/** The floor opened or closed. The seam the capture gate binds to. */
	onFloorChange?: (open: boolean, reason: FloorOpenReason | FloorCloseReason) => void;
	/** Something the caller could not have awaited went wrong. Already reported to Sentry. */
	onError?: (error: Error) => void;
}

/** Why the floor opened. Mirrors `FloorCloseReason` for the `onFloorChange` seam. */
export type FloorOpenReason = 'press' | 'session-started';

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * The floor state machine.
 *
 * Every mutating entry point returns a promise and is serialised through one
 * chain, so a double tap, a key repeat, and a release that lands while the
 * session is still starting all resolve in the order they happened rather than
 * racing each other into two sessions.
 */
export class FloorController {
	private config: FloorControlConfig;
	private readonly options: FloorControlOptions;

	private open = false;
	/** True between a `press()` and its `release()`. Only meaningful in hold mode. */
	private held = false;
	private idleTimer: NodeJS.Timeout | null = null;
	private disposed = false;
	/** Serialises the async entry points. Never rejects: every link catches. */
	private queue: Promise<void> = Promise.resolve();

	constructor(options: FloorControlOptions) {
		this.options = options;
		this.config = resolveFloorControlConfig(options);
	}

	get mode(): FloorMode {
		return this.config.mode;
	}

	get idleTimeoutMs(): number {
		return this.config.idleTimeoutMs;
	}

	/** Whether audio spoken now belongs to the session. The capture gate reads this. */
	get isFloorOpen(): boolean {
		return this.open;
	}

	/** Whether the control is currently held down. */
	get isHeld(): boolean {
		return this.held;
	}

	/**
	 * Change mode or timeout mid-session.
	 *
	 * Switching to `tap-to-toggle` while the control is held keeps the floor open
	 * and forgets the hold: the alternative is a floor that closes on a release
	 * the user made under the old rules, which reads as the app dropping the
	 * sentence they are in the middle of.
	 */
	configure(overrides: Partial<FloorControlConfig>): void {
		this.config = resolveFloorControlConfig({ ...this.config, ...overrides });
		if (this.config.mode === 'tap-to-toggle') this.held = false;
		// Restarted, not left running: a countdown armed under the old timeout would
		// otherwise outlive the setting the user just changed.
		this.syncIdleTimer(true);
	}

	/**
	 * The control went down: hotkey, HUD button, or phone button.
	 *
	 * Idempotent while held, because a held key repeats on every platform and a
	 * repeat must not toggle the floor fifty times a second.
	 */
	press(source: WakeSource = 'client-button'): Promise<void> {
		return this.enqueue(async () => {
			if (this.disposed) return;
			if (this.held) return;
			this.held = true;

			// A press over active speech means "stop talking and listen", in both
			// modes. Never "end the session": the destructive reading of a gesture
			// must not be the one you get for interrupting.
			if (this.options.session.getState() === 'speaking') {
				this.options.session.interrupt('client-button');
				this.setFloor(true, 'press');
				this.syncIdleTimer(true);
				return;
			}

			if (this.config.mode === 'tap-to-toggle' && this.open) {
				await this.closeFloor('toggle');
				return;
			}

			await this.openFloor(source);
		});
	}

	/**
	 * The control came up.
	 *
	 * Ignored in `tap-to-toggle` (a tap and a long press are the same gesture) and
	 * a no-op without a matching press, so a release delivered after a mode change
	 * or a lost keydown cannot close a floor it never opened.
	 */
	release(_source: WakeSource = 'client-button'): Promise<void> {
		return this.enqueue(async () => {
			if (!this.held) return;
			this.held = false;
			if (this.disposed) return;
			if (this.config.mode !== 'hold-to-talk') return;
			if (!this.open) return;

			// Endpoint before closing: the recogniser needs the audio it already has
			// turned into a final transcript, and the floor closing is what stops
			// more arriving.
			await this.endUtterance();
			this.setFloor(false, 'release');
			// The session stays alive to answer. The idle timeout is what eventually
			// closes it, which is the intended shape of a push-to-talk session: talk,
			// listen to the reply, go cold.
			this.syncIdleTimer(true);
		});
	}

	/**
	 * Close the floor and end the session. The hotkey's explicit stop, and what
	 * the idle timeout does on its own.
	 */
	close(reason: FloorCloseReason = 'toggle'): Promise<void> {
		return this.enqueue(() => this.closeFloor(reason));
	}

	/**
	 * Something was heard. Restarts the idle countdown.
	 *
	 * The pipeline calls this on a VAD `speech-start`, which is the earliest
	 * evidence a human is in the room - a session should not go cold at second 60
	 * of a request that started at second 58.
	 */
	noteActivity(): void {
		this.syncIdleTimer(true);
	}

	/**
	 * Follow the session's own event stream.
	 *
	 * The floor can change without going through this object: the wake word opens
	 * a session, the stop word ends one, a provider failure parks it in `error`.
	 * Subscribing keeps the controller's view honest rather than making every
	 * other path remember to tell it.
	 */
	handleEvent(event: VoiceEvent): void {
		if (this.disposed) return;

		switch (event.type) {
			case 'listen-start':
				// Covers a session opened by the wake word or by a client that called
				// the service directly: the floor is open whether we opened it or not.
				if (!this.open) this.setFloor(true, 'session-started');
				break;
			case 'listen-stop':
			case 'stop-word':
				this.held = false;
				if (this.open) this.setFloor(false, 'session-ended');
				break;
			case 'session-error':
				if (!event.recoverable) {
					this.held = false;
					if (this.open) this.setFloor(false, 'session-ended');
				}
				break;
			default:
				break;
		}

		// A roster push or a tab change is the app talking to itself, not a human in
		// the room. Counting it as activity would keep a forgotten microphone alive
		// for as long as the user keeps working in another window.
		const activity = event.type !== 'agent-roster' && event.type !== 'tab-state';
		this.syncIdleTimer(activity);
	}

	/** Close everything and stop accepting input. Safe to call more than once. */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.clearIdleTimer();
		const pending = this.queue;
		this.queue = Promise.resolve();
		await pending;
		this.held = false;
		if (this.open) this.setFloor(false, 'shutdown');
		// Unconditional: a hold-to-talk session whose key was already released has a
		// closed floor and a very much open session.
		await this.stopSession('shutdown');
	}

	/** Resolves once every queued action has run. Tests and shutdown paths use it. */
	whenSettled(): Promise<void> {
		return this.queue;
	}

	// -- Internals -----------------------------------------------------------

	private async openFloor(source: WakeSource): Promise<void> {
		const state = this.options.session.getState();
		if (state === 'idle' || state === 'error') {
			const scope = this.options.getScope?.() ?? { kind: 'conductor' };
			try {
				await this.options.session.startSession({ scope, source });
			} catch (error) {
				// The session reports its own classified failures as `session-error`
				// events; anything that throws out of `startSession` is unexpected, and
				// the floor must not be left claiming to be open.
				this.held = false;
				this.report(error as Error, 'acappella.floorControl.start');
				return;
			}
		}

		this.setFloor(true, 'press');
		this.syncIdleTimer(true);
	}

	private async closeFloor(reason: FloorCloseReason): Promise<void> {
		this.held = false;
		this.clearIdleTimer();
		if (this.open) this.setFloor(false, reason);
		if (reason === 'session-ended') return;
		await this.stopSession(reason === 'idle-timeout' ? 'timeout' : 'user');
	}

	private async stopSession(reason: FloorSessionStopReason): Promise<void> {
		if (this.options.session.getState() === 'idle') return;
		try {
			await this.options.session.stopSession(reason);
		} catch (error) {
			this.report(error as Error, 'acappella.floorControl.stop');
		}
	}

	private async endUtterance(): Promise<void> {
		if (!this.options.endUtterance) return;
		try {
			await this.options.endUtterance();
		} catch (error) {
			// Endpointing is a hint, exactly as it is in the audio pipeline: the
			// recogniser still has the audio, so a failure here must not stop the
			// floor from closing.
			this.report(error as Error, 'acappella.floorControl.endUtterance');
		}
	}

	private setFloor(open: boolean, reason: FloorOpenReason | FloorCloseReason): void {
		if (this.open === open) return;
		this.open = open;
		if (!open) this.clearIdleTimer();
		this.options.onFloorChange?.(open, reason);
	}

	/**
	 * The idle countdown runs only while the session is `listening`.
	 *
	 * Every other active state is the session making progress on the user's
	 * behalf, and a slow agent must never be mistaken for an abandoned session.
	 * State is read rather than tracked, so this cannot drift from the state
	 * machine no matter which path got us here.
	 */
	private syncIdleTimer(restart = false): void {
		const listening = !this.disposed && this.options.session.getState() === 'listening';
		if (!listening || this.config.idleTimeoutMs <= 0) {
			this.clearIdleTimer();
			return;
		}
		if (!restart && this.idleTimer !== null) return;

		this.clearIdleTimer();
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			logger.debug(
				`Voice floor idle for ${this.config.idleTimeoutMs}ms, closing session`,
				LOG_CONTEXT
			);
			void this.close('idle-timeout');
		}, this.config.idleTimeoutMs);
		// A pending microphone timeout is not a reason to keep the process alive.
		this.idleTimer.unref?.();
	}

	private clearIdleTimer(): void {
		if (this.idleTimer === null) return;
		clearTimeout(this.idleTimer);
		this.idleTimer = null;
	}

	/**
	 * One action at a time.
	 *
	 * Presses arrive from a hotkey handler that cannot await them, so without a
	 * queue a double tap would run its two halves against the same observed state
	 * and open two sessions. Every link swallows its own failure, because a
	 * rejected chain would silently swallow every later press.
	 */
	private enqueue(action: () => Promise<void>): Promise<void> {
		const next = this.queue.then(action).catch((error: Error) => {
			this.report(error, 'acappella.floorControl');
		});
		this.queue = next;
		return next;
	}

	private report(error: Error, context: string): void {
		logger.error(`Floor control failure (${context}): ${error.message}`, LOG_CONTEXT);
		void captureException(error, { context, mode: this.config.mode });
		this.options.onError?.(error);
	}
}

/** Sugar for `new FloorController(...)`, matching the rest of A Cappella's factories. */
export function createFloorController(options: FloorControlOptions): FloorController {
	return new FloorController(options);
}
