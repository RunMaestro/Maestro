/**
 * @file acappella-voice-control.test.ts
 * @description The wire contract of `maestro-cli voice`: a request read off the
 * wire is one of the known actions with exactly its fields, a malformed one is
 * refused, and the split between what needs voice switched on and what does
 * not matches what the IPC channels allow.
 */

import { describe, it, expect } from 'vitest';

import {
	DEFAULT_WAKE_TEST_SECONDS,
	MAX_WAKE_TEST_SECONDS,
	MIN_WAKE_TEST_SECONDS,
	parseVoiceControlRequest,
	parseVoiceControlScope,
	voiceControlActionNeedsVoice,
	type VoiceControlAction,
} from '../../shared/acappella/voice-control';

describe('parseVoiceControlScope', () => {
	it('reads the Conductor, an agent, a tab and a document', () => {
		expect(parseVoiceControlScope({ kind: 'conductor' })).toEqual({ kind: 'conductor' });
		expect(parseVoiceControlScope({ kind: 'agent', sessionId: 'a1' })).toEqual({
			kind: 'agent',
			sessionId: 'a1',
		});
		expect(parseVoiceControlScope({ kind: 'agent', sessionId: 'a1', tabId: 't1' })).toEqual({
			kind: 'agent',
			sessionId: 'a1',
			tabId: 't1',
		});
		expect(
			parseVoiceControlScope({ kind: 'document', sessionId: 'a1', path: '/notes/plan.md' })
		).toEqual({ kind: 'document', sessionId: 'a1', path: '/notes/plan.md' });
	});

	it('reads Quick Chat, which carries no ids, and drops any it was given', () => {
		expect(parseVoiceControlScope({ kind: 'quick-chat' })).toEqual({ kind: 'quick-chat' });
		expect(parseVoiceControlScope({ kind: 'quick-chat', sessionId: 'a1', tabId: 't1' })).toEqual({
			kind: 'quick-chat',
		});
	});

	it('refuses an unknown kind instead of reading it as the Conductor', () => {
		// A typo must not send a spoken instruction to whichever agent the
		// Conductor happens to pick.
		expect(parseVoiceControlScope({ kind: 'agnet', sessionId: 'a1' })).toBeNull();
		expect(parseVoiceControlScope(undefined)).toBeNull();
		expect(parseVoiceControlScope('conductor')).toBeNull();
	});

	it('refuses a bound scope with nothing to bind to', () => {
		expect(parseVoiceControlScope({ kind: 'agent' })).toBeNull();
		expect(parseVoiceControlScope({ kind: 'agent', sessionId: '' })).toBeNull();
		expect(parseVoiceControlScope({ kind: 'document', sessionId: 'a1' })).toBeNull();
	});
});

describe('parseVoiceControlRequest', () => {
	it('reads an action that takes no fields, and drops any it was given', () => {
		expect(parseVoiceControlRequest({ action: 'status', extra: 1 })).toEqual({ action: 'status' });
		expect(parseVoiceControlRequest({ action: 'stop' })).toEqual({ action: 'stop' });
		expect(parseVoiceControlRequest({ action: 'self-test' })).toEqual({ action: 'self-test' });
	});

	it('refuses what is not a request', () => {
		expect(parseVoiceControlRequest(null)).toBeNull();
		expect(parseVoiceControlRequest({})).toBeNull();
		expect(parseVoiceControlRequest({ action: 'launch-missiles' })).toBeNull();
	});

	it('reads a start, and only a literal true opens gated', () => {
		expect(
			parseVoiceControlRequest({ action: 'start', scope: { kind: 'conductor' }, paused: 'yes' })
		).toEqual({ action: 'start', scope: { kind: 'conductor' }, paused: false });
		expect(
			parseVoiceControlRequest({ action: 'start', scope: { kind: 'conductor' }, paused: true })
		).toMatchObject({ paused: true });
		expect(parseVoiceControlRequest({ action: 'start' })).toBeNull();
	});

	it('reads the session controls', () => {
		expect(parseVoiceControlRequest({ action: 'listen', listening: false, send: true })).toEqual({
			action: 'listen',
			listening: false,
			send: true,
		});
		expect(parseVoiceControlRequest({ action: 'listen', listening: 'off' })).toBeNull();
		expect(parseVoiceControlRequest({ action: 'wait', waitMs: null })).toEqual({
			action: 'wait',
			waitMs: null,
		});
		expect(parseVoiceControlRequest({ action: 'wait', waitMs: 1500 })).toEqual({
			action: 'wait',
			waitMs: 1500,
		});
		expect(parseVoiceControlRequest({ action: 'wait' })).toBeNull();
		expect(parseVoiceControlRequest({ action: 'volume', volume: 0 })).toEqual({
			action: 'volume',
			volume: 0,
		});
		expect(parseVoiceControlRequest({ action: 'volume', volume: 'loud' })).toBeNull();
	});

	it('takes a credential only for a known service, and never an empty key', () => {
		expect(
			parseVoiceControlRequest({ action: 'set-credential', service: 'openai', key: 'sk-test' })
		).toEqual({ action: 'set-credential', service: 'openai', key: 'sk-test' });
		// The service becomes a keychain account name, so an arbitrary one is refused.
		expect(
			parseVoiceControlRequest({ action: 'set-credential', service: 'aws', key: 'sk-test' })
		).toBeNull();
		expect(
			parseVoiceControlRequest({ action: 'set-credential', service: 'openai', key: '' })
		).toBeNull();
		expect(parseVoiceControlRequest({ action: 'clear-credential', service: 'elevenlabs' })).toEqual(
			{ action: 'clear-credential', service: 'elevenlabs' }
		);
	});

	it('tests the stored key, or one given before it is stored', () => {
		expect(parseVoiceControlRequest({ action: 'test-credential', service: 'anthropic' })).toEqual({
			action: 'test-credential',
			service: 'anthropic',
		});
		expect(
			parseVoiceControlRequest({ action: 'test-credential', service: 'anthropic', key: 'sk-x' })
		).toEqual({ action: 'test-credential', service: 'anthropic', key: 'sk-x' });
	});

	it('reads the device actions and refuses one with no device', () => {
		expect(
			parseVoiceControlRequest({ action: 'rename-device', deviceId: 'd1', name: 'Phone' })
		).toEqual({ action: 'rename-device', deviceId: 'd1', name: 'Phone' });
		expect(parseVoiceControlRequest({ action: 'rename-device', deviceId: 'd1' })).toBeNull();
		expect(parseVoiceControlRequest({ action: 'revoke-device', deviceId: 'd1' })).toEqual({
			action: 'revoke-device',
			deviceId: 'd1',
		});
		expect(parseVoiceControlRequest({ action: 'forget-device' })).toBeNull();
		expect(parseVoiceControlRequest({ action: 'discovery', enabled: true })).toEqual({
			action: 'discovery',
			enabled: true,
		});
		expect(parseVoiceControlRequest({ action: 'discovery', enabled: 'on' })).toBeNull();
	});

	it('keeps a wake test inside its time limits', () => {
		expect(parseVoiceControlRequest({ action: 'wake-test' })).toEqual({
			action: 'wake-test',
			seconds: DEFAULT_WAKE_TEST_SECONDS,
		});
		expect(parseVoiceControlRequest({ action: 'wake-test', seconds: 9000 })).toMatchObject({
			seconds: MAX_WAKE_TEST_SECONDS,
		});
		expect(parseVoiceControlRequest({ action: 'wake-test', seconds: 0 })).toMatchObject({
			seconds: MIN_WAKE_TEST_SECONDS,
		});
		expect(
			parseVoiceControlRequest({
				action: 'wake-test',
				seconds: 5,
				phrase: ' hey scout ',
				sensitivity: 0.7,
			})
		).toEqual({ action: 'wake-test', seconds: 5, phrase: 'hey scout', sensitivity: 0.7 });
		// A sensitivity outside 0 to 1 is dropped, so the stored one is tested.
		expect(parseVoiceControlRequest({ action: 'wake-test', seconds: 5, sensitivity: 4 })).toEqual({
			action: 'wake-test',
			seconds: 5,
		});
	});

	it('reads a preview with or without a line and a voice', () => {
		expect(parseVoiceControlRequest({ action: 'preview' })).toEqual({ action: 'preview' });
		expect(
			parseVoiceControlRequest({ action: 'preview', text: 'Hello.', voiceId: 'af_heart' })
		).toEqual({ action: 'preview', text: 'Hello.', voiceId: 'af_heart' });
	});
});

describe('voiceControlActionNeedsVoice', () => {
	it('lets a session be ended and a microphone list be read with voice switched off', () => {
		const ungated: VoiceControlAction[] = [
			'status',
			'stop',
			'inputs',
			'set-input',
			'credentials',
			'set-credential',
			'clear-credential',
			'test-credential',
			'devices',
			'rename-device',
			'revoke-device',
			'forget-device',
			'revoke-all-devices',
			'disconnect-devices',
			'discovery',
			'self-test',
		];
		for (const action of ungated) expect(voiceControlActionNeedsVoice(action), action).toBe(false);
	});

	it('needs voice switched on to open a microphone or speak', () => {
		const gated: VoiceControlAction[] = [
			'start',
			'listen',
			'send',
			'stop-reply',
			'scope',
			'wait',
			'volume',
			'apply-providers',
			'voices',
			'preview',
			'test-connection',
			'latency',
			'wake-test',
		];
		for (const action of gated) expect(voiceControlActionNeedsVoice(action), action).toBe(true);
	});
});
