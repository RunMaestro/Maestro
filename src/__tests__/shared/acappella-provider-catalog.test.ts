/**
 * @file acappella-provider-catalog.test.ts
 *
 * The catalog is the one table four subsystems read: the capability gate, the
 * provider registry, the credential layer, and the settings panel. Two things
 * have to stay true of it, and both are easy to break in a change that looks
 * unrelated:
 *
 *   1. Every provider declares what it needs and what it sends. A provider with
 *      no `egress` declared would silently be summarised as private.
 *   2. The privacy statement is DERIVED. Nobody writes "audio stays on this
 *      machine" as copy anywhere, because copy cannot be kept in step with a
 *      selection the user changes at runtime.
 */

import { describe, it, expect } from 'vitest';

import {
	ASSIGNED_BRAIN_PROVIDERS,
	ELEVENLABS_TTS_PROVIDER_ID,
	ENDPOINT_BRAIN_PROVIDER_ID,
	HOSTED_PROVIDER_IDS,
	LOCAL_PROVIDER_IDS,
	OPENAI_REALTIME_PROVIDER_ID,
	QWEN3_BRAIN_PROVIDER_ID,
	VOICE_CREDENTIALS,
	VOICE_CREDENTIAL_SERVICES,
	VOICE_PROVIDER_CATALOG,
	getVoiceProvider,
	summariseVoiceEgress,
	voiceProviderCredential,
	voiceProviderRequirement,
	voiceProvidersForRole,
	isNativeRuntimeUsedByVoice,
} from '../../shared/acappella/provider-catalog';

describe('the provider catalog', () => {
	it('has a unique id per provider', () => {
		const ids = VOICE_PROVIDER_CATALOG.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('offers at least one provider for every slot', () => {
		for (const role of ['stt', 'tts', 'brain', 'realtime'] as const) {
			expect(voiceProvidersForRole(role).length).toBeGreaterThan(0);
		}
	});

	it('names a real credential for every provider that needs one', () => {
		for (const entry of VOICE_PROVIDER_CATALOG) {
			if (entry.requires.kind !== 'api-key') continue;
			expect(VOICE_CREDENTIAL_SERVICES).toContain(entry.requires.service);
			expect(VOICE_CREDENTIALS[entry.requires.service].label).toBeTruthy();
		}
	});

	it('keeps egress and its service consistent', () => {
		for (const entry of VOICE_PROVIDER_CATALOG) {
			// A provider that sends something has to say where, or the privacy
			// summary would report a service-less egress as nothing at all.
			if (entry.egress === 'none') expect(entry.egressService).toBeNull();
			else expect(entry.egressService).not.toBeNull();
		}
	});

	it('says every local provider keeps its data here', () => {
		for (const id of Object.values(LOCAL_PROVIDER_IDS)) {
			expect(getVoiceProvider(id)?.egress).toBe('none');
			expect(getVoiceProvider(id)?.requires.kind).not.toBe('api-key');
		}
		// Only speech-to-text downloads anything: the voice is the system's own and
		// the router is built in, which is what makes the default trio runnable
		// after one download rather than three.
		expect(getVoiceProvider(LOCAL_PROVIDER_IDS.stt)?.requires.kind).toBe('model');
		expect(getVoiceProvider(LOCAL_PROVIDER_IDS.tts)?.requires.kind).toBe('system-voice');
		expect(getVoiceProvider(LOCAL_PROVIDER_IDS.brain)?.requires.kind).toBe('none');
	});

	it('does not list the engines this build cannot run', () => {
		// Registered in the provider registry, absent from the dropdown: a choice
		// that refuses every session reads as "voice is broken".
		expect(getVoiceProvider('conductor-agent')).toBeUndefined();
	});

	it('lists Kokoro as a local voice that needs its model, and keeps the system voice the default', () => {
		// Listed since its phoneme front end shipped. A download the user chooses,
		// so it is never what "enable voice and talk" resolves to.
		expect(getVoiceProvider('kokoro-local')).toMatchObject({
			role: 'tts',
			tier: 'local',
			requires: { kind: 'model', modelId: 'kokoro-82m', runtimeId: 'onnx' },
			egress: 'none',
		});
		expect(LOCAL_PROVIDER_IDS.tts).toBe('system-tts');
	});

	it('describes the two Local Models Brains without offering them as provider choices', () => {
		// They are selected by the `voice-routing` assignment, not picked by id, so
		// the slot selector must not list them; the gate and the privacy sentence
		// still read their requirement and egress from this table.
		const picked = voiceProvidersForRole('brain').map((entry) => entry.id);
		expect(picked).toEqual(['mock-brain', 'openai-brain', 'anthropic-brain']);
		expect(VOICE_PROVIDER_CATALOG.map((entry) => entry.id)).not.toContain(QWEN3_BRAIN_PROVIDER_ID);
		expect(ASSIGNED_BRAIN_PROVIDERS.map((entry) => entry.id)).toEqual([
			QWEN3_BRAIN_PROVIDER_ID,
			ENDPOINT_BRAIN_PROVIDER_ID,
		]);

		for (const id of [QWEN3_BRAIN_PROVIDER_ID, ENDPOINT_BRAIN_PROVIDER_ID]) {
			expect(getVoiceProvider(id)).toMatchObject({ role: 'brain', tier: 'local' });
			expect(voiceProviderRequirement(id)).toEqual({
				kind: 'local-models-task',
				taskId: 'voice-routing',
			});
			expect(voiceProviderCredential(id)).toBeNull();
		}
		expect(getVoiceProvider(QWEN3_BRAIN_PROVIDER_ID)?.egress).toBe('none');
		expect(getVoiceProvider(ENDPOINT_BRAIN_PROVIDER_ID)?.egress).toBe('text');
	});

	it('offers a hosted trio that one OpenAI key can run', () => {
		for (const id of Object.values(HOSTED_PROVIDER_IDS)) {
			expect(voiceProviderCredential(id)).toBe('openai');
		}
	});

	it('says every hosted provider sends something and needs a key', () => {
		for (const id of Object.values(HOSTED_PROVIDER_IDS)) {
			expect(getVoiceProvider(id)?.egress).not.toBe('none');
			expect(voiceProviderCredential(id)).not.toBeNull();
		}
	});

	it('treats an unknown id as needing nothing', () => {
		// The mock tier's contract, and the honest answer for an id the catalog has
		// never heard of: it is the registry, not this table, that refuses to run it.
		expect(voiceProviderRequirement('not-a-provider')).toEqual({ kind: 'none' });
		expect(voiceProviderCredential('not-a-provider')).toBeNull();
	});
});

describe('summariseVoiceEgress', () => {
	it('states plainly that nothing leaves for a fully local trio', () => {
		const summary = summariseVoiceEgress(Object.values(LOCAL_PROVIDER_IDS));

		expect(summary).toMatchObject({
			audioLeaves: false,
			textLeaves: false,
			services: [],
			statement: 'Audio stays on this machine.',
		});
	});

	it('names the service when audio leaves', () => {
		const summary = summariseVoiceEgress(['openai-stt', 'system-tts', 'mock-brain']);

		expect(summary.audioLeaves).toBe(true);
		expect(summary.statement).toBe('Audio is sent to OpenAI.');
	});

	it('separates text leaving from audio leaving', () => {
		const summary = summariseVoiceEgress([
			LOCAL_PROVIDER_IDS.stt,
			ELEVENLABS_TTS_PROVIDER_ID,
			'anthropic-brain',
		]);

		expect(summary.audioLeaves).toBe(false);
		expect(summary.textLeaves).toBe(true);
		expect(summary.statement).toBe(
			'Audio stays on this machine. Text is sent to ElevenLabs and Anthropic.'
		);
	});

	it('lists three services readably', () => {
		const summary = summariseVoiceEgress(['openai-stt', ELEVENLABS_TTS_PROVIDER_ID]);
		expect(summary.services).toEqual(['openai', 'elevenlabs']);
		expect(summary.statement).toBe('Audio is sent to OpenAI and ElevenLabs.');
	});

	it('reports the realtime tier as audio leaving', () => {
		expect(summariseVoiceEgress([OPENAI_REALTIME_PROVIDER_ID]).statement).toBe(
			'Audio is sent to OpenAI.'
		);
	});

	it('counts an unknown or unresolved id as sending nothing', () => {
		// A slot that could not be built sends nothing anywhere, whatever it was
		// configured with. Reporting otherwise would be the one sentence in this
		// feature that must never be wrong.
		expect(summariseVoiceEgress(['unresolved-stt', 'mock-tts']).statement).toBe(
			'Audio stays on this machine.'
		);
	});

	it('names the endpoint a routed transcript is sent to', () => {
		const summary = summariseVoiceEgress(
			['parakeet-local', 'system-tts', ENDPOINT_BRAIN_PROVIDER_ID],
			{
				endpointName: 'Ollama',
			}
		);

		expect(summary).toMatchObject({
			audioLeaves: false,
			textLeaves: true,
			services: [],
			destinations: ['Ollama'],
			statement: 'Audio stays on this machine. Text is sent to Ollama.',
		});
	});

	it('still says text leaves when the endpoint has no name to give', () => {
		expect(summariseVoiceEgress([ENDPOINT_BRAIN_PROVIDER_ID]).statement).toBe(
			'Audio stays on this machine. Text is sent to your model endpoint.'
		);
	});

	it('lists an endpoint beside a hosted service, and ignores the name without the endpoint Brain', () => {
		expect(
			summariseVoiceEgress(['system-tts', 'openai-tts', ENDPOINT_BRAIN_PROVIDER_ID], {
				endpointName: 'LM Studio',
			}).statement
		).toBe('Audio stays on this machine. Text is sent to OpenAI and LM Studio.');
		expect(
			summariseVoiceEgress([QWEN3_BRAIN_PROVIDER_ID], { endpointName: 'Ollama' }).statement
		).toBe('Audio stays on this machine.');
	});

	it('counts a runtime as in use only when something listed runs on it', () => {
		// ONNX carries the recognisers and the wake word.
		expect(isNativeRuntimeUsedByVoice('onnx')).toBe(true);
		// llama.cpp downloads and loads, but no listed provider needs it: a local
		// model routes only through a `voice-routing` assignment.
		expect(isNativeRuntimeUsedByVoice('llama')).toBe(false);
	});
});
