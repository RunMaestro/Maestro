/**
 * @file acappella-voice-settings-schema.test.ts
 * @description The A Cappella settings table a writer outside the Voice
 * settings panels checks against: every field's kind and bounds, a section
 * written as one object, a path the table does not hold, the default an unset
 * field reads as, masking the one secret in the blob, and rewriting one
 * agent's wake phrase without dropping the others.
 */

import { describe, it, expect } from 'vitest';

import {
	VOICE_SETTING_FIELDS,
	VOICE_SETTING_MASK,
	VOICE_SETTING_PATHS,
	isSensitiveVoiceSetting,
	isVoiceSettingPath,
	readAgentWakePhrases,
	redactVoiceSettings,
	storableVoiceProviderIds,
	voiceSettingDefault,
	voiceSettingPath,
	voiceSettingProblem,
	withAgentWakePhrase,
} from '../../shared/acappella/voice-settings-schema';
import {
	ENDPOINT_BRAIN_PROVIDER_ID,
	LOCAL_PROVIDER_IDS,
	QWEN3_BRAIN_PROVIDER_ID,
} from '../../shared/acappella/provider-catalog';
import {
	DEFAULT_TURN_SETTLE_MS,
	DEFAULT_WAKE_PHRASE,
	MAX_TURN_SETTLE_MS,
	MIN_TTS_VOLUME,
} from '../../shared/acappella/voice-controls';
import { DEFAULT_STUN_URLS } from '../../shared/acappella/webrtc-host';

describe('voiceSettingProblem', () => {
	it.each(['local', 'cloud', 'custom'])(
		'accepts the %s voice setup preset in saved settings',
		(setupMode) => {
			expect(voiceSettingProblem('setupMode', setupMode)).toBeNull();
			expect(voiceSettingProblem('', { setupMode, pipeline: 'cascade' })).toBeNull();
		}
	);

	it('rejects an unknown voice setup preset and leaves legacy defaults inferred', () => {
		expect(voiceSettingProblem('setupMode', 'automatic')).toContain('one of');
		expect(voiceSettingDefault('setupMode')).toBeUndefined();
	});

	it('validates the VoiceStudio source for CLI field, section and whole-blob writes', () => {
		expect(
			voiceSettingProblem('voiceStudio', {
				baseUrl: 'http://127.0.0.1:3900',
				engine: 'voxcpm2',
				seed: 11,
			})
		).toBeNull();
		expect(voiceSettingProblem('voiceStudio.baseUrl', 'https://example.com')).toContain(
			'this computer'
		);
		expect(voiceSettingProblem('voiceStudio.seed', 1.5)).toContain('whole number');
		expect(voiceSettingProblem('', { voiceStudio: { seed: 1.5 } })).toContain('whole number');
		expect(voiceSettingProblem('voiceStudio.engine', '../engine')).not.toBeNull();
	});
	it('accepts a value inside a field its bounds', () => {
		expect(voiceSettingProblem('providers.vocabulary', ['Pedro Sidián', 'NorseStar'])).toBeNull();
		expect(voiceSettingProblem('providers.vocabulary', ['Pedro Sidián', 42])).not.toBeNull();
		expect(voiceSettingProblem('controls.turnSettleMs', DEFAULT_TURN_SETTLE_MS)).toBeNull();
		expect(voiceSettingProblem('controls.wakeWordEnabled', true)).toBeNull();
		expect(voiceSettingProblem('controls.wakePhrase', 'hey scout')).toBeNull();
		expect(voiceSettingProblem('ui.listenMode', 'push-to-talk')).toBeNull();
		expect(voiceSettingProblem('ui.hudPosition', { top: 10, left: 20 })).toBeNull();
		expect(voiceSettingProblem('ui.hudPosition', null)).toBeNull();
		expect(voiceSettingProblem('ice.stunUrls', [])).toBeNull();
	});

	it('refuses a number outside the bounds the panel has, and names them', () => {
		const problem = voiceSettingProblem('controls.turnSettleMs', MAX_TURN_SETTLE_MS + 1);
		expect(problem).toContain('acappella.controls.turnSettleMs');
		expect(problem).toContain(String(MAX_TURN_SETTLE_MS));
		expect(voiceSettingProblem('voice.volume', MIN_TTS_VOLUME - 0.05)).not.toBeNull();
		expect(voiceSettingProblem('controls.wakeSensitivity', 1.5)).not.toBeNull();
	});

	it('refuses the wrong kind of value: a word for a number, a number for a switch', () => {
		// The case that motivated the table: a reader would have turned "fast"
		// into the default and the writer would have reported it as set.
		expect(voiceSettingProblem('controls.turnSettleMs', 'fast')).not.toBeNull();
		expect(voiceSettingProblem('controls.turnSettleMs', Number.NaN)).not.toBeNull();
		expect(voiceSettingProblem('controls.wakeWordEnabled', 1)).not.toBeNull();
		expect(voiceSettingProblem('controls.wakePhrase', 42)).not.toBeNull();
	});

	it('refuses an empty phrase and accepts an empty send-phrase list', () => {
		// An empty wake phrase could never be said. An empty send-phrase list is
		// a real setting: it turns the spoken send off.
		expect(voiceSettingProblem('controls.wakePhrase', '  ')).not.toBeNull();
		expect(voiceSettingProblem('controls.sendPhrases', '')).toBeNull();
	});

	it('accepts only a provider the slot can store', () => {
		expect(voiceSettingProblem('providers.stt', LOCAL_PROVIDER_IDS.stt)).toBeNull();
		expect(voiceSettingProblem('providers.stt', LOCAL_PROVIDER_IDS.tts)).toContain('one of');
		expect(voiceSettingProblem('providers.stt', 'no-such-engine')).toContain('one of');
		expect(voiceSettingProblem('pipeline', 'realtime')).toBeNull();
		expect(voiceSettingProblem('pipeline', 'parallel')).not.toBeNull();
	});

	it('sends a model Brain to the assignment verb instead of storing its id', () => {
		for (const id of [QWEN3_BRAIN_PROVIDER_ID, ENDPOINT_BRAIN_PROVIDER_ID]) {
			expect(storableVoiceProviderIds('brain')).not.toContain(id);
			expect(voiceSettingProblem('providers.brain', id)).toContain('models assign voice-routing');
		}
	});

	it('checks every field of a section written as one object', () => {
		expect(
			voiceSettingProblem('controls', { wakePhrase: 'hey scout', turnSettleMs: 500 })
		).toBeNull();
		expect(voiceSettingProblem('controls', { turnSettleMs: 'fast' })).toContain(
			'acappella.controls.turnSettleMs'
		);
		expect(voiceSettingProblem('controls', { notASetting: true })).toContain(
			'not an A Cappella setting'
		);
		expect(voiceSettingProblem('controls', 'on')).toContain('JSON object');
	});

	it('checks the whole blob, and lets the migration bookkeeping ride in it', () => {
		expect(
			voiceSettingProblem('', {
				providersVersion: 5,
				providers: { stt: LOCAL_PROVIDER_IDS.stt },
				ice: { turn: { enabled: false, url: '' } },
			})
		).toBeNull();
		expect(voiceSettingProblem('', { ice: { turn: { enabled: 'yes' } } })).toContain(
			'acappella.ice.turn.enabled'
		);
	});

	it('refuses a path the table does not hold, and lists the ones it does', () => {
		const problem = voiceSettingProblem('controls.wakeFrase', 'hey scout');
		expect(problem).toContain('not an A Cappella setting');
		expect(problem).toContain('controls.wakePhrase');
	});

	it('accepts a list of agent phrases and refuses one with a blank phrase', () => {
		expect(
			voiceSettingProblem('controls.agentPhrases', [{ agentSessionId: 'a1', phrase: 'hey scout' }])
		).toBeNull();
		expect(
			voiceSettingProblem('controls.agentPhrases', [{ agentSessionId: 'a1', phrase: ' ' }])
		).not.toBeNull();
		expect(voiceSettingProblem('controls.agentPhrases', 'hey scout')).not.toBeNull();
	});
});

describe('paths and defaults', () => {
	it('reads a key with or without the setting name in front', () => {
		expect(voiceSettingPath('acappella.controls.wakePhrase')).toBe('controls.wakePhrase');
		expect(voiceSettingPath('controls.wakePhrase')).toBe('controls.wakePhrase');
		expect(voiceSettingPath('acappella')).toBe('');
	});

	it('knows a field, a section and the whole blob, and nothing else', () => {
		expect(isVoiceSettingPath('controls.wakePhrase')).toBe(true);
		expect(isVoiceSettingPath('controls')).toBe(true);
		expect(isVoiceSettingPath('ice.turn')).toBe(true);
		expect(isVoiceSettingPath('')).toBe(true);
		expect(isVoiceSettingPath('providersVersion')).toBe(true);
		expect(isVoiceSettingPath('controls.wakeFrase')).toBe(false);
		expect(isVoiceSettingPath('control')).toBe(false);
	});

	it('reads an unset field as the default its panel shows', () => {
		expect(voiceSettingDefault('controls.wakePhrase')).toBe(DEFAULT_WAKE_PHRASE);
		expect(voiceSettingDefault('controls.turnSettleMs')).toBe(DEFAULT_TURN_SETTLE_MS);
		expect(voiceSettingDefault('providers.stt')).toBe(LOCAL_PROVIDER_IDS.stt);
		expect(voiceSettingDefault('ice.stunUrls')).toEqual([...DEFAULT_STUN_URLS]);
		expect(voiceSettingDefault('controls')).toBeUndefined();
	});

	it('hands out a copy of a list default, so a caller cannot edit the table', () => {
		const first = voiceSettingDefault('ice.stunUrls') as string[];
		first.push('stun:example.test:3478');
		expect(voiceSettingDefault('ice.stunUrls')).toEqual([...DEFAULT_STUN_URLS]);
	});

	it('gives every default a value its own field accepts', () => {
		for (const path of VOICE_SETTING_PATHS) {
			const value = voiceSettingDefault(path);
			// An unset voice, microphone and realtime provider have no default to check.
			if (value === undefined) continue;
			expect(voiceSettingProblem(path, value), path).toBeNull();
		}
	});

	it('describes every field', () => {
		for (const [path, field] of Object.entries(VOICE_SETTING_FIELDS)) {
			expect(field.description.length, path).toBeGreaterThan(10);
		}
	});
});

describe('redactVoiceSettings', () => {
	const blob = {
		controls: { wakePhrase: 'hey scout' },
		ice: { turn: { enabled: true, url: 'turn:relay.test:3478', credential: 'hunter2' } },
	};

	it('marks the TURN credential as the one secret', () => {
		expect(isSensitiveVoiceSetting('ice.turn.credential')).toBe(true);
		expect(VOICE_SETTING_PATHS.filter(isSensitiveVoiceSetting)).toEqual(['ice.turn.credential']);
	});

	it('masks the secret in a read of the blob or of a section around it', () => {
		expect(redactVoiceSettings('', blob)).toEqual({
			controls: { wakePhrase: 'hey scout' },
			ice: { turn: { enabled: true, url: 'turn:relay.test:3478', credential: VOICE_SETTING_MASK } },
		});
		expect(redactVoiceSettings('ice', blob.ice)).toEqual({
			turn: { enabled: true, url: 'turn:relay.test:3478', credential: VOICE_SETTING_MASK },
		});
		expect(redactVoiceSettings('ice.turn', blob.ice.turn)).toMatchObject({
			credential: VOICE_SETTING_MASK,
		});
	});

	it('returns the secret for a read of its own path, which is asking for it', () => {
		expect(redactVoiceSettings('ice.turn.credential', 'hunter2')).toBe('hunter2');
	});

	it('leaves an empty secret visible as empty, and does not edit what it was given', () => {
		expect(redactVoiceSettings('ice.turn', { credential: '' })).toEqual({ credential: '' });
		redactVoiceSettings('', blob);
		expect(blob.ice.turn.credential).toBe('hunter2');
	});
});

describe('withAgentWakePhrase', () => {
	const stored = [
		{ agentSessionId: 'a1', phrase: 'hey scout' },
		{ agentSessionId: 'a2', phrase: 'hey atlas' },
	];

	it('rewrites one agent and leaves every other entry as it is', () => {
		expect(withAgentWakePhrase(stored, 'a1', '  hey ranger ')).toEqual([
			{ agentSessionId: 'a2', phrase: 'hey atlas' },
			{ agentSessionId: 'a1', phrase: 'hey ranger' },
		]);
	});

	it('adds an agent that had none', () => {
		expect(withAgentWakePhrase(stored, 'a3', 'hey nova')).toHaveLength(3);
	});

	it('removes the entry for a blank phrase instead of storing one nobody can say', () => {
		expect(withAgentWakePhrase(stored, 'a1', '   ')).toEqual([
			{ agentSessionId: 'a2', phrase: 'hey atlas' },
		]);
	});

	it('reads a stored list and drops what is not an entry', () => {
		expect(
			readAgentWakePhrases([
				{ agentSessionId: 'a1', phrase: 'hey scout', extra: 1 },
				{ agentSessionId: 'a2' },
				null,
				'hey atlas',
			])
		).toEqual([{ agentSessionId: 'a1', phrase: 'hey scout' }]);
		expect(readAgentWakePhrases(undefined)).toEqual([]);
	});
});
