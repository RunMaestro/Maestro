/**
 * @file capability-gate.test.ts
 *
 * The gate has one job with two halves: say exactly why a slot is not ready, and
 * never, under any configuration, hand back a different provider than the one
 * that was asked for.
 *
 * The second half is the load-bearing one. Routing audio to a cloud API the user
 * did not pick is an unasked-for charge and a privacy break, so the last test in
 * this file walks every combination of provider selection and disk state and
 * asserts that no verdict ever names a provider other than the configured one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Which runtimes this "build" ships, flipped per test.
 *
 * The gate now asks the loader whether a runtime will load at all, and the real
 * registry has every one at `declared: false` until the providers land. Against
 * that, every test below would block on the runtime and never reach the provider
 * and model logic they exist to cover. Declared by default, so a test that cares
 * about the runtime dimension is the one that says so.
 */
// `vi.hoisted` because the mock factory runs during the import phase, before a
// plain `const` at this scope has been initialised.
const { declared } = vi.hoisted(() => ({
	declared: { llama: true, onnx: true } as Record<string, boolean>,
}));

vi.mock('../../../../shared/local-models/native-runtimes', () => {
	const descriptor = (id: string, moduleId: string, label: string) => ({
		id,
		moduleId,
		versionPin: '1.0.0',
		label,
		slots: [],
		get declared() {
			return declared[id];
		},
		requiresElectronRebuild: false,
		prebuilds: {
			'darwin-arm64': 'prebuilt',
			'darwin-x64': 'prebuilt',
			'win32-x64': 'prebuilt',
			'linux-x64': 'prebuilt',
		},
		asarUnpack: [],
		packagedBinaries: {
			'darwin-arm64': [],
			'darwin-x64': [],
			'win32-x64': [],
			'linux-x64': [],
		},
		rationale: '',
		notes: '',
	});

	const runtimes = [
		descriptor('llama', 'fake-llama', 'Fake llama'),
		descriptor('onnx', 'fake-onnx', 'Fake onnx'),
	];

	return {
		NATIVE_RUNTIMES: runtimes,
		getNativeRuntime: (id: string) => runtimes.find((runtime) => runtime.id === id),
		nativePlatformKey: (platform: string, arch: string) => {
			const key = `${platform}-${arch}`;
			return ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'].includes(key) ? key : null;
		},
	};
});

// The system voice is present on macOS and Windows and needs `espeak-ng` on
// Linux. Mocked as present so the CI runner's package list does not decide
// whether "every local model is installed" counts as ready; the missing-engine
// verdict has its own test through `readSystemVoiceFailure`.
// The runtime store reads the REAL user data dir (through MAESTRO_USER_DATA when
// an agent shell sets it), and the gate now consults it for a downloaded
// runtime before it trusts the registry. Nothing is downloaded in these tests;
// a machine that happens to have the runtime installed must not decide them.
vi.mock('../../../../main/local-models/runtime/runtime-store', () => ({
	installedRuntimeEntry: vi.fn(async () => null),
}));

vi.mock('../../../../main/acappella/providers/local/system-tts', () => ({
	systemVoiceUnavailability: async () => null,
}));

// The Local Models assignments, as the settings store holds them. Read only by
// the core task readiness resolver, when a Brain is one the `voice-routing`
// assignment selects. Empty unless a test fills it.
const storedSettings = vi.hoisted(() => ({ localModelAssignments: {} as Record<string, unknown> }));
vi.mock('../../../../main/stores/getters', () => ({
	getSettingsStore: () => ({
		get: (key: string, defaultValue: unknown) =>
			key === 'localModelAssignments' ? storedSettings.localModelAssignments : defaultValue,
	}),
}));

vi.mock('electron', () => ({
	app: { getPath: () => '/tmp/acappella-capability-gate-test' },
	shell: { openExternal: vi.fn() },
	// The gate reads the microphone permission, which is a pure query and never
	// prompts. Granted here so these tests stay about providers and models; the
	// permission's own behaviour is covered in mic-permission.test.ts.
	systemPreferences: {
		getMediaAccessStatus: () => 'granted',
		askForMediaAccess: vi.fn(),
	},
}));

import {
	LOCAL_PROVIDER_IDS,
	WAKE_WORD_PROVIDER_ID,
	resolveVoiceReadiness,
} from '../../../../main/acappella/models/capability-gate';
import type { ModelStatus } from '../../../../main/local-models/model-store';
import {
	VOICE_SLOT_UNSATISFIED_REASONS,
	readinessErrorMessage,
	type VoiceReadiness,
	type VoiceSlot,
	type VoiceSlotReadiness,
	type VoiceSlotUnsatisfiedReason,
} from '../../../../shared/acappella/readiness';
import type { NativeRuntimeUnavailable } from '../../../../main/local-models/runtime/native-loader';
import type { LocalModelTaskReadiness } from '../../../../shared/local-models/task-readiness';
import {
	HEY_JARVIS_WAKE_ID,
	KOKORO_82M_ID,
	OPENWAKEWORD_BASE_ID,
	QWEN3_1_7B_ID,
	PARAKEET_TDT_V2_ID,
} from '../../../../shared/local-models/model-catalog';

type StatusKind = ModelStatus['status'];

/** A fake store: every model reports whatever the map says, installed by default. */
function statusReader(overrides: Record<string, StatusKind> = {}) {
	return async (modelId: string): Promise<ModelStatus> => {
		const status = overrides[modelId] ?? 'installed';
		return {
			id: modelId,
			status,
			manifest: null,
			detail: status === 'corrupt' ? 'hash mismatch' : undefined,
			bytesOnDisk: status === 'not-installed' ? 0 : 1024,
		};
	};
}

const ALL_LOCAL = {
	stt: LOCAL_PROVIDER_IDS.stt,
	tts: LOCAL_PROVIDER_IDS.tts,
	brain: LOCAL_PROVIDER_IDS.brain,
};

describe('capability-gate', () => {
	describe('satisfied slots', () => {
		it('is ready when every local model is installed', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: ALL_LOCAL,
				readModelStatus: statusReader(),
			});

			expect(readiness.canStartSession).toBe(true);
			expect(readiness.canRunHandsFree).toBe(true);
			expect(readiness.blocking).toHaveLength(0);
			// The microphone leads: it is the one requirement that holds regardless of
			// which providers are configured, and a user who reads "microphone access
			// denied" first does not need to read the rest.
			expect(readiness.slots.map((slot) => slot.slot)).toEqual([
				'microphone',
				'stt',
				'tts',
				'brain',
				'wake-word',
			]);
		});

		it('treats the mock tier as satisfied, since it needs nothing', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: { stt: 'mock-stt', tts: 'mock-tts', brain: 'mock-brain' },
				readModelStatus: statusReader({
					[PARAKEET_TDT_V2_ID]: 'not-installed',
					[KOKORO_82M_ID]: 'not-installed',
					[QWEN3_1_7B_ID]: 'not-installed',
				}),
			});

			expect(readiness.canStartSession).toBe(true);
		});
	});

	describe('every unsatisfied reason', () => {
		it('reports model-not-installed with a download action', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: ALL_LOCAL,
				readModelStatus: statusReader({ [PARAKEET_TDT_V2_ID]: 'not-installed' }),
			});

			const stt = readiness.slots.find((slot) => slot.slot === 'stt')!;
			expect(stt.satisfied).toBe(false);
			expect(stt.reason).toBe('model-not-installed');
			expect(stt.requiredModelId).toBe(PARAKEET_TDT_V2_ID);
			expect(stt.detail).toContain('is not installed');
			expect(stt.suggestedAction).toBe('Download it in Settings > Models > Library > Speech.');
			expect(readiness.canStartSession).toBe(false);
		});

		it('reports model-corrupt with a re-verify action', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: ALL_LOCAL,
				readModelStatus: statusReader({ [PARAKEET_TDT_V2_ID]: 'corrupt' }),
			});

			const stt = readiness.slots.find((slot) => slot.slot === 'stt')!;
			expect(stt.reason).toBe('model-corrupt');
			expect(stt.detail).toContain('failed verification');
			expect(stt.detail).toContain('hash mismatch');
			expect(stt.suggestedAction).toBe(
				'Re-verify or re-download it in Settings > Models > Library > Speech.'
			);
		});

		it('reports the system voice as unavailable when the machine has no speech engine', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: ALL_LOCAL,
				readModelStatus: statusReader(),
				readSystemVoiceFailure: async () => ({
					message: 'No system speech engine is installed (espeak-ng).',
					suggestedAction: 'Install espeak-ng, or switch Text-to-Speech to a hosted voice.',
				}),
			});

			const tts = readiness.slots.find((slot) => slot.slot === 'tts')!;
			expect(tts.satisfied).toBe(false);
			expect(tts.reason).toBe('runtime-unavailable');
			expect(tts.detail).toContain('Text-to-Speech');
			expect(tts.detail).toContain('espeak-ng');
			expect(tts.suggestedAction).toContain('hosted voice');
			expect(readiness.canStartSession).toBe(false);
		});

		it('reports api-key-missing for a cloud provider with no key', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: { ...ALL_LOCAL, tts: 'elevenlabs-tts' },
				readModelStatus: statusReader(),
				hasApiKey: () => false,
			});

			const tts = readiness.slots.find((slot) => slot.slot === 'tts')!;
			expect(tts.reason).toBe('api-key-missing');
			expect(tts.detail).toContain('ElevenLabs');
			// The honest alternative is named, because it is often the real recovery.
			expect(tts.suggestedAction).toContain('local model');
		});

		it('treats an absent stored key as missing', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: { ...ALL_LOCAL, brain: 'openai-realtime' },
				readModelStatus: statusReader(),
				hasApiKey: () => false,
			});

			expect(readiness.slots.find((slot) => slot.slot === 'brain')?.reason).toBe('api-key-missing');
		});

		it('reports provider-unreachable when the probe says so', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: { ...ALL_LOCAL, brain: 'openai-realtime' },
				readModelStatus: statusReader(),
				hasApiKey: () => true,
				probeProvider: () => false,
			});

			const brain = readiness.slots.find((slot) => slot.slot === 'brain')!;
			expect(brain.reason).toBe('provider-unreachable');
			expect(brain.detail).toContain('could not be reached');
		});

		it('reports runtime-unavailable, and reports it INSTEAD of a download', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: ALL_LOCAL,
				// Model missing AND runtime broken: the runtime wins, because
				// downloading 200 MB does not fix a binary that will not load.
				readModelStatus: statusReader({ [PARAKEET_TDT_V2_ID]: 'not-installed' }),
				readRuntimeFailure: (runtimeId) =>
					runtimeId === 'onnx'
						? {
								kind: 'runtime-unavailable',
								runtimeId: 'onnx',
								moduleId: 'onnxruntime-node',
								platform: 'linux',
								arch: 'x64',
								failure: 'load-failed',
								message: 'ONNX Runtime failed to load on linux-x64.',
								suggestedAction: 'Run the voice self-test and include the result.',
							}
						: null,
			});

			const stt = readiness.slots.find((slot) => slot.slot === 'stt')!;
			expect(stt.reason).toBe('runtime-unavailable');
			expect(stt.detail).toContain('failed to load');
			expect(stt.requiredModelId).toBe(PARAKEET_TDT_V2_ID);
			expect(stt.suggestedAction).toContain('self-test');
			expect(readiness.canStartSession).toBe(false);
		});

		it('leaves a slot alone when its runtime has never failed', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: ALL_LOCAL,
				readModelStatus: statusReader(),
				readRuntimeFailure: () => null,
			});

			expect(readiness.canStartSession).toBe(true);
		});

		it('blocks a runtime that is not in this build, before anything tries to load it', async () => {
			// The default reader, deliberately: a gate that only knows about loads
			// that have already been attempted says "ready" on a fresh boot for a
			// runtime the build does not contain, and the user finds out when the
			// session dies. Every model is on disk here; the runtime still decides.
			declared.onnx = false;
			try {
				const readiness = await resolveVoiceReadiness({
					settings: ALL_LOCAL,
					readModelStatus: statusReader(),
				});

				const stt = readiness.slots.find((slot) => slot.slot === 'stt')!;
				expect(stt.satisfied).toBe(false);
				expect(stt.reason).toBe('runtime-unavailable');
				// A runtime the app can fetch is "not downloaded yet", and the recovery
				// is the same Download button that fetches the models; one it cannot
				// fetch is "not part of this build". Either way it is blocked here,
				// before a load is attempted.
				expect(stt.detail).toMatch(/not downloaded yet|not part of this build/);
				expect(readiness.canStartSession).toBe(false);
			} finally {
				declared.onnx = true;
			}
		});

		it('assumes reachable when no probe is wired', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: { ...ALL_LOCAL, brain: 'openai-realtime' },
				readModelStatus: statusReader(),
				hasApiKey: () => true,
			});

			expect(readiness.canStartSession).toBe(true);
		});
	});

	describe('the wake word', () => {
		it('blocks hands-free but not a click-to-talk session', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: ALL_LOCAL,
				readModelStatus: statusReader({ [OPENWAKEWORD_BASE_ID]: 'not-installed' }),
			});

			expect(readiness.canStartSession).toBe(true);
			expect(readiness.canRunHandsFree).toBe(false);
			expect(readiness.blocking).toHaveLength(0);
			const wake = readiness.slots.find((slot) => slot.slot === 'wake-word')!;
			expect(wake.satisfied).toBe(false);
			expect(wake.providerId).toBe(WAKE_WORD_PROVIDER_ID);
		});

		it('refuses hands-free when the phrase has no trained detector, even with the model installed', async () => {
			// The front end alone scores nothing. Reporting the slot satisfied here is
			// how a Test button listened forever and never lit up.
			const readiness = await resolveVoiceReadiness({
				settings: { ...ALL_LOCAL, wakePhrase: 'hey maestro' },
				readModelStatus: statusReader(),
			});

			expect(readiness.canStartSession).toBe(true);
			expect(readiness.canRunHandsFree).toBe(false);
			const wake = readiness.slots.find((slot) => slot.slot === 'wake-word')!;
			expect(wake.reason).toBe('wake-phrase-untrained');
			expect(wake.detail).toContain('hey maestro');
			expect(wake.suggestedAction).toContain('hey jarvis');
			// And the way out that needs nobody else's model.
			expect(wake.suggestedAction).toMatch(/Train it from your own voice/);
		});

		it('allows hands-free on a phrase the user trained from their own recordings', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: { ...ALL_LOCAL, wakePhrase: 'hey maestro' },
				readModelStatus: statusReader(),
				hasEnrolledWakePhrase: (phrase) => phrase === 'hey maestro',
			});

			expect(readiness.canRunHandsFree).toBe(true);
			expect(readiness.slots.find((slot) => slot.slot === 'wake-word')!.satisfied).toBe(true);
		});

		it('needs no pretrained detector for a phrase the user trained, even the default one', async () => {
			// The user's own recordings outrank the pretrained classifier, so its
			// absence is not something to ask them to download.
			const readiness = await resolveVoiceReadiness({
				settings: ALL_LOCAL,
				readModelStatus: statusReader({ [HEY_JARVIS_WAKE_ID]: 'not-installed' }),
				hasEnrolledWakePhrase: () => true,
			});

			expect(readiness.canRunHandsFree).toBe(true);
		});

		it('still needs the front end for a phrase the user trained', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: { ...ALL_LOCAL, wakePhrase: 'hey maestro' },
				readModelStatus: statusReader({ [OPENWAKEWORD_BASE_ID]: 'not-installed' }),
				hasEnrolledWakePhrase: () => true,
			});

			expect(readiness.canRunHandsFree).toBe(false);
		});

		it("asks for the default phrase's detector when only the front end is installed", async () => {
			const readiness = await resolveVoiceReadiness({
				settings: ALL_LOCAL,
				readModelStatus: statusReader({ [HEY_JARVIS_WAKE_ID]: 'not-installed' }),
			});

			const wake = readiness.slots.find((slot) => slot.slot === 'wake-word')!;
			expect(wake.reason).toBe('model-not-installed');
			// A download fixes this one, so the panel can offer the button.
			expect(wake.requiredModelId).toBe(HEY_JARVIS_WAKE_ID);
		});

		it('is satisfied by the default phrase once its detector is installed', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: ALL_LOCAL,
				readModelStatus: statusReader(),
			});

			expect(readiness.canRunHandsFree).toBe(true);
		});

		it('is always local: no setting can point it at a cloud provider', async () => {
			const readiness = await resolveVoiceReadiness({
				// Deliberately hostile settings: nothing here may reach the wake word.
				settings: { stt: 'openai-realtime', tts: 'elevenlabs-tts', brain: 'openai-realtime' },
				readModelStatus: statusReader(),
				hasApiKey: () => true,
			});

			expect(readiness.slots.find((slot) => slot.slot === 'wake-word')?.providerId).toBe(
				WAKE_WORD_PROVIDER_ID
			);
		});
	});

	describe('no implicit provider substitution', () => {
		const providerChoices = [
			LOCAL_PROVIDER_IDS.stt,
			'openai-realtime',
			'mock-stt',
			'not-a-registered-provider',
		];
		const diskStates: StatusKind[] = ['installed', 'not-installed', 'corrupt'];

		it('never names a provider other than the one configured', async () => {
			for (const stt of providerChoices) {
				for (const disk of diskStates) {
					for (const key of [false, true]) {
						for (const reachable of [true, false]) {
							const readiness = await resolveVoiceReadiness({
								settings: { ...ALL_LOCAL, stt },
								readModelStatus: statusReader({
									[PARAKEET_TDT_V2_ID]: disk,
									[KOKORO_82M_ID]: disk,
									[QWEN3_1_7B_ID]: disk,
									[OPENWAKEWORD_BASE_ID]: disk,
								}),
								hasApiKey: () => key,
								probeProvider: () => reachable,
							});

							const sttSlot = readiness.slots.find((slot) => slot.slot === 'stt')!;
							// The verdict reports what was ASKED for. If the gate ever
							// "helpfully" resolved to a working provider, this is where it
							// would show up.
							expect(sttSlot.providerId).toBe(stt);

							// And an unsatisfied slot is never quietly satisfied by another.
							if (!sttSlot.satisfied) {
								expect(readiness.canStartSession).toBe(false);
								expect(readiness.blocking.map((slot) => slot.slot)).toContain('stt');
							}
						}
					}
				}
			}
		});

		it('leaves an unknown provider satisfied only because it demands nothing', async () => {
			// An id the gate has never heard of has no requirement to check, so it
			// cannot be reported as blocked here. It is the registry, not the gate,
			// that refuses to run it - and the registry's only fallback is the mock.
			const readiness = await resolveVoiceReadiness({
				settings: { ...ALL_LOCAL, brain: 'not-a-registered-provider' },
				readModelStatus: statusReader(),
			});

			const brain = readiness.slots.find((slot) => slot.slot === 'brain')!;
			expect(brain.providerId).toBe('not-a-registered-provider');
			expect(brain.satisfied).toBe(true);
		});
	});

	describe('a Brain the voice-routing assignment selects', () => {
		const LOCAL_BRAIN = { ...ALL_LOCAL, brain: 'qwen3-local' };
		const ENDPOINT_BRAIN = { ...ALL_LOCAL, brain: 'endpoint-brain' };

		beforeEach(() => {
			storedSettings.localModelAssignments = {};
		});

		/** A task readiness verdict, as the core resolver would answer it. */
		function taskReadiness(
			verdict: Partial<LocalModelTaskReadiness> & Pick<LocalModelTaskReadiness, 'state'>
		) {
			return async (): Promise<LocalModelTaskReadiness> => ({
				taskId: 'voice-routing',
				label: 'Voice routing',
				needs: 'text-gen',
				assignment: { type: 'local', modelId: QWEN3_1_7B_ID },
				detail: 'Runs Qwen3 1.7B Instruct (Q4_K_M) on this machine.',
				...verdict,
			});
		}

		it('is ready when the assigned source is, and names the model it runs', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: LOCAL_BRAIN,
				readModelStatus: statusReader(),
				readTaskReadiness: taskReadiness({ state: 'ready' }),
			});

			const brain = readiness.slots.find((slot) => slot.slot === 'brain')!;
			expect(brain).toMatchObject({
				providerId: 'qwen3-local',
				satisfied: true,
				requiredModelId: QWEN3_1_7B_ID,
			});
			expect(readiness.canStartSession).toBe(true);
		});

		it('offers the download for an assigned model that is not on disk', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: LOCAL_BRAIN,
				readModelStatus: statusReader(),
				readTaskReadiness: taskReadiness({
					state: 'unavailable',
					reason: 'model-not-installed',
					detail: 'Qwen3 1.7B Instruct (Q4_K_M) is not downloaded.',
					suggestedAction: 'Download it in Settings > Local Models.',
				}),
			});

			const brain = readiness.slots.find((slot) => slot.slot === 'brain')!;
			expect(brain).toMatchObject({
				satisfied: false,
				reason: 'model-not-installed',
				requiredModelId: QWEN3_1_7B_ID,
				detail: 'Conductor Brain: Qwen3 1.7B Instruct (Q4_K_M) is not downloaded.',
				suggestedAction: 'Download it in Settings > Local Models.',
			});
			expect(readiness.canStartSession).toBe(false);
		});

		it('identifies the assigned model so recovery can inspect its runtime', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: LOCAL_BRAIN,
				readModelStatus: statusReader(),
				readTaskReadiness: taskReadiness({
					state: 'unavailable',
					reason: 'runtime-unavailable',
					detail: 'llama.cpp is not downloaded.',
					suggestedAction: 'Download it.',
				}),
			});

			const brain = readiness.slots.find((slot) => slot.slot === 'brain')!;
			expect(brain.reason).toBe('runtime-unavailable');
			expect(brain.requiredModelId).toBe(QWEN3_1_7B_ID);
		});

		it.each([
			['endpoint-key-missing', 'api-key-missing'],
			['endpoint-unreachable', 'provider-unreachable'],
			['endpoint-disabled', 'provider-unreachable'],
			['endpoint-model-missing', 'provider-unreachable'],
			['model-unknown', 'provider-unreachable'],
		] as const)('reports an assigned source that is %s as %s', async (taskReason, slotReason) => {
			const readiness = await resolveVoiceReadiness({
				settings: ENDPOINT_BRAIN,
				readModelStatus: statusReader(),
				readTaskReadiness: taskReadiness({
					state: 'unavailable',
					reason: taskReason,
					assignment: { type: 'endpoint', endpointId: 'ep-1', model: 'llama3.3' },
					detail: 'Ollama is not answering.',
					suggestedAction: 'Start Ollama.',
				}),
			});

			const brain = readiness.slots.find((slot) => slot.slot === 'brain')!;
			expect(brain).toMatchObject({
				providerId: 'endpoint-brain',
				satisfied: false,
				reason: slotReason,
				detail: 'Conductor Brain: Ollama is not answering.',
				suggestedAction: 'Start Ollama.',
			});
			// The fix is on the server, so there is no model to download here.
			expect(brain.requiredModelId).toBeUndefined();
		});

		it('refuses by name when the slot holds an assigned Brain and nothing is assigned', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: LOCAL_BRAIN,
				readModelStatus: statusReader(),
				readTaskReadiness: taskReadiness({
					state: 'off',
					assignment: { type: 'off' },
					detail: 'Voice routing is off.',
				}),
			});

			const brain = readiness.slots.find((slot) => slot.slot === 'brain')!;
			expect(brain).toMatchObject({
				satisfied: false,
				reason: 'provider-unreachable',
				detail: 'Conductor Brain: Voice routing has no model assigned.',
			});
			expect(brain.suggestedAction).toContain('Settings > Models > System One');
			expect(readiness.canStartSession).toBe(false);
		});

		it("asks the core resolver with this gate's own model and runtime readers by default", async () => {
			// No `readTaskReadiness`: the real resolver runs against the settings
			// store, and must describe the same machine the rest of the gate does.
			storedSettings.localModelAssignments = {
				'voice-routing': { type: 'local', modelId: QWEN3_1_7B_ID },
			};

			const missing = await resolveVoiceReadiness({
				settings: LOCAL_BRAIN,
				readModelStatus: statusReader({ [QWEN3_1_7B_ID]: 'not-installed' }),
				readRuntimeFailure: () => null,
			});
			expect(missing.slots.find((slot) => slot.slot === 'brain')).toMatchObject({
				satisfied: false,
				reason: 'model-not-installed',
				requiredModelId: QWEN3_1_7B_ID,
			});

			const runtimeDown = await resolveVoiceReadiness({
				settings: LOCAL_BRAIN,
				readModelStatus: statusReader(),
				readRuntimeFailure: (runtimeId) =>
					runtimeId === 'llama'
						? ({
								runtimeId: 'llama',
								message: 'llama.cpp is not downloaded.',
								suggestedAction: 'Download it.',
							} as NativeRuntimeUnavailable)
						: null,
			});
			expect(runtimeDown.slots.find((slot) => slot.slot === 'brain')).toMatchObject({
				satisfied: false,
				reason: 'runtime-unavailable',
				detail: 'Conductor Brain: llama.cpp is not downloaded.',
			});

			const ready = await resolveVoiceReadiness({
				settings: LOCAL_BRAIN,
				readModelStatus: statusReader(),
				readRuntimeFailure: () => null,
			});
			expect(ready.slots.find((slot) => slot.slot === 'brain')).toMatchObject({
				satisfied: true,
				requiredModelId: QWEN3_1_7B_ID,
			});
		});

		it('is unsatisfied, by name, when nothing is assigned in the settings store', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: LOCAL_BRAIN,
				readModelStatus: statusReader(),
			});

			expect(readiness.slots.find((slot) => slot.slot === 'brain')).toMatchObject({
				satisfied: false,
				detail: 'Conductor Brain: Voice routing has no model assigned.',
			});
		});
	});

	describe('the microphone slot', () => {
		it('reports mic-permission-denied as a permission, with the privacy pane as the fix', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: ALL_LOCAL,
				readModelStatus: statusReader(),
				readMicPermission: () => 'denied',
			});

			const mic = readiness.slots.find((slot) => slot.slot === 'microphone')!;
			expect(mic.satisfied).toBe(false);
			expect(mic.reason).toBe('mic-permission-denied');
			// Named as a permission, never as "voice unavailable": a user with every
			// model on disk and a denied microphone has a one-checkbox problem.
			expect(mic.detail).toMatch(/microphone access/i);
			expect(mic.suggestedAction).toMatch(/privacy settings/i);
			expect(readiness.canStartSession).toBe(false);
		});

		it('reports mic-permission-restricted without sending the user to a checkbox they cannot tick', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: ALL_LOCAL,
				readModelStatus: statusReader(),
				readMicPermission: () => 'restricted',
			});

			const mic = readiness.slots.find((slot) => slot.slot === 'microphone')!;
			expect(mic.reason).toBe('mic-permission-restricted');
			expect(mic.suggestedAction).toMatch(/manages this machine/i);
			expect(mic.suggestedAction).not.toMatch(/privacy settings/i);
		});

		it.each(['granted', 'not-determined', 'unknown'] as const)(
			'does not block on %s, which is a machine that has not been asked yet',
			async (permission) => {
				const readiness = await resolveVoiceReadiness({
					settings: ALL_LOCAL,
					readModelStatus: statusReader(),
					readMicPermission: () => permission,
				});

				const mic = readiness.slots.find((slot) => slot.slot === 'microphone')!;
				expect(mic.satisfied).toBe(true);
				// Reported even when satisfied, so Voice Setup can say "you will be asked
				// when you start" instead of describing it as a problem.
				expect(mic.micPermission).toBe(permission);
			}
		);
	});

	describe('no unsatisfied slot is a dead end', () => {
		/** A runtime that has already failed to load in this process. */
		const onnxRuntimeFailure: NativeRuntimeUnavailable = {
			kind: 'runtime-unavailable',
			runtimeId: 'onnx',
			moduleId: 'onnxruntime-node',
			platform: 'darwin',
			arch: 'arm64',
			failure: 'load-failed',
			message: 'ONNX Runtime could not be loaded on this machine.',
			suggestedAction: 'Reinstall Maestro, or switch Speech-to-Text to a hosted provider.',
			detail: 'dlopen failed',
		};

		/**
		 * Every reason in the union, each produced by a real configuration.
		 *
		 * "Voice mode unavailable" with no reason is indistinguishable from a bug,
		 * so the gate's contract is that an unsatisfied slot ALWAYS carries a
		 * sentence naming the missing piece and a sentence saying what to do. A new
		 * reason added without either would otherwise reach a user as a disabled
		 * button with nothing next to it.
		 */
		const CASES: Array<[VoiceSlotUnsatisfiedReason, () => Promise<VoiceReadiness>]> = [
			[
				'model-not-installed',
				() =>
					resolveVoiceReadiness({
						settings: ALL_LOCAL,
						readModelStatus: statusReader({ [PARAKEET_TDT_V2_ID]: 'not-installed' }),
					}),
			],
			[
				'model-corrupt',
				() =>
					resolveVoiceReadiness({
						settings: ALL_LOCAL,
						readModelStatus: statusReader({ [PARAKEET_TDT_V2_ID]: 'corrupt' }),
					}),
			],
			[
				'api-key-missing',
				() =>
					resolveVoiceReadiness({
						settings: { ...ALL_LOCAL, stt: 'openai-stt' },
						readModelStatus: statusReader(),
						hasApiKey: () => false,
					}),
			],
			[
				'provider-unreachable',
				() =>
					resolveVoiceReadiness({
						settings: { ...ALL_LOCAL, stt: 'openai-stt' },
						readModelStatus: statusReader(),
						hasApiKey: () => true,
						probeProvider: () => false,
					}),
			],
			[
				'runtime-unavailable',
				() =>
					resolveVoiceReadiness({
						settings: ALL_LOCAL,
						readModelStatus: statusReader(),
						readRuntimeFailure: (runtimeId) => (runtimeId === 'onnx' ? onnxRuntimeFailure : null),
					}),
			],
			[
				'mic-permission-denied',
				() =>
					resolveVoiceReadiness({
						settings: ALL_LOCAL,
						readModelStatus: statusReader(),
						readMicPermission: () => 'denied',
					}),
			],
			[
				'wake-phrase-untrained',
				() =>
					resolveVoiceReadiness({
						settings: { ...ALL_LOCAL, wakePhrase: 'hey maestro' },
						readModelStatus: statusReader(),
					}),
			],
			[
				'mic-permission-restricted',
				() =>
					resolveVoiceReadiness({
						settings: ALL_LOCAL,
						readModelStatus: statusReader(),
						readMicPermission: () => 'restricted',
					}),
			],
		];

		it('covers every reason in the union, so a new one cannot be added silently', () => {
			expect(CASES.map(([reason]) => reason).sort()).toEqual(
				[...VOICE_SLOT_UNSATISFIED_REASONS].sort()
			);
		});

		it.each(CASES)('%s carries a detail and a recovery', async (reason, resolve) => {
			const readiness = await resolve();
			const slot = readiness.slots.find((entry: VoiceSlotReadiness) => entry.reason === reason);

			expect(slot, `no slot reported ${reason}`).toBeDefined();
			expect(slot!.satisfied).toBe(false);
			expect(slot!.detail).toEqual(expect.any(String));
			expect(slot!.detail!.length).toBeGreaterThan(0);
			expect(slot!.suggestedAction).toEqual(expect.any(String));
			expect(slot!.suggestedAction!.length).toBeGreaterThan(0);
			// The recovery has to be a different sentence from the diagnosis, or it is
			// not a recovery.
			expect(slot!.suggestedAction).not.toBe(slot!.detail);
		});
	});

	describe('readinessErrorMessage', () => {
		it('names every blocking slot and its recovery', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: ALL_LOCAL,
				readModelStatus: statusReader({
					[PARAKEET_TDT_V2_ID]: 'not-installed',
					[OPENWAKEWORD_BASE_ID]: 'corrupt',
				}),
				handsFreeEnabled: true,
				readSystemVoiceFailure: async () => ({
					message: 'No system speech engine is installed (espeak-ng).',
					suggestedAction: 'Install espeak-ng, or switch Text-to-Speech to a hosted voice.',
				}),
			});

			const message = readinessErrorMessage(readiness);
			expect(message).toContain('Speech-to-Text');
			expect(message).toContain('Text-to-Speech');
			expect(message).toContain('Download it in Settings');
			expect(message).toContain('espeak-ng');
		});

		it('is empty when nothing is blocking', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: ALL_LOCAL,
				readModelStatus: statusReader(),
			});
			expect(readinessErrorMessage(readiness)).toBe('');
		});

		it('states one shared recovery once, not once per slot', () => {
			// The real shape of a build without the native runtimes: three slots fail
			// together with the same fix. Repeating it three times was two thirds of
			// the message and read as a wall rather than as an instruction.
			const action = 'Use a hosted provider or the mock tier until the local runtime ships.';
			const message = readinessErrorMessage(
				blockedOn(
					(
						[
							{ slot: 'stt', detail: 'Speech-to-Text: whisper.cpp is not part of this build yet.' },
							{
								slot: 'tts',
								detail: 'Text-to-Speech: ONNX Runtime is not part of this build yet.',
							},
							{
								slot: 'brain',
								detail: 'Conductor Brain: llama.cpp is not part of this build yet.',
							},
						] as const
					).map((slot) => ({ ...slot, suggestedAction: action }))
				)
			);

			expect(message.split(action)).toHaveLength(2); // stated exactly once
			expect(message).toContain('whisper.cpp');
			expect(message).toContain('ONNX Runtime');
			expect(message).toContain('llama.cpp');
			expect(message.endsWith(action)).toBe(true);
		});

		it('keeps recoveries per slot when they differ', () => {
			// A denied microphone and a missing model are two problems with two
			// different next steps; collapsing them would drop one of the fixes.
			const message = readinessErrorMessage(
				blockedOn([
					{
						slot: 'microphone',
						detail: 'Microphone: Maestro does not have microphone access.',
						suggestedAction: 'Grant microphone access in your system privacy settings.',
					},
					{
						slot: 'stt',
						detail: 'Speech-to-Text: Whisper Base is not installed.',
						suggestedAction: 'Download it in Settings.',
					},
				])
			);

			expect(message).toContain('Grant microphone access');
			expect(message).toContain('Download it in Settings');
		});

		it('does not lend one slot recovery to a slot that has none', () => {
			const action = 'Download it in Settings.';
			const message = readinessErrorMessage(
				blockedOn([
					{
						slot: 'stt',
						detail: 'Speech-to-Text: Whisper Base is not installed.',
						suggestedAction: action,
					},
					{ slot: 'tts', detail: 'Text-to-Speech: something went wrong.' },
				])
			);

			// Hoisting here would read as though the second slot were fixed by the
			// first one's action. It stays attached to the slot that stated it.
			expect(message).toBe(
				`Speech-to-Text: Whisper Base is not installed. ${action} Text-to-Speech: something went wrong.`
			);
		});
	});
});

/** A readiness verdict blocked on exactly these slots. */
function blockedOn(
	blocking: Array<Partial<VoiceSlotReadiness> & { slot: VoiceSlot }>
): VoiceReadiness {
	const slots = blocking.map((slot) => ({
		providerId: 'test-provider',
		satisfied: false as const,
		...slot,
	})) as VoiceSlotReadiness[];
	return { canStartSession: false, canRunHandsFree: false, slots, blocking: slots };
}
