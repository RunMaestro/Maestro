/**
 * voiceSessionStore - projection of the A Cappella event stream.
 *
 * The store owns no truth, so these tests are all about faithfulness: the state
 * it derives, the transcript it builds, what it drops, and what it refuses to
 * rewind.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { VoiceEvent } from '../../../shared/acappella/protocol';
import {
	selectVoiceAudioLevel,
	selectVoiceMicIssue,
	selectVoiceScopeLabel,
	useVoiceSessionStore,
	VOICE_FEED_LIMIT,
} from '../../../renderer/stores/voiceSessionStore';

const SESSION = 'voice-session-1';

let seq = 0;

/** Build the next event in the stream, stamping a contiguous `seq`. */
function event<T extends VoiceEvent['type']>(
	type: T,
	body: Omit<Extract<VoiceEvent, { type: T }>, 'type' | 'sessionId' | 'seq' | 'ts'>,
	overrides: { sessionId?: string; seq?: number } = {}
): VoiceEvent {
	seq += 1;
	return {
		type,
		sessionId: overrides.sessionId ?? SESSION,
		seq: overrides.seq ?? seq,
		ts: 1_700_000_000_000 + seq,
		...body,
	} as unknown as VoiceEvent;
}

function apply(...events: VoiceEvent[]): void {
	for (const e of events) useVoiceSessionStore.getState().applyEvent(e);
}

function wake(): VoiceEvent {
	return event('wake', { source: 'client-button', scope: { kind: 'conductor' } });
}

function listenStart(): VoiceEvent {
	return event('listen-start', { scope: { kind: 'conductor' }, sttProviderId: 'mock-stt' });
}

beforeEach(() => {
	seq = 0;
	useVoiceSessionStore.getState().reset();
});

describe('voiceSessionStore projection', () => {
	it('derives the state the service is in after each event', () => {
		apply(wake());
		expect(useVoiceSessionStore.getState().state).toBe('arming');

		apply(listenStart());
		expect(useVoiceSessionStore.getState().state).toBe('listening');

		apply(event('final-transcript', { text: 'open a new tab', confidence: 1 }));
		expect(useVoiceSessionStore.getState().state).toBe('transcribing');

		apply(
			event('route-decision', {
				decision: {
					target: 'conductor',
					tabAction: 'new',
					prompt: 'open a new tab',
					confidence: 0.9,
				},
				brainProviderId: 'mock-brain',
				latencyMs: 3,
			})
		);
		expect(useVoiceSessionStore.getState().state).toBe('dispatching');

		apply(event('speak-start', { utteranceId: 'u1', sentenceCount: 2, ttsProviderId: 'mock-tts' }));
		expect(useVoiceSessionStore.getState().state).toBe('speaking');
	});

	it('returns to idle on a listen-stop that ends the session', () => {
		apply(wake(), listenStart(), event('listen-stop', { reason: 'stopped' }));
		expect(useVoiceSessionStore.getState().state).toBe('idle');
	});

	it('parks in error on a session-error and keeps the message', () => {
		apply(
			wake(),
			event('session-error', {
				code: 'no-agent-matched',
				message: 'No agent named Backend is running',
				recoverable: true,
			})
		);
		const state = useVoiceSessionStore.getState();
		expect(state.state).toBe('error');
		expect(state.error?.message).toContain('Backend');
	});

	it('streams partials and clears them when the utterance settles', () => {
		apply(
			wake(),
			listenStart(),
			event('partial-transcript', { text: 'open a', stability: 0.3 }),
			event('partial-transcript', { text: 'open a new tab', stability: 0.8 })
		);
		expect(useVoiceSessionStore.getState().partialTranscript).toBe('open a new tab');

		apply(event('final-transcript', { text: 'open a new tab', confidence: 1 }));
		const state = useVoiceSessionStore.getState();
		expect(state.partialTranscript).toBe('');
		expect(state.utterance).toBe('open a new tab');
		expect(state.feed[state.feed.length - 1]).toMatchObject({
			kind: 'you',
			text: 'open a new tab',
		});
	});

	it('narrates a dispatch in words and keeps the reply address', () => {
		apply(
			wake(),
			listenStart(),
			event('dispatch', {
				agentSessionId: 'agent-1',
				agentName: 'Backend',
				tabId: 'tab-9',
				tabName: 'Auth Refactor',
				action: 'created',
				promptSent: true,
			})
		);
		const state = useVoiceSessionStore.getState();
		expect(state.feed[state.feed.length - 1].text).toBe(
			'Opened a new tab named Auth Refactor on Backend'
		);
		expect(state.lastDispatch).toMatchObject({ agentSessionId: 'agent-1', tabId: 'tab-9' });
	});

	it('collects spoken sentences and drops stragglers from a cancelled run', () => {
		apply(
			wake(),
			listenStart(),
			event('speak-start', { utteranceId: 'u1', sentenceCount: 3, ttsProviderId: 'mock-tts' }),
			event('speak-sentence', { utteranceId: 'u1', index: 0, text: 'Done.' }),
			event('barge-in', { source: 'client-button', cancelledUtteranceId: 'u1' }),
			event('speak-end', { utteranceId: 'u1', reason: 'cancelled' }),
			// A late chunk from the cancelled run. It must not extend the transcript.
			event('speak-sentence', { utteranceId: 'u1', index: 1, text: 'Also this.' }),
			event('speak-sentence', { utteranceId: 'u-old', index: 0, text: 'Wrong run.' })
		);
		const state = useVoiceSessionStore.getState();
		expect(state.speech?.sentences).toEqual(['Done.', 'Also this.']);
		expect(state.speech?.endedReason).toBe('cancelled');

		// The straggler from a DIFFERENT run is dropped entirely.
		expect(state.speech?.sentences).not.toContain('Wrong run.');
	});

	it('flags a seq gap instead of smoothing over it', () => {
		apply(wake(), listenStart());
		expect(useVoiceSessionStore.getState().lostEvents).toBe(false);

		apply(event('partial-transcript', { text: 'hello', stability: 0.5 }, { seq: 99 }));
		expect(useVoiceSessionStore.getState().lostEvents).toBe(true);
	});

	it('starts the projection over when a new session id appears', () => {
		apply(
			wake(),
			listenStart(),
			event('final-transcript', { text: 'first session', confidence: 1 })
		);
		expect(useVoiceSessionStore.getState().feed).toHaveLength(1);

		apply(
			event(
				'wake',
				{ source: 'hotkey', scope: { kind: 'agent', sessionId: 'agent-1' } },
				{ sessionId: 'voice-session-2', seq: 1 }
			)
		);
		const state = useVoiceSessionStore.getState();
		expect(state.sessionId).toBe('voice-session-2');
		expect(state.feed).toHaveLength(0);
		expect(state.lostEvents).toBe(false);
	});

	it('caps the transcript so a long conversation cannot grow without bound', () => {
		apply(wake(), listenStart());
		for (let i = 0; i < VOICE_FEED_LIMIT + 10; i++) {
			apply(event('final-transcript', { text: `line ${i}`, confidence: 1 }));
		}
		const feed = useVoiceSessionStore.getState().feed;
		expect(feed).toHaveLength(VOICE_FEED_LIMIT);
		expect(feed[feed.length - 1].text).toBe(`line ${VOICE_FEED_LIMIT + 9}`);
	});

	it('names the bound agent once the roster arrives', () => {
		apply(
			event('wake', {
				source: 'hotkey',
				scope: { kind: 'agent', sessionId: 'agent-1' },
			}),
			event('agent-roster', {
				agents: [
					{ sessionId: 'agent-1', name: 'Backend', agentType: 'claude-code', cwd: '/p', tabs: [] },
				],
			})
		);
		expect(selectVoiceScopeLabel(useVoiceSessionStore.getState())).toBe('Backend');
	});
});

describe('voiceSessionStore audio projection', () => {
	function micState(
		overrides: Partial<Omit<Extract<VoiceEvent, { type: 'mic-state' }>, 'type'>> = {}
	): VoiceEvent {
		return event('mic-state', {
			permission: 'granted',
			capturing: true,
			deviceId: 'default',
			deviceLabel: 'MacBook Pro Microphone',
			issue: null,
			deviceChanged: false,
			...overrides,
		} as never);
	}

	it('tracks the meter level and whether the window was speech', () => {
		apply(wake(), listenStart(), event('audio-level', { level: 0.42, speech: true }));

		const state = useVoiceSessionStore.getState();
		expect(state.audioLevel).toBeCloseTo(0.42);
		expect(state.speechDetected).toBe(true);
		expect(selectVoiceAudioLevel(state)).toBeCloseTo(0.42);
	});

	it('does not let a level move the session state or reach the transcript', () => {
		apply(wake(), listenStart(), event('audio-level', { level: 0.4, speech: true }));

		const state = useVoiceSessionStore.getState();
		expect(state.state).toBe('listening');
		// 20 lines a second of "the meter moved" would bury the conversation.
		expect(state.feed).toHaveLength(0);
	});

	it('drops the meter to rest when the floor closes', () => {
		apply(
			wake(),
			listenStart(),
			event('audio-level', { level: 0.4, speech: true }),
			event('listen-stop', { reason: 'endpoint' })
		);

		expect(useVoiceSessionStore.getState().audioLevel).toBe(0);
		expect(useVoiceSessionStore.getState().speechDetected).toBe(false);
	});

	it('drops the meter to rest when the microphone stops capturing', () => {
		apply(wake(), listenStart(), event('audio-level', { level: 0.4, speech: true }));
		apply(micState({ capturing: false }));

		// A bar left standing over a closed device is the same lie as a listening
		// indicator over a denied one.
		expect(useVoiceSessionStore.getState().audioLevel).toBe(0);
	});

	it('projects the microphone state, issue and all', () => {
		apply(wake(), micState({ permission: 'denied', capturing: false, issue: 'permission-denied' }));

		const state = useVoiceSessionStore.getState();
		expect(state.mic?.permission).toBe('denied');
		expect(selectVoiceMicIssue(state)).toBe('permission-denied');
	});

	it('reports no issue before anything has been attempted', () => {
		expect(selectVoiceMicIssue(useVoiceSessionStore.getState())).toBeNull();
	});

	it('keeps the microphone state across a session restart', () => {
		apply(wake(), micState({ permission: 'denied', capturing: false, issue: 'permission-denied' }));

		// A permission the user denied is still denied on the next attempt, and
		// forgetting it would leave the new session unable to explain its silence.
		apply(
			event('wake', { source: 'hotkey', scope: { kind: 'conductor' } }, { sessionId: 'voice-2' })
		);

		const state = useVoiceSessionStore.getState();
		expect(state.sessionId).toBe('voice-2');
		expect(state.mic?.issue).toBe('permission-denied');
		expect(state.audioLevel).toBe(0);
	});
});

describe('voiceSessionStore snapshot catch-up', () => {
	it('adopts a snapshot when the client has no session', () => {
		useVoiceSessionStore.getState().applySnapshot({
			sessionId: SESSION,
			state: 'speaking',
			scope: { kind: 'conductor' },
			seq: 7,
			providerIds: { stt: 'mock-stt', tts: 'mock-tts', brain: 'mock-brain' },
		});
		expect(useVoiceSessionStore.getState().state).toBe('speaking');
		expect(useVoiceSessionStore.getState().lostEvents).toBe(false);
	});

	it('does not rewind a projection the stream has already carried past', () => {
		apply(
			wake(),
			listenStart(),
			event('speak-start', {
				utteranceId: 'u1',
				sentenceCount: 1,
				ttsProviderId: 'mock-tts',
			})
		);
		expect(useVoiceSessionStore.getState().state).toBe('speaking');

		// A catch-up read that resolved late, describing an earlier moment.
		useVoiceSessionStore.getState().applySnapshot({
			sessionId: SESSION,
			state: 'arming',
			scope: { kind: 'conductor' },
			seq: 1,
			providerIds: { stt: 'mock-stt', tts: 'mock-tts', brain: 'mock-brain' },
		});
		expect(useVoiceSessionStore.getState().state).toBe('speaking');
		expect(useVoiceSessionStore.getState().providerIds?.tts).toBe('mock-tts');
	});

	it('ignores a null snapshot while a session is live', () => {
		apply(wake(), listenStart());
		useVoiceSessionStore.getState().applySnapshot(null);
		expect(useVoiceSessionStore.getState().state).toBe('listening');
	});
});
