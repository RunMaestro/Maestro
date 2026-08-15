/**
 * @file realtime-session.test.ts
 *
 * The two properties that make the realtime tier safe to swap in:
 *
 *   1. **Routing stays Maestro's.** The model asks for an agent and a tab through
 *      a tool call; Maestro validates it against the live roster and performs it.
 *      A model that names an agent nobody is running does NOT get to dispatch
 *      there, exactly as in the cascade.
 *   2. **Interruption propagates.** Barge-in has to reach the SERVER, cancelling
 *      generation and dropping audio already queued there. A cancel that only
 *      stopped the local iterator would leave the assistant talking over the
 *      person who interrupted it.
 *
 * The socket is injected, so the whole protocol is exercised with no network and
 * no API key.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	RealtimePipeline,
	RealtimeVoiceAdapter,
	ROUTE_TOOL_NAME,
	type RealtimeSocket,
} from '../../../../main/acappella/providers/realtime/realtime-session';
import type { RosterAgent } from '../../../../shared/acappella/protocol';
import type { SttCallbacks, TtsChunk } from '../../../../shared/acappella/providers';

const ROSTER: RosterAgent[] = [
	{
		sessionId: 'agent-backend',
		name: 'Backend',
		agentType: 'claude-code',
		cwd: '/repo/api',
		tabs: [{ id: 'tab-auth', name: 'Auth', lastActiveAt: 1 }],
	},
];

/** An in-memory socket that records what was sent and can push events back. */
class FakeSocket implements RealtimeSocket {
	readonly sent: Array<Record<string, unknown>> = [];
	closed = false;
	private handlers: Record<string, Array<(...args: never[]) => void>> = {};

	send(data: string): void {
		this.sent.push(JSON.parse(data) as Record<string, unknown>);
	}

	close(): void {
		this.closed = true;
		this.emit('close');
	}

	on(event: string, handler: (...args: never[]) => void): void {
		(this.handlers[event] ??= []).push(handler);
	}

	emit(event: string, ...args: unknown[]): void {
		for (const handler of this.handlers[event] ?? []) {
			(handler as (...inner: unknown[]) => void)(...args);
		}
	}

	/** Push one server event, as the API would. */
	server(payload: Record<string, unknown>): void {
		this.emit('message', JSON.stringify(payload));
	}

	/** Everything sent of a given type. */
	sentOfType(type: string): Array<Record<string, unknown>> {
		return this.sent.filter((message) => message.type === type);
	}
}

function noopCallbacks(): SttCallbacks {
	return { onPartial: () => {}, onFinal: () => {}, onError: () => {} };
}

let socket: FakeSocket;

/** Build an adapter over a socket that opens on the next tick. */
async function startAdapter(callbacks: SttCallbacks = noopCallbacks()) {
	socket = new FakeSocket();
	const adapter = new RealtimeVoiceAdapter({
		readCredential: () => 'sk-test-abcdefghijklmnop',
		socketFactory: () => socket,
		routeTimeoutMs: 50,
		responseTimeoutMs: 50,
	});

	const started = adapter.start(callbacks);
	socket.emit('open');
	await started;
	return adapter;
}

beforeEach(() => {
	socket = new FakeSocket();
});

describe('RealtimeVoiceAdapter', () => {
	it('declares the routing tool on the session', async () => {
		await startAdapter();

		const update = socket.sentOfType('session.update')[0];
		const session = update.session as { tools: Array<{ name: string }> };
		expect(session.tools.map((tool) => tool.name)).toEqual([ROUTE_TOOL_NAME]);
	});

	it('refuses to connect without a key', async () => {
		const adapter = new RealtimeVoiceAdapter({
			readCredential: () => null,
			socketFactory: () => new FakeSocket(),
		});

		await expect(adapter.start(noopCallbacks())).rejects.toThrow(/API key/i);
	});

	it('turns the transcription events into partials and a final', async () => {
		const partials: string[] = [];
		const finals: string[] = [];
		await startAdapter({
			onPartial: (text) => partials.push(text),
			onFinal: (text) => finals.push(text),
			onError: () => {},
		});

		socket.server({ type: 'conversation.item.input_audio_transcription.delta', delta: 'open ' });
		socket.server({
			type: 'conversation.item.input_audio_transcription.completed',
			transcript: 'open the auth tab',
		});

		expect(partials).toEqual(['open ']);
		expect(finals).toEqual(['open the auth tab']);
	});

	it('executes a tool-call route decision through the shared parser', async () => {
		const adapter = await startAdapter();

		const routing = adapter.route('ask backend about auth', {
			roster: ROSTER,
			scope: { kind: 'conductor' },
		});

		socket.server({
			type: 'response.function_call_arguments.done',
			arguments: JSON.stringify({
				target: { sessionId: 'agent-backend' },
				tabAction: 'recall',
				tabId: 'tab-auth',
				prompt: 'what happened to auth',
				confidence: 0.8,
			}),
		});

		// The decision Maestro will EXECUTE, not something the model performed.
		expect(await routing).toEqual({
			target: { sessionId: 'agent-backend' },
			tabAction: 'recall',
			tabId: 'tab-auth',
			tabName: undefined,
			prompt: 'what happened to auth',
			confidence: 0.8,
		});
	});

	it('sends a tool call naming an agent that is not running to the conductor', async () => {
		const adapter = await startAdapter();

		const routing = adapter.route('ask ghost something', {
			roster: ROSTER,
			scope: { kind: 'conductor' },
		});

		socket.server({
			type: 'response.function_call_arguments.done',
			arguments: JSON.stringify({
				target: { sessionId: 'ghost' },
				tabAction: 'current',
				prompt: 'something',
				confidence: 0.9,
			}),
		});

		expect((await routing).target).toBe('conductor');
	});

	it('hands the turn to the conductor when no tool call arrives', async () => {
		const adapter = await startAdapter();

		// No tool call at all: the turn must still resolve, or the session hangs
		// with the user waiting on silence.
		const decision = await adapter.route('do the thing', {
			roster: ROSTER,
			scope: { kind: 'conductor' },
		});

		expect(decision.target).toBe('conductor');
		expect(decision.prompt).toBe('do the thing');
	});

	it('cuts the spoken reply into sentences with their own audio', async () => {
		const adapter = await startAdapter();

		const conversing = adapter.converse('The migration finished and the tests pass.', {
			agentSessionId: 'agent-backend',
			tabId: 'tab-auth',
		});

		socket.server({ type: 'response.audio_transcript.delta', delta: 'Migration done. ' });
		socket.server({ type: 'response.audio.delta', delta: Buffer.from([1, 2]).toString('base64') });
		socket.server({ type: 'response.audio_transcript.delta', delta: 'Tests pass.' });
		socket.server({ type: 'response.audio.delta', delta: Buffer.from([3, 4]).toString('base64') });
		socket.server({ type: 'response.done' });

		const spoken = await conversing;
		expect(spoken).toBe('Migration done. Tests pass.');

		const chunks: TtsChunk[] = [];
		for await (const chunk of adapter.speak(spoken, { utteranceId: 'u1' })) chunks.push(chunk);

		expect(chunks.map((chunk) => chunk.text)).toEqual(['Migration done.', 'Tests pass.']);
		// Audio, not a re-synthesis: the model already made it.
		expect(chunks[0].format).toBe('pcm16');
		expect(chunks[0].audio).toBeInstanceOf(Uint8Array);
	});

	it('propagates an interruption to the server and drops queued audio', async () => {
		const adapter = await startAdapter();

		adapter.cancel();

		// Both matter. `response.cancel` stops generation; without the buffer clear
		// the server keeps streaming what it had already made and the assistant
		// talks over the interruption.
		expect(socket.sentOfType('response.cancel')).toHaveLength(1);
		expect(socket.sentOfType('output_audio_buffer.clear')).toHaveLength(1);
	});

	it('stops delivering sentences once cancelled', async () => {
		const adapter = await startAdapter();

		const conversing = adapter.converse('Something happened.', {
			agentSessionId: 'agent-backend',
			tabId: 'tab-auth',
		});
		socket.server({ type: 'response.audio_transcript.delta', delta: 'One. Two. Three.' });
		socket.server({ type: 'response.done' });
		const spoken = await conversing;

		const chunks: TtsChunk[] = [];
		for await (const chunk of adapter.speak(spoken, { utteranceId: 'u1' })) {
			chunks.push(chunk);
			adapter.cancel();
		}

		expect(chunks).toHaveLength(1);
	});

	it('reports a server error as a classified network failure', async () => {
		const errors: Error[] = [];
		await startAdapter({
			onPartial: () => {},
			onFinal: () => {},
			onError: (error) => errors.push(error),
		});

		socket.server({ type: 'error', error: { message: 'session expired' } });

		expect(errors[0].message).toContain('session expired');
	});

	it('closes the socket on stop', async () => {
		const adapter = await startAdapter();
		await adapter.stop();
		expect(socket.closed).toBe(true);
	});

	it('upsamples capture audio to the rate the API speaks', async () => {
		const adapter = await startAdapter();

		// 320 samples of 16 kHz is 20 ms; at 24 kHz that is 480 samples, so 960
		// bytes. Sending 16 kHz samples labelled as 24 kHz would make every voice
		// sound like a chipmunk and every transcript wrong.
		adapter.feed(new Int16Array(320));

		const appended = socket.sentOfType('input_audio_buffer.append')[0];
		expect(Buffer.from(String(appended.audio), 'base64').byteLength).toBe(960);
	});
});

describe('RealtimePipeline', () => {
	it('puts one adapter in all three slots', async () => {
		const adapter = await startAdapter();
		const pipeline = new RealtimePipeline(adapter);

		expect(pipeline.shape).toBe('realtime');
		expect(pipeline.providers.stt).toBe(adapter);
		expect(pipeline.providers.tts).toBe(adapter);
		expect(pipeline.providers.brain).toBe(adapter);
	});

	it('closes the session when disposed', async () => {
		const adapter = await startAdapter();
		await new RealtimePipeline(adapter).dispose();

		expect(socket.closed).toBe(true);
	});
});
