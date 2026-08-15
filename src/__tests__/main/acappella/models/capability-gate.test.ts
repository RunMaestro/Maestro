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

import { describe, it, expect, vi } from 'vitest';

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
import type { ModelStatus } from '../../../../main/acappella/models/model-store';
import {
	VOICE_SLOT_UNSATISFIED_REASONS,
	readinessErrorMessage,
	type VoiceReadiness,
	type VoiceSlotReadiness,
	type VoiceSlotUnsatisfiedReason,
} from '../../../../shared/acappella/readiness';
import type { NativeRuntimeUnavailable } from '../../../../main/acappella/runtime/native-loader';
import {
	KOKORO_82M_ID,
	OPENWAKEWORD_BASE_ID,
	QWEN3_1_7B_ID,
	WHISPER_BASE_EN_ID,
} from '../../../../shared/acappella/model-catalog';

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
					[WHISPER_BASE_EN_ID]: 'not-installed',
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
				readModelStatus: statusReader({ [WHISPER_BASE_EN_ID]: 'not-installed' }),
			});

			const stt = readiness.slots.find((slot) => slot.slot === 'stt')!;
			expect(stt.satisfied).toBe(false);
			expect(stt.reason).toBe('model-not-installed');
			expect(stt.requiredModelId).toBe(WHISPER_BASE_EN_ID);
			expect(stt.detail).toContain('is not installed');
			expect(stt.suggestedAction).toContain('Download');
			expect(readiness.canStartSession).toBe(false);
		});

		it('reports model-corrupt with a re-verify action', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: ALL_LOCAL,
				readModelStatus: statusReader({ [KOKORO_82M_ID]: 'corrupt' }),
			});

			const tts = readiness.slots.find((slot) => slot.slot === 'tts')!;
			expect(tts.reason).toBe('model-corrupt');
			expect(tts.detail).toContain('failed verification');
			expect(tts.detail).toContain('hash mismatch');
			expect(tts.suggestedAction).toContain('Re-verify');
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
				// downloading 1.1 GB does not fix a binary that will not load.
				readModelStatus: statusReader({ [QWEN3_1_7B_ID]: 'not-installed' }),
				readRuntimeFailure: (runtimeId) =>
					runtimeId === 'llama'
						? {
								kind: 'runtime-unavailable',
								runtimeId: 'llama',
								moduleId: 'node-llama-cpp',
								platform: 'linux',
								arch: 'x64',
								failure: 'load-failed',
								message: 'llama.cpp failed to load on linux-x64.',
								suggestedAction: 'Run the voice self-test and include the result.',
							}
						: null,
			});

			const brain = readiness.slots.find((slot) => slot.slot === 'brain')!;
			expect(brain.reason).toBe('runtime-unavailable');
			expect(brain.detail).toContain('failed to load');
			expect(brain.suggestedAction).toContain('self-test');
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
									[WHISPER_BASE_EN_ID]: disk,
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
		const whisperRuntimeFailure: NativeRuntimeUnavailable = {
			kind: 'runtime-unavailable',
			runtimeId: 'whisper',
			moduleId: 'whisper-node',
			platform: 'darwin',
			arch: 'arm64',
			failure: 'load-failed',
			message: 'whisper.cpp could not be loaded on this machine.',
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
						readModelStatus: statusReader({ [WHISPER_BASE_EN_ID]: 'not-installed' }),
					}),
			],
			[
				'model-corrupt',
				() =>
					resolveVoiceReadiness({
						settings: ALL_LOCAL,
						readModelStatus: statusReader({ [KOKORO_82M_ID]: 'corrupt' }),
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
						readRuntimeFailure: (runtimeId) =>
							runtimeId === 'whisper' ? whisperRuntimeFailure : null,
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
					[WHISPER_BASE_EN_ID]: 'not-installed',
					[QWEN3_1_7B_ID]: 'corrupt',
				}),
			});

			const message = readinessErrorMessage(readiness);
			expect(message).toContain('Speech-to-Text');
			expect(message).toContain('Conductor Brain');
			expect(message).toContain('Download it in Settings');
			expect(message).toContain('Re-verify');
		});

		it('is empty when nothing is blocking', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: ALL_LOCAL,
				readModelStatus: statusReader(),
			});
			expect(readinessErrorMessage(readiness)).toBe('');
		});
	});
});
