/**
 * @file provider-registry.test.ts
 *
 * The rules the registry exists to enforce, one test each:
 *
 *   - Every slot combination resolves to what was ASKED for, independently.
 *   - A missing local provider NEVER resolves to a hosted one. This is the test
 *     that would fail if someone added a "helpful" fallback, and it is checked
 *     exhaustively across every combination rather than on one example, because a
 *     fallback added for one role would be trivially easy to miss on another.
 *   - The mock tier is selected explicitly and is never substituted in.
 *   - A hot swap tears the old pipeline down, and is refused mid-utterance.
 *
 * The concrete providers are stubbed at the module boundary. Constructing a real
 * one would try to open a keychain and a native runtime, and none of that is what
 * these tests are about.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Every real backend is replaced with an inert stand-in: these tests are about
// which one is chosen, and a real one would reach for a keychain entry, a model
// file, or a native addon at construction.
vi.mock('../../../../main/acappella/providers/local/whisper-stt', () => ({
	WhisperSttProvider: class {
		readonly id = 'whisper-local';
		readonly label = 'Whisper (local)';
		readonly tier = 'local';
		readonly sampleRate = 16_000;
		readonly acceptsAudio = true;
		async start() {}
		feed() {}
		async flush() {}
		async stop() {}
	},
}));
vi.mock('../../../../main/acappella/providers/local/kokoro-tts', () => ({
	KokoroTtsProvider: class {
		readonly id = 'kokoro-local';
		readonly label = 'Kokoro (local)';
		readonly tier = 'local';
		speak() {
			return (async function* () {})();
		}
		cancel() {}
	},
}));
vi.mock('../../../../main/acappella/providers/local/llama-brain', () => ({
	LlamaBrainProvider: class {
		readonly id = 'qwen3-local';
		readonly label = 'Qwen3 1.7B (local)';
		readonly tier = 'local';
		async route() {
			return { target: 'conductor', tabAction: 'current', prompt: '', confidence: 1 };
		}
		async converse() {
			return '';
		}
	},
}));
vi.mock('../../../../main/acappella/providers/hosted/openai-stt', () => ({
	OpenAiSttProvider: class {
		readonly id = 'openai-stt';
		readonly label = 'OpenAI (hosted)';
		readonly tier = 'cloud';
		readonly sampleRate = 16_000;
		readonly acceptsAudio = true;
		async start() {}
		feed() {}
		async flush() {}
		async stop() {}
	},
}));
vi.mock('../../../../main/acappella/providers/hosted/elevenlabs-tts', () => ({
	ElevenLabsTtsProvider: class {
		readonly id = 'elevenlabs-tts';
		readonly label = 'ElevenLabs (hosted)';
		readonly tier = 'cloud';
		speak() {
			return (async function* () {})();
		}
		cancel() {}
	},
}));
vi.mock('../../../../main/acappella/providers/hosted/openai-brain', () => ({
	OpenAiBrainProvider: class {
		readonly id = 'openai-brain';
		readonly label = 'OpenAI (hosted)';
		readonly tier = 'cloud';
		async route() {
			return { target: 'conductor', tabAction: 'current', prompt: '', confidence: 1 };
		}
		async converse() {
			return '';
		}
	},
}));
vi.mock('../../../../main/acappella/providers/hosted/anthropic-brain', () => ({
	AnthropicBrainProvider: class {
		readonly id = 'anthropic-brain';
		readonly label = 'Anthropic (hosted)';
		readonly tier = 'cloud';
		async route() {
			return { target: 'conductor', tabAction: 'current', prompt: '', confidence: 1 };
		}
		async converse() {
			return '';
		}
	},
}));

const realtimeDispose = vi.fn(async () => {});
vi.mock('../../../../main/acappella/providers/realtime/realtime-session', () => {
	const adapter = {
		id: 'openai-realtime',
		label: 'OpenAI Realtime',
		tier: 'cloud',
		sampleRate: 16_000,
		acceptsAudio: true,
	};
	return {
		createRealtimePipeline: () => ({
			shape: 'realtime',
			providers: { stt: adapter, tts: adapter, brain: adapter },
			dispose: realtimeDispose,
		}),
	};
});

import { logger } from '../../../../main/utils/logger';
import {
	MockBrainProvider,
	MockSttProvider,
	MockTtsProvider,
} from '../../../../main/acappella/providers/mock';
import { ECHO_STT_PROVIDER_ID } from '../../../../main/acappella/providers/echo-stt';
import {
	DEFAULT_PROVIDER_IDS,
	MOCK_PROVIDER_IDS,
	buildProviderState,
	listVoiceProviders,
	pipelineKey,
	readVoiceProviderSettings,
	registerVoiceProvider,
	resolveVoicePipeline,
	resolveVoiceProviders,
	swapVoicePipeline,
} from '../../../../main/acappella/providers/provider-registry';
import { unresolvedProviderId } from '../../../../main/acappella/providers/unresolved';
import type { VoiceProviderRole } from '../../../../shared/acappella/providers';

describe('provider registry', () => {
	beforeAll(() => {
		registerVoiceProvider({
			role: 'tts',
			id: 'test-local-tts',
			label: 'Test Local TTS',
			tier: 'local',
			create: () => new MockTtsProvider({ msPerCharacter: 0 }),
		});
		registerVoiceProvider({
			role: 'stt',
			id: 'test-cloud-stt',
			label: 'Test Cloud STT',
			tier: 'cloud',
			create: () => new MockSttProvider({ partialDelayMs: 0 }),
		});
		registerVoiceProvider({
			role: 'brain',
			id: 'test-unavailable-brain',
			label: 'Test Unavailable Brain',
			tier: 'local',
			isAvailable: () => false,
			create: () => new MockBrainProvider(),
		});
	});

	beforeEach(() => {
		vi.mocked(logger.warn).mockClear();
		realtimeDispose.mockClear();
	});

	// -- Resolution ----------------------------------------------------------

	it('defaults to a trio that can hear, and says nothing about it', () => {
		const { providers, substitutions, resolvedIds } = resolveVoiceProviders();

		// STT is the exception to the mock default, and the important one: an
		// unconfigured install has to be able to establish that its microphone
		// reaches the app at all.
		expect(resolvedIds.stt).toBe(ECHO_STT_PROVIDER_ID);
		expect(providers.stt.acceptsAudio).toBe(true);
		expect(resolvedIds.tts).toBe(MOCK_PROVIDER_IDS.tts);
		expect(resolvedIds.brain).toBe(MOCK_PROVIDER_IDS.brain);
		// The default path is documented behaviour, not something to warn about.
		expect(substitutions).toEqual([]);
	});

	it('hands out a fresh trio each time', () => {
		expect(resolveVoiceProviders().providers.stt).not.toBe(resolveVoiceProviders().providers.stt);
	});

	it('resolves every slot combination to exactly what was asked for', () => {
		const choices: Record<VoiceProviderRole, string[]> = {
			stt: ['mock-stt', 'whisper-local', 'openai-stt'],
			tts: ['mock-tts', 'kokoro-local', 'elevenlabs-tts'],
			brain: ['mock-brain', 'qwen3-local', 'openai-brain', 'anthropic-brain'],
		};

		for (const stt of choices.stt) {
			for (const tts of choices.tts) {
				for (const brain of choices.brain) {
					const { resolvedIds, substitutions } = resolveVoicePipeline({
						settings: { stt, tts, brain },
					});
					expect(resolvedIds).toEqual({ stt, tts, brain });
					expect(substitutions).toEqual([]);
				}
			}
		}
	});

	it('never resolves a missing local provider to a hosted one', () => {
		// Hosted providers for every role are registered and perfectly usable. None
		// of them may be chosen for a local id that does not exist.
		const missing: Record<VoiceProviderRole, string> = {
			stt: 'whisper-that-is-not-registered',
			tts: 'kokoro-that-is-not-registered',
			brain: 'qwen-that-is-not-registered',
		};

		for (const role of ['stt', 'tts', 'brain'] as VoiceProviderRole[]) {
			const { providers, resolvedIds, substitutions } = resolveVoicePipeline({
				settings: { [role]: missing[role] },
			});

			expect(resolvedIds[role]).toBe(unresolvedProviderId(role));
			expect(providers[role].tier).not.toBe('cloud');
			expect(substitutions).toEqual([
				expect.objectContaining({ role, requestedId: missing[role], reason: 'unknown-provider' }),
			]);
			expect(logger.warn).toHaveBeenCalled();
		}
	});

	it('refuses by name rather than falling back to the mock', async () => {
		const { providers } = resolveVoicePipeline({ settings: { stt: 'not-a-provider' } });

		// The distinction that matters: a mock STT would "work" and transcribe
		// nothing, which is indistinguishable from a broken feature.
		expect(providers.stt.tier).not.toBe('mock');
		await expect(
			providers.stt.start({ onPartial: () => {}, onFinal: () => {}, onError: () => {} })
		).rejects.toThrow(/not-a-provider/);
	});

	it('marks a registered but unrunnable provider unavailable, not unknown', () => {
		const { substitutions } = resolveVoicePipeline({
			settings: { brain: 'test-unavailable-brain' },
		});

		expect(substitutions[0].reason).toBe('unavailable');
	});

	it('substitutes only the broken role and leaves the others alone', () => {
		const { resolvedIds, substitutions } = resolveVoicePipeline({
			settings: { stt: 'test-missing', tts: 'test-local-tts' },
		});

		expect(resolvedIds.stt).toBe(unresolvedProviderId('stt'));
		expect(resolvedIds.tts).toBe('test-local-tts');
		expect(resolvedIds.brain).toBe(MOCK_PROVIDER_IDS.brain);
		expect(substitutions).toHaveLength(1);
	});

	it.each(['development', 'production'])(
		'defaults STT to a provider that consumes audio in a %s build',
		(env) => {
			// The microphone check used to be development-only, which left a packaged
			// app with NO provider that opens a capture device: the session reported
			// "Listening" and the microphone was never touched. The build must not
			// decide whether the user can hear themselves.
			const previous = process.env.NODE_ENV;
			process.env.NODE_ENV = env;
			try {
				const { resolvedIds, providers, substitutions } = resolveVoicePipeline();

				expect(resolvedIds.stt).toBe(ECHO_STT_PROVIDER_ID);
				expect(providers.stt.acceptsAudio).toBe(true);
				// Nobody asked for it, so it is a default rather than a substitution.
				expect(substitutions).toEqual([]);
				expect(DEFAULT_PROVIDER_IDS.stt).toBe(ECHO_STT_PROVIDER_ID);
			} finally {
				process.env.NODE_ENV = previous;
			}
		}
	);

	it('reports a DEFAULT that fell back to the mock instead of falling back silently', () => {
		// The silence was the bug. A slot that lands on a text-in recogniser nobody
		// chose is the one fact that explains a session which cannot hear, and it
		// used to exist only inside the resolver.
		const previous = process.env.NODE_ENV;
		process.env.NODE_ENV = 'production';
		registerVoiceProvider({
			role: 'tts',
			id: 'test-unavailable-default-tts',
			label: 'Unavailable',
			tier: 'local',
			isAvailable: () => false,
			create: () => ({}) as never,
		});
		const restoreDefault = DEFAULT_PROVIDER_IDS.tts;
		DEFAULT_PROVIDER_IDS.tts = 'test-unavailable-default-tts';
		try {
			const { resolvedIds, substitutions } = resolveVoicePipeline();

			expect(resolvedIds.tts).toBe(MOCK_PROVIDER_IDS.tts);
			expect(substitutions).toEqual([
				expect.objectContaining({
					role: 'tts',
					requestedId: 'test-unavailable-default-tts',
					resolvedId: MOCK_PROVIDER_IDS.tts,
					reason: 'unavailable',
				}),
			]);
		} finally {
			DEFAULT_PROVIDER_IDS.tts = restoreDefault;
			process.env.NODE_ENV = previous;
		}
	});

	it('lists the mock tier as selectable and available', () => {
		expect(listVoiceProviders('stt')).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: MOCK_PROVIDER_IDS.stt, tier: 'mock', available: true }),
			])
		);
	});

	// -- Pipeline shape ------------------------------------------------------

	it('builds a cascade pipeline by default', () => {
		const { shape, pipeline } = resolveVoicePipeline();
		expect(shape).toBe('cascade');
		expect(pipeline.shape).toBe('cascade');
	});

	it('builds a realtime pipeline with one adapter in all three slots', () => {
		const { shape, providers } = resolveVoicePipeline({ settings: { pipeline: 'realtime' } });

		expect(shape).toBe('realtime');
		expect(providers.stt).toBe(providers.tts);
		expect(providers.tts).toBe(providers.brain);
	});

	it('refuses an unknown realtime provider rather than using the one that exists', () => {
		const { shape, resolvedIds, substitutions } = resolveVoicePipeline({
			settings: { pipeline: 'realtime', realtime: 'some-other-realtime' },
		});

		expect(shape).toBe('cascade');
		expect(resolvedIds.stt).toBe(unresolvedProviderId('stt'));
		expect(substitutions).toHaveLength(3);
	});

	// -- Provider state ------------------------------------------------------

	it('describes the live engines and where audio goes', () => {
		const resolution = resolveVoicePipeline({
			settings: { stt: 'whisper-local', tts: 'kokoro-local', brain: 'qwen3-local' },
		});

		const state = buildProviderState(resolution);
		expect(state.pipeline).toBe('cascade');
		expect(state.audioLeavesMachine).toBe(false);
		expect(state.egressStatement).toBe('Audio stays on this machine.');
		expect(state.slots.map((slot) => slot.providerId)).toEqual([
			'whisper-local',
			'kokoro-local',
			'qwen3-local',
		]);
	});

	it('says where audio goes when the recogniser is hosted', () => {
		const state = buildProviderState(
			resolveVoicePipeline({ settings: { stt: 'openai-stt', tts: 'kokoro-local' } })
		);

		expect(state.audioLeavesMachine).toBe(true);
		expect(state.egressStatement).toBe('Audio is sent to OpenAI.');
	});

	it('reports a substituted slot rather than presenting it as configured', () => {
		const state = buildProviderState(resolveVoicePipeline({ settings: { tts: 'gone' } }));
		const tts = state.slots.find((slot) => slot.role === 'tts')!;

		expect(tts.substitutedFor).toBe('gone');
		// A slot that resolved to nothing sends nothing anywhere, whatever it was
		// configured with.
		expect(state.audioLeavesMachine).toBe(false);
	});

	// -- Hot swap ------------------------------------------------------------

	it('does nothing when the selection has not changed', async () => {
		const settings = { stt: 'whisper-local' };
		const current = resolveVoicePipeline({ settings });
		const dispose = vi.spyOn(current.pipeline, 'dispose');

		const result = await swapVoicePipeline({
			settings,
			current: { pipeline: current.pipeline, key: pipelineKey(settings) },
			isBusy: false,
		});

		expect(result.status).toBe('unchanged');
		expect(dispose).not.toHaveBeenCalled();
	});

	it('tears the old pipeline down before building the new one', async () => {
		const current = resolveVoicePipeline({ settings: { stt: 'whisper-local' } });
		const dispose = vi.spyOn(current.pipeline, 'dispose');

		const result = await swapVoicePipeline({
			settings: { stt: 'openai-stt' },
			current: { pipeline: current.pipeline, key: pipelineKey({ stt: 'whisper-local' }) },
			isBusy: false,
		});

		expect(dispose).toHaveBeenCalledTimes(1);
		expect(result.status).toBe('swapped');
		expect(result.resolution?.resolvedIds.stt).toBe('openai-stt');
	});

	it('refuses a swap mid-utterance and leaves the live pipeline alone', async () => {
		const current = resolveVoicePipeline({ settings: { stt: 'whisper-local' } });
		const dispose = vi.spyOn(current.pipeline, 'dispose');

		const result = await swapVoicePipeline({
			settings: { stt: 'openai-stt' },
			current: { pipeline: current.pipeline, key: pipelineKey({ stt: 'whisper-local' }) },
			isBusy: true,
		});

		expect(result.status).toBe('refused');
		expect(result.reason).toMatch(/middle of a turn/i);
		// The important half: nothing was torn down, so the turn in flight still has
		// the engines it started with.
		expect(dispose).not.toHaveBeenCalled();
		expect(result.resolution).toBeUndefined();
	});

	it('disposes a realtime pipeline on swap, closing its socket', async () => {
		const current = resolveVoicePipeline({ settings: { pipeline: 'realtime' } });

		await swapVoicePipeline({
			settings: { pipeline: 'cascade' },
			current: { pipeline: current.pipeline, key: pipelineKey({ pipeline: 'realtime' }) },
			isBusy: false,
		});

		expect(realtimeDispose).toHaveBeenCalledTimes(1);
	});

	// -- Settings ------------------------------------------------------------

	it('reads provider ids out of settings and ignores malformed values', () => {
		const store = {
			get: () => ({
				providers: { stt: ' whisper-local ', tts: 42, brain: '   ' },
				pipeline: 'realtime',
				voice: { voiceId: 'af_heart', rate: 1.1 },
			}),
		};

		expect(readVoiceProviderSettings(store)).toEqual({
			stt: 'whisper-local',
			tts: undefined,
			brain: undefined,
			pipeline: 'realtime',
			realtime: undefined,
			voiceId: 'af_heart',
			rate: 1.1,
			// Clamped rather than passed through: this becomes a gain on a live
			// output node, so an absent or nonsensical value reads as full volume.
			volume: 1,
		});
	});

	it('treats a missing settings key as unset and the shape as cascade', () => {
		const store = { get: (_key: string, defaultValue: unknown) => defaultValue };

		expect(readVoiceProviderSettings(store)).toEqual({
			stt: undefined,
			tts: undefined,
			brain: undefined,
			pipeline: 'cascade',
			realtime: undefined,
			voiceId: undefined,
			rate: undefined,
			volume: 1,
		});
	});

	it('keys a selection so an unchanged one is recognised', () => {
		expect(pipelineKey({ stt: 'a', tts: 'b', brain: 'c' })).toBe(
			pipelineKey({ stt: 'a', tts: 'b', brain: 'c' })
		);
		expect(pipelineKey({ stt: 'a' })).not.toBe(pipelineKey({ stt: 'b' }));
		expect(pipelineKey({ voiceId: 'x' })).not.toBe(pipelineKey({ voiceId: 'y' }));
	});
});
