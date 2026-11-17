import { describe, expect, it, vi } from 'vitest';
import type { TtsChunk, TtsProvider, BrainProvider } from '../../../../shared/acappella/providers';
import { VoiceProviderError } from '../../../../shared/acappella/provider-errors';
import type { VoiceSessionState } from '../../../../shared/acappella/session-state';
import { BargeInController } from '../../../../main/acappella/speech/barge-in';
import { ConversationalTranslator } from '../../../../main/acappella/speech/conversational-translator';
import { DetailBuffer } from '../../../../main/acappella/speech/drill-down';
import {
	SpeechOutputCoordinator,
	type SpeechOutputCoordinatorDeps,
} from '../../../../main/acappella/session/speech-output';

function makeTts(speakImpl?: TtsProvider['speak']): TtsProvider {
	return {
		id: 'mock-tts',
		speak:
			speakImpl ??
			async function* (_text, _opts, signal) {
				if (signal?.aborted) return;
				const chunk: TtsChunk = { format: 'none', data: new Uint8Array(), isFinal: true };
				yield chunk;
			},
		cancel: vi.fn(),
	};
}

function makeBrain(): BrainProvider {
	return {
		id: 'mock-brain',
		route: vi.fn(),
		translateForSpeech: vi.fn(async function* (input) {
			yield input.text;
		}),
	};
}

describe('SpeechOutputCoordinator', () => {
	function createHarness(overrides: Partial<SpeechOutputCoordinatorDeps> = {}) {
		let state: VoiceSessionState = 'dispatching';
		let turn = 1;
		const transitions: VoiceSessionState[] = [];
		const events: { type: string; body: unknown }[] = [];
		const closeTurnMetrics = vi.fn();
		const onFloorQuiet = vi.fn();
		const onProviderError = vi.fn();
		const onUnexpectedError = vi.fn();
		const watch = vi.fn();
		const unwatch = vi.fn();

		const translator = new ConversationalTranslator({
			brain: makeBrain(),
			maxSentences: 2,
		});
		const detail = new DetailBuffer();
		const bargeIn = new BargeInController({
			duck: vi.fn(),
			flushPlayback: vi.fn(),
			cancelSpeech: () => coordinator.cancelScheduler('interrupted'),
			cancelTranslation: () => coordinator.abortTranslation(),
			toListening: () => {},
		});

		const coordinator = new SpeechOutputCoordinator({
			tts: makeTts(),
			translator,
			detail,
			bargeIn,
			agentReplyStream: { watch, unwatch },
			getState: () => state,
			getTurn: () => turn,
			isCurrentTurn: (t) => t === turn,
			transition: (to) => {
				state = to;
				transitions.push(to);
			},
			emitListenStart: () => events.push({ type: 'listen-start', body: {} }),
			emitSpeakStart: (body) => events.push({ type: 'speak-start', body }),
			emitSpeakSentence: (body) => events.push({ type: 'speak-sentence', body }),
			emitSpeakEnd: (body) => events.push({ type: 'speak-end', body }),
			emitAgentReply: (body) => events.push({ type: 'agent-reply', body }),
			markTimer: vi.fn(),
			closeTurnMetrics,
			onProviderError,
			onUnexpectedError,
			onFloorQuiet,
			...overrides,
		});

		return {
			coordinator,
			getState: () => state,
			setState: (next: VoiceSessionState) => {
				state = next;
			},
			bumpTurn: () => ++turn,
			transitions,
			events,
			closeTurnMetrics,
			onFloorQuiet,
			onProviderError,
			onUnexpectedError,
			watch,
			unwatch,
			detail,
		};
	}

	it('speaks a submitted agent reply, transitions through speaking to listening, and closes metrics', async () => {
		const { coordinator, transitions, events, closeTurnMetrics, onFloorQuiet } = createHarness();

		const handled = await coordinator.submitAgentReply({
			agentSessionId: 'agent-1',
			tabId: 'tab-1',
			text: 'Tests passed.',
		});

		expect(handled).toBe(true);
		expect(transitions).toEqual(['speaking', 'listening']);
		expect(events.map((e) => e.type)).toEqual([
			'agent-reply',
			'speak-start',
			'speak-sentence',
			'speak-end',
			'listen-start',
		]);
		expect(closeTurnMetrics).toHaveBeenCalledTimes(1);
		expect(onFloorQuiet).toHaveBeenCalledTimes(1);
		expect(coordinator.getActiveUtteranceId()).toBeNull();
	});

	it('streams agent output chunks, records detail, and closes the stream on final', async () => {
		const { coordinator, watch, unwatch, events, detail } = createHarness();
		const recordSpy = vi.spyOn(detail, 'record');

		coordinator.beginStreaming(
			{
				agentSessionId: 'agent-1',
				agentName: 'Agent 1',
				tabId: 'tab-1',
				action: 'recall',
				promptSent: true,
			},
			1
		);
		expect(watch).toHaveBeenCalledWith({ agentSessionId: 'agent-1', tabId: 'tab-1' });
		expect(coordinator.getForegroundAgentSessionId()).toBe('agent-1');

		coordinator.pushAgentOutput({
			agentSessionId: 'agent-1',
			tabId: 'tab-1',
			text: 'First sentence.',
			kind: 'final',
		});

		await vi.waitFor(() => {
			expect(events.some((e) => e.type === 'speak-end')).toBe(true);
		});

		expect(unwatch).toHaveBeenCalledWith({ agentSessionId: 'agent-1', tabId: 'tab-1' });
		expect(coordinator.getForegroundAgentSessionId()).toBeNull();
		expect(events.some((e) => e.type === 'agent-reply')).toBe(true);
		expect(recordSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				agentSessionId: 'agent-1',
				tabId: 'tab-1',
				detail: 'First sentence.',
			})
		);
	});

	it('suppresses speak-end on cancel() teardown', async () => {
		let resolveSpeak: (() => void) | null = null;
		const slowTts = makeTts(async function* () {
			await new Promise<void>((resolve) => {
				resolveSpeak = resolve;
			});
		});
		const { coordinator, setState, events, unwatch } = createHarness({ tts: slowTts });

		coordinator.beginStreaming(
			{
				agentSessionId: 'agent-1',
				agentName: 'Agent 1',
				tabId: 'tab-1',
				action: 'recall',
				promptSent: true,
			},
			1
		);
		setState('speaking');
		const speakPromise = coordinator.speak('Working on it.', 1);

		coordinator.cancel();
		resolveSpeak?.();
		await speakPromise;

		expect(unwatch).toHaveBeenCalledTimes(1);
		expect(events.some((e) => e.type === 'speak-end')).toBe(false);
		expect(coordinator.getActiveUtteranceId()).toBeNull();
	});

	it('routes VoiceProviderError from TTS to onProviderError', async () => {
		const failingTts = makeTts(async function* () {
			throw new VoiceProviderError('Quota exceeded', { kind: 'quota', providerId: 'bad-tts' });
		});
		const { coordinator, onProviderError } = createHarness({ tts: failingTts });

		const handled = await coordinator.submitAgentReply({
			agentSessionId: 'agent-1',
			tabId: 'tab-1',
			text: 'Hello',
		});

		expect(handled).toBe(true);
		expect(onProviderError).toHaveBeenCalledWith(expect.any(VoiceProviderError), 'bad-tts');
	});
});
