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
vi.mock('../../../../main/acappella/providers/local/parakeet-stt', () => ({
	ParakeetSttProvider: class {
		readonly id = 'parakeet-local';
		readonly label = 'Parakeet (local)';
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
vi.mock('../../../../main/acappella/providers/local/assigned-brain', () => ({
	// The real one runs every turn through the Local Models task router, which
	// this file has no reason to load. What the registry owes it is the id and
	// the source the assignment named, so the stand-in keeps both.
	AssignedBrainProvider: class {
		readonly id: string;
		readonly label: string;
		readonly tier = 'local';
		readonly source: unknown;
		constructor(options: { id: string; source?: { label: string } }) {
			this.id = options.id;
			this.source = options.source;
			this.label = options.source?.label ?? 'Assigned brain';
		}
		async route() {
			return { target: 'conductor', tabAction: 'current', prompt: '', confidence: 1 };
		}
		async converse() {
			return '';
		}
	},
}));
vi.mock('../../../../main/acappella/providers/local/system-tts', () => ({
	SystemVoiceTtsProvider: class {
		readonly id = 'system-tts';
		readonly label = 'System voice (built in)';
		readonly tier = 'local';
		speak() {
			return (async function* () {})();
		}
		cancel() {}
	},
	systemVoiceUnavailability: async () => null,
}));
vi.mock('../../../../main/acappella/providers/hosted/openai-tts', () => ({
	OpenAiTtsProvider: class {
		readonly id = 'openai-tts';
		readonly label = 'OpenAI (hosted)';
		readonly tier = 'cloud';
		speak() {
			return (async function* () {})();
		}
		cancel() {}
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
import { LOCAL_PROVIDER_IDS } from '../../../../shared/acappella/provider-catalog';
import {
	DEFAULT_PROVIDER_IDS,
	MOCK_PROVIDER_IDS,
	buildProviderState,
	createNoticeTtsProvider,
	listVoiceProviders,
	migrateLegacyVoiceProviders,
	noticeTtsProviderId,
	pipelineKey,
	readVoiceProviderSettings,
	registerVoiceProvider,
	resolveVoicePipeline,
	resolveVoiceProviders,
	swapVoicePipeline,
} from '../../../../main/acappella/providers/provider-registry';
import { unresolvedProviderId } from '../../../../main/acappella/providers/unresolved';
import type { VoiceProviderRole } from '../../../../shared/acappella/providers';
import {
	DEFAULT_SEND_HOLD_MS,
	DEFAULT_TURN_SETTLE_MS,
} from '../../../../shared/acappella/voice-controls';

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

	it('defaults to the local trio, and says nothing about it', () => {
		const { providers, substitutions, resolvedIds } = resolveVoiceProviders();

		// The whole point of the default: an unconfigured install resolves to
		// providers that actually transcribe, speak, and route. It used to resolve
		// to the mock tier, which opened the microphone, drew a HUD, showed a level
		// meter, and transcribed nothing - every part healthy, the whole inert.
		expect(resolvedIds.stt).toBe(LOCAL_PROVIDER_IDS.stt);
		expect(providers.stt.acceptsAudio).toBe(true);
		// The voice is the operating system's own and the router is built in, so
		// after the recogniser's download nothing else stands between a fresh
		// install and a spoken reply.
		expect(resolvedIds.tts).toBe('system-tts');
		expect(resolvedIds.brain).toBe('mock-brain');
		expect(providers.brain.label).toBe('Built-in (keyword routing)');
		// The default path is documented behaviour, not something to warn about.
		// A missing MODEL is reported by the capability gate, by name, with the
		// download that fixes it - not by a silent substitution here.
		expect(substitutions).toEqual([]);
	});

	it('hands out a fresh trio each time', () => {
		expect(resolveVoiceProviders().providers.stt).not.toBe(resolveVoiceProviders().providers.stt);
	});

	it('resolves every slot combination to exactly what was asked for', () => {
		const choices: Record<VoiceProviderRole, string[]> = {
			stt: ['mock-stt', 'parakeet-local', 'whisper-local', 'openai-stt'],
			tts: ['mock-tts', 'system-tts', 'kokoro-local', 'openai-tts', 'elevenlabs-tts'],
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
		// Untouched, so it takes the default - which is the local tier.
		expect(resolvedIds.brain).toBe(LOCAL_PROVIDER_IDS.brain);
		expect(substitutions).toHaveLength(1);
	});

	it.each(['development', 'production'])(
		'defaults STT to a provider that consumes audio in a %s build',
		(env) => {
			// The build must not decide whether the user can hear themselves. This
			// used to guard the microphone check being development-only, which left a
			// packaged app with NO provider that opens a capture device; it now guards
			// the same property for the local default.
			const previous = process.env.NODE_ENV;
			process.env.NODE_ENV = env;
			try {
				const { resolvedIds, providers, substitutions } = resolveVoicePipeline();

				expect(resolvedIds.stt).toBe(LOCAL_PROVIDER_IDS.stt);
				expect(providers.stt.acceptsAudio).toBe(true);
				// Nobody asked for it, so it is a default rather than a substitution.
				expect(substitutions).toEqual([]);
				expect(DEFAULT_PROVIDER_IDS.stt).toBe(LOCAL_PROVIDER_IDS.stt);
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
			// Same reasoning, different consequence: this one becomes a timer in
			// front of every dispatch, so an absent value reads as the default wait
			// rather than as zero.
			turnSettleMs: DEFAULT_TURN_SETTLE_MS,
			// Off unless explicitly stored: conversational mode changes what a
			// spoken sentence means, so it is never on by inference.
			conversationalMode: false,
			holdUntilSend: false,
			sendHoldMs: DEFAULT_SEND_HOLD_MS,
			// Absent takes the built-in phrases; a stored empty string is a
			// deliberate "no spoken send", so the two stay distinguishable.
			sendPhrases: undefined,
			wakePhrase: undefined,
			wakeWordEnabled: false,
			wakeSensitivity: undefined,
			wakeDebounceMs: undefined,
			wakeEngine: 'classifier',
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
			turnSettleMs: DEFAULT_TURN_SETTLE_MS,
			conversationalMode: false,
			holdUntilSend: false,
			sendHoldMs: DEFAULT_SEND_HOLD_MS,
			// Absent takes the built-in phrases; a stored empty string is a
			// deliberate "no spoken send", so the two stay distinguishable.
			sendPhrases: undefined,
			wakePhrase: undefined,
			wakeWordEnabled: false,
			wakeSensitivity: undefined,
			wakeDebounceMs: undefined,
			wakeEngine: 'classifier',
		});
	});

	it('keys a selection so an unchanged one is recognised', () => {
		expect(pipelineKey({ stt: 'a', tts: 'b', brain: 'c' })).toBe(
			pipelineKey({ stt: 'a', tts: 'b', brain: 'c' })
		);
		expect(pipelineKey({ stt: 'a' })).not.toBe(pipelineKey({ stt: 'b' }));
		expect(pipelineKey({ voiceId: 'x' })).not.toBe(pipelineKey({ voiceId: 'y' }));
	});

	// -- Legacy settings migration --------------------------------------------

	/** A settings store backed by one in-memory blob. */
	function blobStore(initial: unknown) {
		let blob = initial;
		return {
			get: (_key: string, defaultValue?: unknown) => blob ?? defaultValue,
			set: vi.fn((_key: string, value: unknown) => {
				blob = value;
			}),
			read: () => blob as Record<string, unknown>,
		};
	}

	it('defaults speech-to-text to Parakeet', () => {
		expect(DEFAULT_PROVIDER_IDS.stt).toBe('parakeet-local');
		expect(resolveVoicePipeline().resolvedIds.stt).toBe('parakeet-local');
	});

	it('clears the mock trio an early build persisted, so the local defaults apply', () => {
		// The exact blob an upgraded install was found holding: a session that
		// said "Listening" and printed "Echo utterance 1: 0.6s of speech" forever.
		const store = blobStore({
			providers: { stt: ECHO_STT_PROVIDER_ID, tts: 'mock-tts', brain: 'mock-brain' },
			controls: { conversationalMode: true },
		});

		expect(migrateLegacyVoiceProviders(store)).toBe(true);

		expect(store.read()).toEqual({
			providers: {},
			controls: { conversationalMode: true },
			providersVersion: 5,
		});
		const settings = readVoiceProviderSettings(store);
		expect(resolveVoicePipeline({ settings }).resolvedIds).toEqual(DEFAULT_PROVIDER_IDS);
	});

	it('keeps a mock provider picked alongside a real engine', () => {
		// Echo with a real voice is a deliberate microphone check, not a leftover.
		const store = blobStore({ providers: { stt: ECHO_STT_PROVIDER_ID, tts: 'system-tts' } });

		expect(migrateLegacyVoiceProviders(store)).toBe(false);
		expect(store.read().providers).toEqual({ stt: ECHO_STT_PROVIDER_ID, tts: 'system-tts' });
		expect(store.read().providersVersion).toBe(5);
	});

	it('runs once, so a later deliberate choice of the mock trio stands', () => {
		const store = blobStore({
			providers: { stt: 'mock-stt', tts: 'mock-tts', brain: 'mock-brain' },
			providersVersion: 5,
		});

		expect(migrateLegacyVoiceProviders(store)).toBe(false);
		expect(store.set).not.toHaveBeenCalled();
	});

	it('moves the old default wake phrase, which no detector exists for, to the new default', () => {
		// Version 2 already ran: only the wake phrase step is still owed.
		const store = blobStore({
			providers: { stt: 'parakeet-local' },
			controls: { wakePhrase: 'Hey Maestro', wakeWordEnabled: true },
			providersVersion: 2,
		});

		expect(migrateLegacyVoiceProviders(store)).toBe(true);
		expect(store.read().controls).toEqual({ wakeWordEnabled: true });
		// The provider step did not run twice.
		expect(store.read().providers).toEqual({ stt: 'parakeet-local' });
		expect(store.read().providersVersion).toBe(5);
	});

	it('keeps a wake phrase the user typed themselves', () => {
		const store = blobStore({ controls: { wakePhrase: 'okay computer' }, providersVersion: 2 });

		expect(migrateLegacyVoiceProviders(store)).toBe(false);
		expect(store.read().controls).toEqual({ wakePhrase: 'okay computer' });
	});

	it('moves the old default send phrases, which the panel saved, to the new default', () => {
		// Version 4 already ran: only the send phrase step is still owed.
		const store = blobStore({
			controls: {
				sendPhrases: "good to go, that's it, send it, go ahead, make it so",
				holdUntilSend: true,
			},
			providersVersion: 4,
		});

		expect(migrateLegacyVoiceProviders(store)).toBe(true);
		expect(store.read().controls).toEqual({ holdUntilSend: true });
		// Absent reads as the defaults, which now lead with the new phrase.
		expect(readVoiceProviderSettings(store).sendPhrases).toBeUndefined();
		expect(store.read().providersVersion).toBe(5);
	});

	it('keeps send phrases the user edited, and a list they emptied', () => {
		const edited = blobStore({
			controls: { sendPhrases: 'good to go, ship it' },
			providersVersion: 4,
		});
		expect(migrateLegacyVoiceProviders(edited)).toBe(false);
		expect(edited.read().controls).toEqual({ sendPhrases: 'good to go, ship it' });

		// Empty is a decision: the spoken send is off, and it stays off.
		const emptied = blobStore({ controls: { sendPhrases: '' }, providersVersion: 4 });
		expect(migrateLegacyVoiceProviders(emptied)).toBe(false);
		expect(readVoiceProviderSettings(emptied).sendPhrases).toEqual([]);
	});

	it('clears the old wake phrase and the old send phrases in one pass', () => {
		// Step 5 reads the controls step 3 already rewrote, not the stored copy.
		const store = blobStore({
			controls: {
				wakePhrase: 'hey maestro',
				sendPhrases: "good to go,that's it,send it,go ahead,make it so",
			},
			providersVersion: 2,
		});

		expect(migrateLegacyVoiceProviders(store)).toBe(true);
		expect(store.read().controls).toEqual({});
	});

	it('does nothing on a store it cannot write', () => {
		const store = {
			get: () => ({ providers: { stt: ECHO_STT_PROVIDER_ID, tts: 'mock-tts' } }),
		};

		expect(migrateLegacyVoiceProviders(store)).toBe(false);
	});

	it('moves a stored local Brain to the voice-routing assignment', () => {
		// The local Brain was never offered in a dropdown, but a settings file could
		// name it, and that file routed on Qwen3. It still does, through the one
		// place a local model is now chosen.
		const store = keyedStore({
			acappella: {
				providers: { stt: 'parakeet-local', brain: 'qwen3-local' },
				providersVersion: 3,
			},
		});

		expect(migrateLegacyVoiceProviders(store)).toBe(true);

		expect(store.read('acappella')).toEqual({
			providers: { stt: 'parakeet-local' },
			providersVersion: 5,
		});
		expect(store.read('localModelAssignments')).toEqual({
			'voice-routing': { type: 'local', modelId: 'qwen3-1.7b-instruct-q4km' },
		});
		expect(readVoiceProviderSettings(store).brain).toBe('qwen3-local');
	});

	it('keeps a voice-routing assignment that is already there', () => {
		const assigned = {
			'voice-routing': { type: 'endpoint', endpointId: 'ep-1', model: 'llama3.3' },
		};
		const store = keyedStore({
			acappella: { providers: { brain: 'qwen3-local' }, providersVersion: 3 },
			localModelAssignments: assigned,
		});

		expect(migrateLegacyVoiceProviders(store)).toBe(true);

		// The assignment is the newer decision; only the dead provider id goes.
		expect(store.read('localModelAssignments')).toEqual(assigned);
		expect(store.read('acappella')).toEqual({ providers: {}, providersVersion: 5 });
	});

	it('leaves a voice-specific Brain and the assignments alone', () => {
		const store = keyedStore({
			acappella: { providers: { brain: 'openai-brain' }, providersVersion: 3 },
		});

		expect(migrateLegacyVoiceProviders(store)).toBe(false);
		expect(store.read('acappella')).toEqual({
			providers: { brain: 'openai-brain' },
			providersVersion: 5,
		});
		expect(store.read('localModelAssignments')).toBeUndefined();
	});
});

/** A settings store that keeps each key apart, as the real one does. */
function keyedStore(initial: Record<string, unknown>) {
	const values: Record<string, unknown> = { ...initial };
	return {
		get: (key: string, defaultValue?: unknown) => values[key] ?? defaultValue,
		set: vi.fn((key: string, value: unknown) => {
			values[key] = value;
		}),
		read: (key: string) => values[key],
	};
}

describe('the Brain the voice-routing assignment selects', () => {
	const OLLAMA = {
		id: 'ep-1',
		name: 'Ollama',
		kind: 'ollama',
		baseUrl: 'http://127.0.0.1:11434',
		enabled: true,
	};
	const ENDPOINT_ASSIGNMENT = {
		'voice-routing': { type: 'endpoint', endpointId: 'ep-1', model: 'llama3.3' },
	};

	it('is the endpoint Brain for an endpoint assignment, over the stored choice', () => {
		const store = keyedStore({
			acappella: { providers: { brain: 'openai-brain' } },
			localModelAssignments: ENDPOINT_ASSIGNMENT,
			localModelEndpoints: [OLLAMA],
		});

		const settings = readVoiceProviderSettings(store);

		expect(settings.brain).toBe('endpoint-brain');
		expect(settings.brainSource).toEqual({
			assignment: { type: 'endpoint', endpointId: 'ep-1', model: 'llama3.3' },
			spec: 'endpoint:ep-1:llama3.3',
			label: 'llama3.3 on Ollama',
			endpointName: 'Ollama',
		});
	});

	it('is the local Brain for a local assignment', () => {
		const store = keyedStore({
			localModelAssignments: {
				'voice-routing': { type: 'local', modelId: 'qwen3-1.7b-instruct-q4km' },
			},
		});

		const settings = readVoiceProviderSettings(store);

		expect(settings.brain).toBe('qwen3-local');
		expect(settings.brainSource?.spec).toBe('local:qwen3-1.7b-instruct-q4km');
		expect(settings.brainSource?.endpointName).toBeUndefined();
	});

	it('is the stored voice-specific Brain while the assignment is off', () => {
		const store = keyedStore({
			acappella: { providers: { brain: 'anthropic-brain' } },
			localModelAssignments: { 'voice-routing': { type: 'off' }, 'tab-naming': { type: 'off' } },
		});

		const settings = readVoiceProviderSettings(store);

		expect(settings.brain).toBe('anthropic-brain');
		expect(settings.brainSource).toBeUndefined();
	});

	it('builds the assigned Brain with the source the assignment named', () => {
		const store = keyedStore({
			localModelAssignments: ENDPOINT_ASSIGNMENT,
			localModelEndpoints: [OLLAMA],
		});
		const settings = readVoiceProviderSettings(store);

		const resolution = resolveVoicePipeline({ settings });

		expect(resolution.resolvedIds.brain).toBe('endpoint-brain');
		expect(resolution.substitutions).toEqual([]);
		expect(resolution.providers.brain).toMatchObject({
			id: 'endpoint-brain',
			source: { spec: 'endpoint:ep-1:llama3.3' },
		});
		expect(resolution.brainEndpointName).toBe('Ollama');
	});

	it('names the endpoint in the privacy sentence, because the transcript goes to it', () => {
		const store = keyedStore({
			localModelAssignments: ENDPOINT_ASSIGNMENT,
			localModelEndpoints: [OLLAMA],
		});

		const state = buildProviderState(
			resolveVoicePipeline({ settings: readVoiceProviderSettings(store) })
		);

		expect(state.audioLeavesMachine).toBe(false);
		expect(state.egressStatement).toBe('Audio stays on this machine. Text is sent to Ollama.');
	});

	it('still says text leaves when the endpoint was removed', () => {
		const store = keyedStore({ localModelAssignments: ENDPOINT_ASSIGNMENT });

		const state = buildProviderState(
			resolveVoicePipeline({ settings: readVoiceProviderSettings(store) })
		);

		expect(state.egressStatement).toBe(
			'Audio stays on this machine. Text is sent to your model endpoint.'
		);
	});

	it('keys a different model on the same endpoint as a different pipeline', () => {
		const source = (model: string) => ({
			assignment: { type: 'endpoint' as const, endpointId: 'ep-1', model },
			spec: `endpoint:ep-1:${model}`,
			label: `${model} on Ollama`,
		});

		expect(pipelineKey({ brain: 'endpoint-brain', brainSource: source('llama3.3') })).not.toBe(
			pipelineKey({ brain: 'endpoint-brain', brainSource: source('qwen3:8b') })
		);
		expect(pipelineKey({ brain: 'endpoint-brain', brainSource: source('llama3.3') })).toBe(
			pipelineKey({ brain: 'endpoint-brain', brainSource: source('llama3.3') })
		);
	});
});

describe('the voice a spoken notice uses', () => {
	it('is the system voice when no voice was chosen', () => {
		expect(noticeTtsProviderId({})).toBe('system-tts');
	});

	it('is the chosen voice when that voice is local', () => {
		expect(noticeTtsProviderId({ tts: 'system-tts' })).toBe('system-tts');
		expect(noticeTtsProviderId({ tts: 'kokoro-local' })).toBe('kokoro-local');
	});

	it('is the system voice, never a hosted one, when the chosen voice is hosted', () => {
		// A notice fires unasked: its text must not go to a hosted service.
		expect(noticeTtsProviderId({ tts: 'openai-tts' })).toBe('system-tts');
		expect(noticeTtsProviderId({ tts: 'elevenlabs-tts' })).toBe('system-tts');
	});

	it('is the system voice when the chosen voice is the silent mock or unknown', () => {
		expect(noticeTtsProviderId({ tts: 'mock-tts' })).toBe('system-tts');
		expect(noticeTtsProviderId({ tts: 'no-such-voice' })).toBe('system-tts');
	});

	it('builds that provider', () => {
		expect(createNoticeTtsProvider({ tts: 'elevenlabs-tts' }).id).toBe('system-tts');
		expect(createNoticeTtsProvider({ tts: 'kokoro-local' }).id).toBe('kokoro-local');
	});
});
