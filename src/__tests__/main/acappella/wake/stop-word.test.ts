/**
 * @file stop-word.test.ts
 *
 * The stop word, and the one property this whole module exists to protect:
 * **the stop word and barge-in are different things and produce different
 * terminal states.** Stopping while the assistant is speaking must end the
 * session; talking over it must not. A test that only checked "speech stopped"
 * would pass for both and catch neither.
 *
 * The session is a fake with the same state machine shape the real one has, so
 * the assertions are about the state the session ends in rather than about which
 * methods were called.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../main/acappella/models/model-store', () => ({
	modelFilePath: (id: string, file: string) => `/models/${id}/${file}`,
}));

import type { AudioHostCommand } from '../../../../shared/acappella/audio-host';
import type { InterruptSource } from '../../../../shared/acappella/protocol';
import type { VoiceSessionState } from '../../../../shared/acappella/session-state';
import {
	DEFAULT_STOP_PHRASE,
	FALLBACK_STOP_PHRASE,
	FALLBACK_STOP_PHRASE_ID,
	PRIMARY_STOP_PHRASE_ID,
	StopWordController,
	armedPhrases,
	createStopWordController,
	isStopPhraseId,
	stopWordPhrases,
	type StopWordEventInfo,
	type StopWordSession,
} from '../../../../main/acappella/wake/stop-word';
import {
	globalWakePhrase,
	type WakeDetection,
} from '../../../../main/acappella/wake/wake-detector';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * A session with both behaviours on it, so a test can compare them.
 *
 * `interrupt` mirrors the real service: it cancels speech and returns the floor
 * to `listening`. `hardStop` ends the session. The controller is only given the
 * `hardStop` half, which is the point.
 */
class FakeSession implements StopWordSession {
	state: VoiceSessionState = 'idle';
	speechCancelled = 0;
	readonly hardStops: Array<{ source?: InterruptSource; phrase?: string }> = [];

	getState(): VoiceSessionState {
		return this.state;
	}

	async hardStop(source?: InterruptSource, phrase?: string): Promise<void> {
		this.hardStops.push({ source, phrase });
		this.speechCancelled += 1;
		this.state = 'idle';
	}

	/** Barge-in, for the comparison test. Never reachable from the controller. */
	interrupt(): boolean {
		if (this.state !== 'speaking') return false;
		this.speechCancelled += 1;
		this.state = 'listening';
		return true;
	}
}

function detection(phraseId: string, phrase: string): WakeDetection {
	return { phraseId, phrase, scope: { kind: 'conductor' }, score: 0.9, at: 1234, preRoll: [] };
}

describe('stop phrases', () => {
	it('always arms a second, non-editable phrase alongside the configured one', () => {
		const phrases = stopWordPhrases({ phrase: 'that will do' });
		expect(phrases.map((p) => p.phrase)).toEqual(['that will do', FALLBACK_STOP_PHRASE]);
	});

	it('falls back to the default phrase when the setting is blank', () => {
		expect(stopWordPhrases({ phrase: '   ' })[0].phrase).toBe(DEFAULT_STOP_PHRASE);
	});

	it('keeps "nevermind" armed even when the configured phrase is switched off', () => {
		const phrases = stopWordPhrases({ enabled: false });
		expect(phrases[0].enabled).toBe(false);
		expect(phrases[1].enabled).not.toBe(false);
	});

	it('tags stop phrase ids so a detection can be routed without a lookup', () => {
		expect(isStopPhraseId(PRIMARY_STOP_PHRASE_ID)).toBe(true);
		expect(isStopPhraseId(FALLBACK_STOP_PHRASE_ID)).toBe(true);
		expect(isStopPhraseId('global')).toBe(false);
		expect(isStopPhraseId('agent:seven')).toBe(false);
	});
});

describe('armedPhrases', () => {
	const wake = [globalWakePhrase('hey maestro')];
	const stop = stopWordPhrases();

	it('listens for the wake word only while the session is cold', () => {
		for (const state of ['idle', 'error'] as VoiceSessionState[]) {
			expect(armedPhrases(state, { wake, stop })).toEqual(wake);
		}
	});

	it('listens for the stop word in every active state, including speaking', () => {
		const active: VoiceSessionState[] = [
			'arming',
			'listening',
			'transcribing',
			'routing',
			'dispatching',
			'speaking',
			'interrupted',
		];
		for (const state of active) {
			expect(armedPhrases(state, { wake, stop })).toEqual(stop);
		}
	});

	it('never arms both at once, so a wake phrase cannot stack a second session', () => {
		const armed = armedPhrases('speaking', { wake, stop });
		expect(armed.some((phrase) => phrase.id === 'global')).toBe(false);
	});
});

describe('StopWordController', () => {
	let session: FakeSession;
	let commands: AudioHostCommand[];
	let stops: StopWordEventInfo[];
	let backToWakeOnly: number;
	let controller: StopWordController;

	beforeEach(() => {
		session = new FakeSession();
		commands = [];
		stops = [];
		backToWakeOnly = 0;
		controller = createStopWordController({
			session,
			sendCommand: (command) => commands.push(command),
			onStopWord: (info) => stops.push(info),
			onWakeWordOnly: () => {
				backToWakeOnly += 1;
			},
		});
	});

	it('ignores a wake phrase', () => {
		expect(controller.handleDetection(detection('global', 'hey maestro'))).toBe(false);
		expect(session.hardStops).toHaveLength(0);
	});

	it('ends the session when heard while speaking', async () => {
		session.state = 'speaking';
		expect(controller.handleDetection(detection(PRIMARY_STOP_PHRASE_ID, 'maestro stop'))).toBe(
			true
		);
		await controller.whenSettled();

		expect(session.state).toBe('idle');
		expect(session.hardStops).toEqual([{ source: 'voice', phrase: 'maestro stop' }]);
	});

	it('ends the session when heard while listening', async () => {
		session.state = 'listening';
		controller.handleDetection(detection(FALLBACK_STOP_PHRASE_ID, FALLBACK_STOP_PHRASE));
		await controller.whenSettled();

		expect(session.state).toBe('idle');
		expect(stops[0].from).toBe('listening');
	});

	it('flushes queued playback before stopping, then closes the microphone', async () => {
		session.state = 'speaking';
		controller.handleDetection(detection(PRIMARY_STOP_PHRASE_ID, 'maestro stop'));
		await controller.whenSettled();

		expect(commands.map((command) => command.kind)).toEqual(['flush', 'stop-capture']);
	});

	it('goes back to wake-word-only listening', async () => {
		session.state = 'speaking';
		controller.handleDetection(detection(PRIMARY_STOP_PHRASE_ID, 'maestro stop'));
		await controller.whenSettled();

		expect(backToWakeOnly).toBe(1);
	});

	it('does nothing when there is no session to stop', async () => {
		controller.handleDetection(detection(PRIMARY_STOP_PHRASE_ID, 'maestro stop'));
		await controller.whenSettled();

		expect(session.hardStops).toHaveLength(0);
		expect(commands).toHaveLength(0);
		expect(stops).toHaveLength(0);
	});

	it('serialises two phrases heard back to back into one teardown', async () => {
		session.state = 'speaking';
		controller.handleDetection(detection(PRIMARY_STOP_PHRASE_ID, 'maestro stop'));
		controller.handleDetection(detection(FALLBACK_STOP_PHRASE_ID, FALLBACK_STOP_PHRASE));
		await controller.whenSettled();

		expect(session.hardStops).toHaveLength(1);
	});

	it('still closes the microphone when the session teardown throws', async () => {
		session.state = 'speaking';
		session.hardStop = async () => {
			throw new Error('teardown exploded');
		};
		const errors: Error[] = [];
		const failing = createStopWordController({
			session,
			sendCommand: (command) => commands.push(command),
			onError: (error) => errors.push(error),
		});

		failing.handleDetection(detection(PRIMARY_STOP_PHRASE_ID, 'maestro stop'));
		await failing.whenSettled();

		expect(errors).toHaveLength(1);
		expect(commands.map((command) => command.kind)).toEqual(['flush', 'stop-capture']);
	});

	it('reads the stop phrase per call, so a settings change takes effect live', () => {
		let phrase = 'first phrase';
		const live = createStopWordController({ session, getConfig: () => ({ phrase }) });
		expect(live.phrases()[0].phrase).toBe('first phrase');
		phrase = 'second phrase';
		expect(live.phrases()[0].phrase).toBe('second phrase');
	});

	// -----------------------------------------------------------------------
	// The distinction
	// -----------------------------------------------------------------------

	describe('stop word versus barge-in', () => {
		it('leaves the session in different terminal states from the same starting point', async () => {
			const stopped = new FakeSession();
			stopped.state = 'speaking';
			const stopController = createStopWordController({ session: stopped });
			stopController.handleDetection(detection(PRIMARY_STOP_PHRASE_ID, 'maestro stop'));
			await stopController.whenSettled();

			const bargedIn = new FakeSession();
			bargedIn.state = 'speaking';
			bargedIn.interrupt();

			// Both cancelled speech. Only one of them hung up.
			expect(stopped.speechCancelled).toBe(1);
			expect(bargedIn.speechCancelled).toBe(1);
			expect(stopped.state).toBe('idle');
			expect(bargedIn.state).toBe('listening');
			expect(stopped.state).not.toBe(bargedIn.state);
		});

		it('cannot reach barge-in: the controller is handed no way to call it', async () => {
			const spy = vi.spyOn(session, 'interrupt');
			session.state = 'speaking';
			controller.handleDetection(detection(PRIMARY_STOP_PHRASE_ID, 'maestro stop'));
			await controller.whenSettled();

			expect(spy).not.toHaveBeenCalled();
		});

		it('reports the stop through its own seam, not a shared one', async () => {
			session.state = 'speaking';
			controller.handleDetection(detection(PRIMARY_STOP_PHRASE_ID, 'maestro stop'));
			await controller.whenSettled();

			expect(stops).toEqual([
				{
					phrase: 'maestro stop',
					phraseId: PRIMARY_STOP_PHRASE_ID,
					from: 'speaking',
					score: 0.9,
					at: 1234,
				},
			]);
		});
	});
});
