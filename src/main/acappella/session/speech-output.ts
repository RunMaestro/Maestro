/**
 * Coordinates spoken output for a voice session: single-reply and streamed
 * agent-output translation, TTS scheduling, active-stream tracking, and
 * teardown of in-flight speech.
 */

import type {
	SpeakEndReason,
	VoiceEvent,
	VoiceEventBase,
	VoiceEventType,
} from '../../../shared/acappella/protocol';
import type { TtsChunk, TtsProvider } from '../../../shared/acappella/providers';
import {
	isVoiceProviderError,
	type VoiceProviderError,
} from '../../../shared/acappella/provider-errors';
import type { VoiceSessionState } from '../../../shared/acappella/session-state';
import { generateUUID } from '../../../shared/uuid';
import { logger } from '../../utils/logger';
import type { AgentOutputChunk } from '../speech/agent-output-tap';
import type { BargeInController } from '../speech/barge-in';
import type { ConversationalTranslator } from '../speech/conversational-translator';
import type { DetailBuffer } from '../speech/drill-down';
import { SpeechScheduler, type SpeechRunResult } from '../speech/speech-scheduler';
import type { AgentReplyStream, VoiceDispatchResult } from '../voice-session-service';

const LOG_CONTEXT = 'ACappella';

type VoiceEventBody<T extends VoiceEventType> = Omit<
	Extract<VoiceEvent, { type: T }>,
	keyof VoiceEventBase | 'type'
>;

export interface SpeechOutputCoordinatorDeps {
	tts: TtsProvider;
	translator: ConversationalTranslator;
	detail: DetailBuffer;
	bargeIn: BargeInController;
	agentReplyStream?: AgentReplyStream;
	maxSentencesPerTurn?: number;
	getSpeechOptions?: () => { voiceId?: string; rate?: number };
	onSpeechChunk?: (chunk: TtsChunk) => void;
	getState: () => VoiceSessionState;
	getTurn: () => number;
	isCurrentTurn: (turn: number) => boolean;
	transition: (to: VoiceSessionState) => void;
	emitListenStart: () => void;
	emitSpeakStart: (body: VoiceEventBody<'speak-start'>) => void;
	emitSpeakSentence: (body: VoiceEventBody<'speak-sentence'>) => void;
	emitSpeakEnd: (body: VoiceEventBody<'speak-end'>) => void;
	emitAgentReply: (body: VoiceEventBody<'agent-reply'>) => void;
	markTimer: (stage: 'agentFirstToken' | 'firstSpokenSentence') => void;
	closeTurnMetrics: () => void;
	onProviderError: (error: VoiceProviderError, providerId?: string) => void;
	onUnexpectedError: (error: Error, context: string) => void;
	onFloorQuiet: () => void;
}

export class SpeechOutputCoordinator {
	private activeUtteranceId: string | null = null;
	private scheduler: SpeechScheduler | null = null;
	private speechTeardown = false;
	private speechError: Error | null = null;
	private translationAbort: AbortController | null = null;

	private streamTarget: { agentSessionId: string; tabId: string; turn: number } | null = null;
	private streamChain: Promise<void> = Promise.resolve();
	private streamDetail = '';
	private streamMarked = false;

	constructor(private readonly deps: SpeechOutputCoordinatorDeps) {}

	getActiveUtteranceId(): string | null {
		return this.activeUtteranceId;
	}

	getForegroundAgentSessionId(): string | null {
		return this.streamTarget?.agentSessionId ?? null;
	}

	resetStreamMetadata(): void {
		this.streamDetail = '';
		this.streamMarked = false;
	}

	/**
	 * A WHOLE agent reply, already finished. Reshapes it for the ear and speaks it.
	 */
	async submitAgentReply(params: {
		agentSessionId: string;
		tabId: string;
		text: string;
	}): Promise<boolean> {
		const state = this.deps.getState();
		if (state !== 'dispatching') {
			logger.warn(`Agent reply ignored in state '${state}'`, LOG_CONTEXT);
			return false;
		}

		const turn = this.deps.getTurn();
		this.deps.markTimer('agentFirstToken');
		this.stopStreaming();

		const sentences: string[] = [];
		try {
			for await (const sentence of this.deps.translator.translate({
				agentSessionId: params.agentSessionId,
				tabId: params.tabId,
				text: params.text,
				kind: 'final',
			})) {
				sentences.push(sentence);
			}
		} catch (error) {
			if (!isVoiceProviderError(error)) throw error;
			this.deps.onProviderError(error, error.providerId);
			return true;
		}
		if (!this.deps.isCurrentTurn(turn)) return false;

		const spokenText = sentences.join(' ');
		this.deps.emitAgentReply({
			agentSessionId: params.agentSessionId,
			tabId: params.tabId,
			text: params.text,
			spokenText,
		});
		this.deps.detail.record({
			agentSessionId: params.agentSessionId,
			tabId: params.tabId,
			detail: params.text,
			spoken: [],
		});

		if (sentences.length === 0) {
			this.deps.transition('listening');
			this.deps.emitListenStart();
			return true;
		}

		this.deps.transition('speaking');
		try {
			await this.speak(spokenText, turn);
		} catch (error) {
			if (isVoiceProviderError(error)) this.deps.onProviderError(error, error.providerId);
			else this.deps.onUnexpectedError(error as Error, 'acappella.speak');
		}
		return true;
	}

	/**
	 * One coherent piece of a dispatched agent's output, as it is written.
	 */
	pushAgentOutput(chunk: AgentOutputChunk): void {
		const target = this.streamTarget;
		if (!target) return;
		if (chunk.agentSessionId !== target.agentSessionId || chunk.tabId !== target.tabId) return;
		if (!this.deps.isCurrentTurn(target.turn)) {
			this.stopStreaming();
			return;
		}
		const state = this.deps.getState();
		if (state !== 'dispatching' && state !== 'speaking') return;

		this.streamDetail += this.streamDetail ? ` ${chunk.text}` : chunk.text;

		this.streamChain = this.streamChain
			.then(() => this.speakChunk(chunk, target.turn))
			.catch((error: Error) => {
				if (isVoiceProviderError(error)) this.deps.onProviderError(error, error.providerId);
				else this.deps.onUnexpectedError(error, 'acappella.pushAgentOutput');
			});
	}

	/**
	 * Speak text that is already in its final spoken form, and wait for it.
	 */
	async speak(spokenText: string, turn: number): Promise<void> {
		const scheduler = this.beginSpeechRun({ seed: spokenText, streaming: false, turn });
		scheduler.close();
		await scheduler.drained();
	}

	/**
	 * Follow a dispatched tab's output. The turn stays open until the agent
	 * finishes writing, which is what lets the reply be spoken as it arrives.
	 */
	beginStreaming(result: VoiceDispatchResult, turn: number): void {
		if (!this.deps.agentReplyStream) return;
		if (!result.promptSent) return;

		this.stopStreaming();
		this.streamDetail = '';
		this.streamMarked = false;
		this.translationAbort = new AbortController();
		this.streamTarget = {
			agentSessionId: result.agentSessionId,
			tabId: result.tabId,
			turn,
		};
		this.deps.agentReplyStream.watch({
			agentSessionId: result.agentSessionId,
			tabId: result.tabId,
		});
	}

	/** Stop following the dispatched tab. Any run already on the floor is untouched. */
	stopStreaming(): void {
		const target = this.streamTarget;
		if (!target) return;
		this.streamTarget = null;
		this.deps.agentReplyStream?.unwatch({
			agentSessionId: target.agentSessionId,
			tabId: target.tabId,
		});
	}

	/** Barge-in's fourth step: the rewrite behind the synthesis. */
	abortTranslation(): void {
		this.translationAbort?.abort();
		this.translationAbort = null;
	}

	/** Cancel the active scheduler for barge-in, allowing `completeSpeechRun` to emit. */
	cancelScheduler(reason: 'interrupted'): SpeechRunResult | null {
		return this.scheduler?.cancel(reason) ?? null;
	}

	/**
	 * Cancel any speech run WITHOUT emitting. Callers own the events.
	 */
	cancel(): void {
		this.abortTranslation();
		this.stopStreaming();

		const scheduler = this.scheduler;
		if (!scheduler) {
			this.activeUtteranceId = null;
			return;
		}
		this.speechTeardown = true;
		scheduler.cancel('interrupted');
		this.speechTeardown = false;
	}

	private beginSpeechRun(params: {
		seed?: string;
		streaming: boolean;
		turn: number;
	}): SpeechScheduler {
		const utteranceId = generateUUID();
		this.activeUtteranceId = utteranceId;
		this.speechTeardown = false;

		const scheduler = new SpeechScheduler({
			tts: this.deps.tts,
			maxSentencesPerTurn: this.deps.maxSentencesPerTurn,
			speechOptions: this.deps.getSpeechOptions,
			onStart: (event) =>
				this.deps.emitSpeakStart({
					utteranceId: event.utteranceId,
					sentenceCount: event.sentenceCount,
					ttsProviderId: event.ttsProviderId,
					streaming: params.streaming,
				}),
			onSentence: (event) => {
				this.deps.markTimer('firstSpokenSentence');
				this.deps.emitSpeakSentence(event);
			},
			onChunk: (chunk) => this.deps.onSpeechChunk?.(chunk),
			onError: (error) => {
				this.speechError = error;
			},
			onEnd: (result) => this.completeSpeechRun(result, params.turn),
		});

		this.scheduler = scheduler;
		this.deps.bargeIn.noteSpeechStarted();
		scheduler.begin(utteranceId, params.seed);
		return scheduler;
	}

	private completeSpeechRun(result: SpeechRunResult, turn: number): void {
		this.scheduler = null;
		this.activeUtteranceId = null;
		this.deps.bargeIn.noteSpeechEnded();

		this.deps.translator.rememberSpoken(result.spoken);
		this.deps.detail.noteSpoken(result.spoken);

		if (this.speechTeardown) return;

		this.deps.emitSpeakEnd({ utteranceId: result.utteranceId, reason: speakEndReason(result) });

		if (result.reason === 'interrupted') return;

		if (result.reason === 'error') {
			const error = this.speechError;
			this.speechError = null;
			if (error && isVoiceProviderError(error)) this.deps.onProviderError(error, error.providerId);
			else if (error) this.deps.onUnexpectedError(error, 'acappella.speak');
			return;
		}

		this.stopStreaming();
		if (this.deps.getState() !== 'speaking') return;
		if (this.deps.isCurrentTurn(turn)) this.deps.closeTurnMetrics();
		this.deps.transition('listening');
		this.deps.emitListenStart();
		this.deps.onFloorQuiet();
	}

	private async speakChunk(chunk: AgentOutputChunk, turn: number): Promise<void> {
		if (!this.deps.isCurrentTurn(turn)) return;
		if (!this.streamMarked) {
			this.streamMarked = true;
			this.deps.markTimer('agentFirstToken');
		}

		const abort = (this.translationAbort ??= new AbortController());
		const spoken: string[] = [];

		for await (const sentence of this.deps.translator.translate({
			agentSessionId: chunk.agentSessionId,
			tabId: chunk.tabId,
			text: chunk.text,
			kind: chunk.kind,
			signal: abort.signal,
		})) {
			if (abort.signal.aborted || !this.deps.isCurrentTurn(turn)) return;
			const scheduler = this.ensureSpeechRun(turn);
			if (!scheduler) return;
			spoken.push(sentence);
			scheduler.pushSentence(sentence);
		}

		if (spoken.length > 0) {
			this.deps.emitAgentReply({
				agentSessionId: chunk.agentSessionId,
				tabId: chunk.tabId,
				text: chunk.text,
				spokenText: spoken.join(' '),
			});
		}

		if (chunk.kind === 'final') this.closeStream();
	}

	private ensureSpeechRun(turn: number): SpeechScheduler | null {
		if (this.scheduler) return this.scheduler;
		if (this.deps.getState() === 'dispatching') this.deps.transition('speaking');
		if (this.deps.getState() !== 'speaking') return null;
		return this.beginSpeechRun({ streaming: true, turn });
	}

	private closeStream(): void {
		const target = this.streamTarget;
		this.stopStreaming();

		if (target && this.streamDetail.trim()) {
			this.deps.detail.record({
				agentSessionId: target.agentSessionId,
				tabId: target.tabId,
				detail: this.streamDetail,
				spoken: [],
			});
		}

		if (this.scheduler) {
			this.scheduler.close();
			return;
		}
		if (this.deps.getState() === 'dispatching') {
			this.deps.transition('listening');
			this.deps.emitListenStart();
		}
	}
}

function speakEndReason(result: SpeechRunResult): SpeakEndReason {
	if (result.reason === 'interrupted') return 'cancelled';
	return result.reason === 'error' ? 'error' : 'complete';
}
