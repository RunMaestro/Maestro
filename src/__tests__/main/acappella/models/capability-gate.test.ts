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
}));

import {
	LOCAL_PROVIDER_IDS,
	WAKE_WORD_PROVIDER_ID,
	resolveVoiceReadiness,
} from '../../../../main/acappella/models/capability-gate';
import type { ModelStatus } from '../../../../main/acappella/models/model-store';
import { readinessErrorMessage } from '../../../../shared/acappella/readiness';
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
			expect(readiness.slots.map((slot) => slot.slot)).toEqual([
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
				getApiKey: () => undefined,
			});

			const tts = readiness.slots.find((slot) => slot.slot === 'tts')!;
			expect(tts.reason).toBe('api-key-missing');
			expect(tts.detail).toContain('ElevenLabs');
			// The honest alternative is named, because it is often the real recovery.
			expect(tts.suggestedAction).toContain('local model');
		});

		it('treats a whitespace-only API key as missing', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: { ...ALL_LOCAL, brain: 'openai-realtime' },
				readModelStatus: statusReader(),
				getApiKey: () => '   ',
			});

			expect(readiness.slots.find((slot) => slot.slot === 'brain')?.reason).toBe('api-key-missing');
		});

		it('reports provider-unreachable when the probe says so', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: { ...ALL_LOCAL, brain: 'openai-realtime' },
				readModelStatus: statusReader(),
				getApiKey: () => 'sk-configured',
				probeProvider: () => false,
			});

			const brain = readiness.slots.find((slot) => slot.slot === 'brain')!;
			expect(brain.reason).toBe('provider-unreachable');
			expect(brain.detail).toContain('could not be reached');
		});

		it('assumes reachable when no probe is wired', async () => {
			const readiness = await resolveVoiceReadiness({
				settings: { ...ALL_LOCAL, brain: 'openai-realtime' },
				readModelStatus: statusReader(),
				getApiKey: () => 'sk-configured',
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
				getApiKey: () => 'sk-configured',
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
					for (const key of [undefined, 'sk-configured']) {
						for (const reachable of [true, false]) {
							const readiness = await resolveVoiceReadiness({
								settings: { ...ALL_LOCAL, stt },
								readModelStatus: statusReader({
									[WHISPER_BASE_EN_ID]: disk,
									[KOKORO_82M_ID]: disk,
									[QWEN3_1_7B_ID]: disk,
									[OPENWAKEWORD_BASE_ID]: disk,
								}),
								getApiKey: () => key,
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
