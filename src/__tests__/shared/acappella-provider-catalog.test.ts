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
	ELEVENLABS_TTS_PROVIDER_ID,
	HOSTED_PROVIDER_IDS,
	LOCAL_PROVIDER_IDS,
	OPENAI_REALTIME_PROVIDER_ID,
	VOICE_CREDENTIALS,
	VOICE_CREDENTIAL_SERVICES,
	VOICE_PROVIDER_CATALOG,
	getVoiceProvider,
	summariseVoiceEgress,
	voiceProviderCredential,
	voiceProviderRequirement,
	voiceProvidersForRole,
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
			expect(getVoiceProvider(id)?.requires.kind).toBe('model');
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
		const summary = summariseVoiceEgress(['openai-stt', 'kokoro-local', 'qwen3-local']);

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
});
