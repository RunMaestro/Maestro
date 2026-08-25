/**
 * @file voiceDiagnosticsStore.test.ts
 *
 * The recorder exists for one situation: the pipeline appeared to do nothing and
 * someone has to say where it stopped. Two properties make it useful for that,
 * and both are easy to lose - it must survive a busy session without evicting
 * the events that explain anything, and it must not fill up with meter ticks.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { VoiceEvent } from '../../../shared/acappella/protocol';
import {
	useVoiceDiagnosticsStore,
	VOICE_DIAGNOSTIC_LIMIT,
} from '../../../renderer/stores/voiceDiagnosticsStore';

let seq = 0;

function event<T extends VoiceEvent['type']>(
	type: T,
	body: Omit<Extract<VoiceEvent, { type: T }>, 'type' | 'sessionId' | 'seq' | 'ts'>
): VoiceEvent {
	seq += 1;
	return { type, sessionId: 'voice-1', seq, ts: 1_700_000_000_000 + seq, ...body } as VoiceEvent;
}

function record(...events: VoiceEvent[]): void {
	for (const e of events) useVoiceDiagnosticsStore.getState().record(e);
}

beforeEach(() => {
	seq = 0;
	useVoiceDiagnosticsStore.getState().clear();
});

describe('voiceDiagnosticsStore', () => {
	it('records what an event carried, not the whole payload', () => {
		record(
			event('listen-start', { scope: { kind: 'conductor' }, sttProviderId: 'echo-stt' }),
			event('final-transcript', { text: 'open the auth tab', confidence: 0.9 })
		);

		const entries = useVoiceDiagnosticsStore.getState().entries;
		expect(entries.map((entry) => entry.type)).toEqual(['listen-start', 'final-transcript']);
		expect(entries[0].detail).toContain('echo-stt');
		expect(entries[1].detail).toContain('open the auth tab');
	});

	it('tallies audio levels instead of storing them', () => {
		// Twenty a second: stored individually, ten seconds of silence would evict
		// every event that explains anything.
		record(
			event('audio-level', { level: 0.2, speech: false }),
			event('audio-level', { level: 0.7, speech: true }),
			event('audio-level', { level: 0.1, speech: false })
		);

		const state = useVoiceDiagnosticsStore.getState();
		expect(state.entries).toHaveLength(0);
		expect(state.audioLevelCount).toBe(3);
		expect(state.audioLevelPeak).toBeCloseTo(0.7);
		expect(state.speechFrames).toBe(1);
	});

	it('keeps the most recent entries once it is full', () => {
		for (let i = 0; i < VOICE_DIAGNOSTIC_LIMIT + 10; i += 1) {
			record(event('listen-stop', { reason: 'stopped' }));
		}

		const entries = useVoiceDiagnosticsStore.getState().entries;
		expect(entries).toHaveLength(VOICE_DIAGNOSTIC_LIMIT);
		// Ids stay strictly increasing across an eviction, so the log cannot appear
		// to go backwards in time after the buffer wraps.
		expect(entries[0].id).toBeLessThan(entries[entries.length - 1].id);
	});

	it('records the error that explains a dead session', () => {
		record(
			event('session-error', {
				code: 'provider-unavailable',
				message: 'whisper.cpp is not part of this build yet.',
				recoverable: false,
			})
		);

		expect(useVoiceDiagnosticsStore.getState().entries[0].detail).toContain('whisper.cpp');
	});

	it('clears both the log and the tallies', () => {
		record(
			event('audio-level', { level: 0.5, speech: true }),
			event('listen-stop', { reason: 'stopped' })
		);

		useVoiceDiagnosticsStore.getState().clear();

		const state = useVoiceDiagnosticsStore.getState();
		expect(state.entries).toEqual([]);
		expect(state.audioLevelCount).toBe(0);
		expect(state.audioLevelPeak).toBe(0);
		expect(state.speechFrames).toBe(0);
	});
});
