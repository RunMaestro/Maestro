/**
 * @file floor-control.test.ts
 *
 * Who holds the microphone: tap versus hold semantics, the idle timeout, and the
 * ways the floor can change without anyone pressing anything.
 *
 * The controller is injected with a fake session, so every case here runs
 * without Electron, a hotkey, a phone, or an audio device. Time is faked because
 * the idle timeout is the one part of A Cappella's audio path that legitimately
 * uses a wall clock: it is measuring a human who walked away, not audio.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { captureException } from '../../../../main/utils/sentry';
import {
	DEFAULT_FLOOR_MODE,
	DEFAULT_IDLE_TIMEOUT_MS,
	FloorController,
	MAX_IDLE_TIMEOUT_MS,
	MIN_IDLE_TIMEOUT_MS,
	createFloorController,
	resolveFloorControlConfig,
	type FloorCloseReason,
	type FloorControlOptions,
	type FloorControlSession,
	type FloorOpenReason,
	type FloorSessionStopReason,
} from '../../../../main/acappella/audio/floor-control';
import type { VoiceEvent, VoiceScope, WakeSource } from '../../../../shared/acappella/protocol';
import type { VoiceSessionState } from '../../../../shared/acappella/session-state';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeSession implements FloorControlSession {
	state: VoiceSessionState = 'idle';
	readonly starts: { scope: VoiceScope; source?: WakeSource }[] = [];
	readonly stops: FloorSessionStopReason[] = [];
	interrupts = 0;
	startError: Error | null = null;
	stopError: Error | null = null;
	/** Set by a test to hold `startSession` open until it resolves. */
	startGate: Promise<void> | null = null;

	getState(): VoiceSessionState {
		return this.state;
	}

	async startSession(params: { scope: VoiceScope; source?: WakeSource }): Promise<unknown> {
		if (this.startGate) await this.startGate;
		if (this.startError) throw this.startError;
		this.starts.push(params);
		this.state = 'listening';
		return { state: this.state };
	}

	async stopSession(reason: FloorSessionStopReason): Promise<void> {
		this.stops.push(reason);
		if (this.stopError) throw this.stopError;
		this.state = 'idle';
	}

	interrupt(): boolean {
		if (this.state !== 'speaking') return false;
		this.interrupts += 1;
		this.state = 'listening';
		return true;
	}
}

interface Harness {
	floor: FloorController;
	session: FakeSession;
	changes: { open: boolean; reason: FloorOpenReason | FloorCloseReason }[];
	endUtterances: number;
	errors: Error[];
}

function harness(overrides: Partial<FloorControlOptions> = {}): Harness {
	const session = new FakeSession();
	const changes: Harness['changes'] = [];
	const errors: Error[] = [];
	const state = { endUtterances: 0 };

	const floor = createFloorController({
		session,
		onFloorChange: (open, reason) => changes.push({ open, reason }),
		onError: (error) => errors.push(error),
		endUtterance: () => {
			state.endUtterances += 1;
		},
		...overrides,
	});

	return {
		floor,
		session,
		changes,
		errors,
		get endUtterances() {
			return state.endUtterances;
		},
	};
}

/** A protocol event with the envelope filled in. Only `type` matters here. */
function event(body: Partial<VoiceEvent> & { type: VoiceEvent['type'] }): VoiceEvent {
	return { sessionId: 'voice-1', seq: 1, ts: 0, ...body } as unknown as VoiceEvent;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('resolveFloorControlConfig', () => {
	it('defaults to hands-free with the default idle timeout', () => {
		expect(resolveFloorControlConfig()).toEqual({
			mode: DEFAULT_FLOOR_MODE,
			idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
		});
	});

	it('clamps an idle timeout that would hang up on an ordinary pause', () => {
		expect(resolveFloorControlConfig({ idleTimeoutMs: 200 }).idleTimeoutMs).toBe(
			MIN_IDLE_TIMEOUT_MS
		);
	});

	it('clamps an idle timeout that would leave a microphone open all day', () => {
		expect(resolveFloorControlConfig({ idleTimeoutMs: 60 * 60_000 }).idleTimeoutMs).toBe(
			MAX_IDLE_TIMEOUT_MS
		);
	});

	it('treats zero as explicitly disabled rather than clamping it up', () => {
		expect(resolveFloorControlConfig({ idleTimeoutMs: 0 }).idleTimeoutMs).toBe(0);
	});

	it('falls back to the default for a nonsense timeout', () => {
		expect(resolveFloorControlConfig({ idleTimeoutMs: Number.NaN }).idleTimeoutMs).toBe(
			DEFAULT_IDLE_TIMEOUT_MS
		);
		expect(resolveFloorControlConfig({ idleTimeoutMs: -5 }).idleTimeoutMs).toBe(
			DEFAULT_IDLE_TIMEOUT_MS
		);
	});

	it('falls back to the default for an unknown mode', () => {
		expect(resolveFloorControlConfig({ mode: 'push' as never }).mode).toBe(DEFAULT_FLOOR_MODE);
	});
});

// ---------------------------------------------------------------------------
// Tap to toggle
// ---------------------------------------------------------------------------

describe('tap-to-toggle', () => {
	it('opens a conductor-scoped session on the first press', async () => {
		const h = harness();

		await h.floor.press('hotkey');

		expect(h.session.starts).toEqual([{ scope: { kind: 'conductor' }, source: 'hotkey' }]);
		expect(h.floor.isFloorOpen).toBe(true);
		expect(h.changes).toEqual([{ open: true, reason: 'press' }]);
	});

	it('opens the scope the caller supplies', async () => {
		const scope: VoiceScope = { kind: 'agent', sessionId: 'agent-7' };
		const h = harness({ getScope: () => scope });

		await h.floor.press();

		expect(h.session.starts[0].scope).toEqual(scope);
	});

	it('closes the session on the next press', async () => {
		const h = harness();

		await h.floor.press();
		await h.floor.release();
		await h.floor.press();

		expect(h.session.stops).toEqual(['user']);
		expect(h.floor.isFloorOpen).toBe(false);
		expect(h.changes.at(-1)).toEqual({ open: false, reason: 'toggle' });
	});

	it('ignores a held key repeating, so a repeat cannot toggle the floor', async () => {
		const h = harness();

		await h.floor.press();
		await h.floor.press();
		await h.floor.press();

		expect(h.session.starts).toHaveLength(1);
		expect(h.session.stops).toEqual([]);
		expect(h.floor.isFloorOpen).toBe(true);
	});

	it('ignores a release: a tap and a long press are the same gesture', async () => {
		const h = harness();

		await h.floor.press();
		await h.floor.release();

		expect(h.floor.isFloorOpen).toBe(true);
		expect(h.session.stops).toEqual([]);
		expect(h.endUtterances).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Hold to talk
// ---------------------------------------------------------------------------

describe('hold-to-talk', () => {
	it('opens the floor on press', async () => {
		const h = harness({ mode: 'hold-to-talk' });

		await h.floor.press('hotkey');

		expect(h.floor.isFloorOpen).toBe(true);
		expect(h.floor.isHeld).toBe(true);
		expect(h.session.starts).toHaveLength(1);
	});

	it('endpoints the utterance on release, bypassing VAD silence', async () => {
		const h = harness({ mode: 'hold-to-talk' });

		await h.floor.press();
		await h.floor.release();

		expect(h.endUtterances).toBe(1);
		expect(h.floor.isFloorOpen).toBe(false);
		expect(h.changes.at(-1)).toEqual({ open: false, reason: 'release' });
	});

	it('keeps the session alive after release so the reply can arrive', async () => {
		const h = harness({ mode: 'hold-to-talk' });

		await h.floor.press();
		await h.floor.release();

		expect(h.session.stops).toEqual([]);
		expect(h.session.state).toBe('listening');
	});

	it('ignores a release with no matching press', async () => {
		const h = harness({ mode: 'hold-to-talk' });

		await h.floor.release();

		expect(h.endUtterances).toBe(0);
		expect(h.changes).toEqual([]);
	});

	it('serialises a release that lands while the session is still starting', async () => {
		const h = harness({ mode: 'hold-to-talk' });
		let openTheGate!: () => void;
		h.session.startGate = new Promise<void>((resolve) => {
			openTheGate = resolve;
		});

		const pressed = h.floor.press();
		const released = h.floor.release();
		await Promise.resolve();
		// The release cannot be allowed to run against a session that does not exist
		// yet, so it waits behind the press rather than seeing a closed floor.
		expect(h.endUtterances).toBe(0);

		openTheGate();
		await pressed;
		await released;

		expect(h.session.starts).toHaveLength(1);
		expect(h.endUtterances).toBe(1);
		expect(h.floor.isFloorOpen).toBe(false);
	});

	it('closes the floor even when endpointing fails', async () => {
		const error = new Error('provider gone');
		const h = harness({
			mode: 'hold-to-talk',
			endUtterance: () => {
				throw error;
			},
		});

		await h.floor.press();
		await h.floor.release();

		expect(h.floor.isFloorOpen).toBe(false);
		expect(h.errors).toEqual([error]);
		expect(captureException).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Interruption
// ---------------------------------------------------------------------------

describe('press over active speech', () => {
	it('interrupts rather than ending the session', async () => {
		const h = harness();
		await h.floor.press();
		await h.floor.release();
		h.session.state = 'speaking';
		h.floor.handleEvent(event({ type: 'speak-start' }));

		await h.floor.press();

		expect(h.session.interrupts).toBe(1);
		expect(h.session.stops).toEqual([]);
		expect(h.floor.isFloorOpen).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Idle timeout
// ---------------------------------------------------------------------------

describe('idle timeout', () => {
	it('closes a listening session that hears nothing', async () => {
		const h = harness({ idleTimeoutMs: 10_000 });
		await h.floor.press();

		await vi.advanceTimersByTimeAsync(10_000);
		await h.floor.whenSettled();

		expect(h.session.stops).toEqual(['timeout']);
		expect(h.floor.isFloorOpen).toBe(false);
		expect(h.changes.at(-1)).toEqual({ open: false, reason: 'idle-timeout' });
	});

	it('restarts on speech so a request in progress is never cut off', async () => {
		const h = harness({ idleTimeoutMs: 10_000 });
		await h.floor.press();

		await vi.advanceTimersByTimeAsync(9_000);
		h.floor.noteActivity();
		await vi.advanceTimersByTimeAsync(9_000);

		expect(h.session.stops).toEqual([]);

		await vi.advanceTimersByTimeAsync(1_000);
		await h.floor.whenSettled();
		expect(h.session.stops).toEqual(['timeout']);
	});

	it('does not run while the session is working on the user behalf', async () => {
		const h = harness({ idleTimeoutMs: 10_000 });
		await h.floor.press();

		h.session.state = 'dispatching';
		h.floor.handleEvent(event({ type: 'dispatch' }));
		await vi.advanceTimersByTimeAsync(60_000);

		expect(h.session.stops).toEqual([]);
		expect(h.floor.isFloorOpen).toBe(true);
	});

	it('rearms when the floor comes back to listening', async () => {
		const h = harness({ idleTimeoutMs: 10_000 });
		await h.floor.press();
		h.session.state = 'speaking';
		h.floor.handleEvent(event({ type: 'speak-start' }));
		await vi.advanceTimersByTimeAsync(60_000);

		h.session.state = 'listening';
		h.floor.handleEvent(event({ type: 'listen-start' }));
		await vi.advanceTimersByTimeAsync(10_000);
		await h.floor.whenSettled();

		expect(h.session.stops).toEqual(['timeout']);
	});

	it('closes a hold-to-talk session whose key was already released', async () => {
		const h = harness({ mode: 'hold-to-talk', idleTimeoutMs: 10_000 });
		await h.floor.press();
		await h.floor.release();

		await vi.advanceTimersByTimeAsync(10_000);
		await h.floor.whenSettled();

		expect(h.session.stops).toEqual(['timeout']);
	});

	it('is disabled by a zero timeout', async () => {
		const h = harness({ idleTimeoutMs: 0 });
		await h.floor.press();

		await vi.advanceTimersByTimeAsync(MAX_IDLE_TIMEOUT_MS);

		expect(h.session.stops).toEqual([]);
		expect(h.floor.isFloorOpen).toBe(true);
	});

	it('is not kept alive by the app talking to itself', async () => {
		const h = harness({ idleTimeoutMs: 10_000 });
		await h.floor.press();

		// A roster push every few seconds is background noise, not a human in the
		// room: it must not hold the floor open indefinitely.
		for (let i = 0; i < 5; i++) {
			await vi.advanceTimersByTimeAsync(2_000);
			h.floor.handleEvent(event({ type: 'agent-roster', agents: [] }));
		}
		await h.floor.whenSettled();

		expect(h.session.stops).toEqual(['timeout']);
	});

	it('is restarted by a transcript', async () => {
		const h = harness({ idleTimeoutMs: 10_000 });
		await h.floor.press();

		await vi.advanceTimersByTimeAsync(9_000);
		h.floor.handleEvent(event({ type: 'partial-transcript', text: 'hey', stability: 0.4 }));
		await vi.advanceTimersByTimeAsync(9_000);

		expect(h.session.stops).toEqual([]);
	});

	it('applies a new timeout immediately rather than after the armed one', async () => {
		const h = harness({ idleTimeoutMs: 60_000 });
		await h.floor.press();

		h.floor.configure({ idleTimeoutMs: 10_000 });
		await vi.advanceTimersByTimeAsync(10_000);
		await h.floor.whenSettled();

		expect(h.session.stops).toEqual(['timeout']);
	});
});

// ---------------------------------------------------------------------------
// Following the session
// ---------------------------------------------------------------------------

describe('session events', () => {
	it('adopts a floor opened by the wake word', () => {
		const h = harness();
		h.session.state = 'listening';

		h.floor.handleEvent(event({ type: 'listen-start' }));

		expect(h.floor.isFloorOpen).toBe(true);
		expect(h.changes).toEqual([{ open: true, reason: 'session-started' }]);
	});

	it('releases the floor when the stop word ends the session', async () => {
		const h = harness();
		await h.floor.press();

		h.session.state = 'idle';
		h.floor.handleEvent(event({ type: 'listen-stop', reason: 'stopped' }));

		expect(h.floor.isFloorOpen).toBe(false);
		expect(h.floor.isHeld).toBe(false);
		// The session ended on its own; closing it again would be a second stop.
		expect(h.session.stops).toEqual([]);
	});

	it('releases the floor on an unrecoverable failure', async () => {
		const h = harness();
		await h.floor.press();

		h.session.state = 'error';
		h.floor.handleEvent(
			event({
				type: 'session-error',
				code: 'provider-unavailable',
				message: 'no stt',
				recoverable: false,
			})
		);

		expect(h.floor.isFloorOpen).toBe(false);
	});

	it('keeps the floor through a recoverable failure', async () => {
		const h = harness();
		await h.floor.press();

		h.floor.handleEvent(
			event({
				type: 'session-error',
				code: 'no-agent-matched',
				message: 'nobody home',
				recoverable: true,
			})
		);

		expect(h.floor.isFloorOpen).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Mode changes, failures, shutdown
// ---------------------------------------------------------------------------

describe('configure', () => {
	it('keeps an open floor when switching to tap while held', async () => {
		const h = harness({ mode: 'hold-to-talk' });
		await h.floor.press();

		h.floor.configure({ mode: 'tap-to-toggle' });
		await h.floor.release();

		expect(h.floor.isFloorOpen).toBe(true);
		expect(h.endUtterances).toBe(0);
	});

	it('reports the resolved mode and timeout', () => {
		const h = harness();

		h.floor.configure({ mode: 'hold-to-talk', idleTimeoutMs: 1 });

		expect(h.floor.mode).toBe('hold-to-talk');
		expect(h.floor.idleTimeoutMs).toBe(MIN_IDLE_TIMEOUT_MS);
	});
});

describe('failures', () => {
	it('leaves the floor closed when the session cannot start', async () => {
		const h = harness();
		h.session.startError = new Error('no provider');

		await h.floor.press();

		expect(h.floor.isFloorOpen).toBe(false);
		expect(h.floor.isHeld).toBe(false);
		expect(h.errors).toHaveLength(1);
		expect(captureException).toHaveBeenCalled();
	});

	it('accepts a press after a failed start rather than wedging', async () => {
		const h = harness();
		h.session.startError = new Error('no provider');
		await h.floor.press();

		h.session.startError = null;
		await h.floor.press();

		expect(h.floor.isFloorOpen).toBe(true);
		expect(h.session.starts).toHaveLength(1);
	});

	it('reports a throwing floor subscriber without abandoning the rest of the action', async () => {
		const session = new FakeSession();
		const errors: Error[] = [];
		const floor = createFloorController({
			session,
			onError: (error) => errors.push(error),
			// The capture gate is this seam and it sends IPC, so a window destroyed
			// between the press and the notify throws right here.
			onFloorChange: () => {
				throw new Error('audio host is gone');
			},
		});

		await floor.press();
		expect(errors).toHaveLength(1);
		expect(captureException).toHaveBeenCalled();
		// The session did open; only the notification failed.
		expect(session.starts).toHaveLength(1);

		await floor.release();
		await floor.press();

		// The close notify throws too, and the session is still stopped: a listener
		// that cannot be told must not leave a live session behind a shut floor.
		expect(errors).toHaveLength(2);
		expect(session.stops).toEqual(['user']);
		expect(floor.isFloorOpen).toBe(false);
	});

	it('reports a failing stop without leaving the floor open', async () => {
		const h = harness();
		await h.floor.press();
		await h.floor.release();
		h.session.stopError = new Error('teardown exploded');

		await h.floor.press();

		expect(h.floor.isFloorOpen).toBe(false);
		expect(h.errors).toHaveLength(1);
	});
});

describe('dispose', () => {
	it('closes the floor and the session', async () => {
		const h = harness();
		await h.floor.press();

		await h.floor.dispose();

		expect(h.floor.isFloorOpen).toBe(false);
		expect(h.session.stops).toEqual(['shutdown']);
		expect(h.changes.at(-1)).toEqual({ open: false, reason: 'shutdown' });
	});

	it('stops a hold-to-talk session whose floor was already closed', async () => {
		const h = harness({ mode: 'hold-to-talk' });
		await h.floor.press();
		await h.floor.release();

		await h.floor.dispose();

		expect(h.session.stops).toEqual(['shutdown']);
	});

	it('ignores input afterwards and is safe to repeat', async () => {
		const h = harness();
		await h.floor.press();
		await h.floor.dispose();
		await h.floor.dispose();

		await h.floor.press();

		expect(h.session.starts).toHaveLength(1);
		expect(h.session.stops).toEqual(['shutdown']);
		expect(h.floor.isFloorOpen).toBe(false);
	});
});

describe('createFloorController', () => {
	it('builds a controller with the resolved config', () => {
		const controller = createFloorController({
			session: new FakeSession(),
			mode: 'hold-to-talk',
			idleTimeoutMs: 99,
		});

		expect(controller).toBeInstanceOf(FloorController);
		expect(controller.mode).toBe('hold-to-talk');
		expect(controller.idleTimeoutMs).toBe(MIN_IDLE_TIMEOUT_MS);
	});
});
