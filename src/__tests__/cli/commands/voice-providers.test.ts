/**
 * @file voice-providers.test.ts
 * @description Tests for `maestro-cli voice providers|voices|credentials|
 * wake-phrase`: a provider and a voice are written to the settings file through
 * the table the panels' bounds come from and then handed to the running app, a
 * swap the app refuses is reported as saved and not applied, a key travels on
 * standard input only, and one agent's wake phrase is rewritten without
 * dropping the others.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/services/storage', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/storage')>()),
	resolveAgentId: vi.fn((id: string) => `agent-${id}`),
	getSessionById: vi.fn((id: string) => (id === 'agent-scout' ? { name: 'Scout' } : undefined)),
	readSettingValue: vi.fn(),
	writeSettingValue: vi.fn(() => true),
	readLocalModelAssignments: vi.fn(() => ({})),
	readLocalModelEndpoints: vi.fn(() => []),
	writeLocalModelAssignments: vi.fn(),
}));

vi.mock('../../../cli/services/stdin', () => ({
	isStdinTerminal: vi.fn(() => false),
	readStdinText: vi.fn(() => 'sk-test-key\n'),
}));

import {
	voiceCredentialsClear,
	voiceCredentialsList,
	voiceCredentialsSet,
	voiceCredentialsTest,
	voiceProvidersList,
	voiceProvidersSet,
	voiceVoicesList,
	voiceVoicesPreview,
	voiceVoicesSet,
	voiceWakePhraseClear,
	voiceWakePhraseList,
	voiceWakePhraseSet,
} from '../../../cli/commands/voice-providers';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import {
	readLocalModelAssignments,
	readSettingValue,
	writeLocalModelAssignments,
	writeSettingValue,
} from '../../../cli/services/storage';
import { isStdinTerminal, readStdinText } from '../../../cli/services/stdin';
import { ExitCode } from '../../../cli/exit-codes';
import {
	HOSTED_PROVIDER_IDS,
	LOCAL_PROVIDER_IDS,
	QWEN3_BRAIN_PROVIDER_ID,
	WHISPER_STT_PROVIDER_ID,
} from '../../../shared/acappella/provider-catalog';
import type {
	VoiceControlReply,
	VoiceControlRequest,
} from '../../../shared/acappella/voice-control';

/** Answer each `voice_control` request from `reply`, recording what was sent. */
function mockBridge(reply: (request: VoiceControlRequest) => VoiceControlReply) {
	const sent: VoiceControlRequest[] = [];
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: { request: VoiceControlRequest }) => {
				sent.push(payload.request);
				return Promise.resolve({ success: true, reply: reply(payload.request) });
			}),
		} as never)
	);
	return sent;
}

/** The app cannot be reached at all. */
function mockNoApp() {
	vi.mocked(withMaestroClient).mockRejectedValue(new Error('Maestro desktop app is not running'));
}

const ok = (result: unknown): VoiceControlReply => ({ ok: true, result }) as VoiceControlReply;

/** Serve the settings file from a plain object, by dotted key. */
function mockSettings(settings: Record<string, unknown>) {
	vi.mocked(readSettingValue).mockImplementation((key: string) =>
		key
			.split('.')
			.reduce<unknown>(
				(value, part) =>
					value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined,
				settings
			)
	);
}

describe('voice provider, voice, credential and wake phrase commands', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;

	const printed = () => logSpy.mock.calls.map(([line]) => String(line)).join('\n');
	const errors = () => errorSpy.mock.calls.map(([line]) => String(line)).join('\n');
	const json = () => JSON.parse(String(logSpy.mock.calls[0][0]));

	beforeEach(() => {
		vi.clearAllMocks();
		mockSettings({});
		vi.mocked(readLocalModelAssignments).mockReturnValue({});
		vi.mocked(isStdinTerminal).mockReturnValue(false);
		vi.mocked(readStdinText).mockReturnValue('sk-test-key\n');
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
			throw new Error(`exit:${code}`);
		}) as never);
	});

	describe('providers list', () => {
		it('reads an unset slot as the local default, without the app', () => {
			voiceProvidersList({ json: true });

			const out = json();
			expect(out.pipeline).toBe('cascade');
			expect(out.slots.map((slot: { slot: string }) => slot.slot)).toEqual(['stt', 'tts', 'brain']);
			for (const slot of out.slots) {
				expect(slot.providerId).toBe(LOCAL_PROVIDER_IDS[slot.slot as 'stt']);
				expect(slot.stored).toBe(false);
				expect(slot.options.length).toBeGreaterThan(0);
			}
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('shows a stored choice as stored', () => {
			mockSettings({ acappella: { providers: { stt: WHISPER_STT_PROVIDER_ID } } });
			voiceProvidersList({ json: true });

			const stt = json().slots[0];
			expect(stt).toMatchObject({ providerId: WHISPER_STT_PROVIDER_ID, stored: true });
		});

		it('shows the Brain a Voice routing assignment puts in the slot', () => {
			mockSettings({
				localModelAssignments: { 'voice-routing': { type: 'local', modelId: 'qwen3-1.7b' } },
			});
			voiceProvidersList({ json: true });

			const out = json();
			expect(out.slots[2].providerId).toBe(QWEN3_BRAIN_PROVIDER_ID);
			expect(out.brainSource.spec).toBe('local:qwen3-1.7b');
		});
	});

	describe('providers set', () => {
		it('writes the slot and tells the running app, which switched to it', async () => {
			const sent = mockBridge(() => ok({ status: 'swapped' }));
			await voiceProvidersSet('stt', WHISPER_STT_PROVIDER_ID, { json: true });

			expect(writeSettingValue).toHaveBeenCalledWith(
				'acappella.providers.stt',
				WHISPER_STT_PROVIDER_ID
			);
			expect(sent).toEqual([{ action: 'apply-providers' }]);
			expect(json()).toEqual({
				success: true,
				slot: 'stt',
				value: WHISPER_STT_PROVIDER_ID,
				applied: 'swapped',
			});
		});

		it('writes the pipeline shape under its own key', async () => {
			mockBridge(() => ok({ status: 'unchanged' }));
			await voiceProvidersSet('pipeline', 'realtime', {});
			expect(writeSettingValue).toHaveBeenCalledWith('acappella.pipeline', 'realtime');
		});

		it('refuses a provider the slot cannot run, and writes nothing', async () => {
			mockBridge(() => ok({ status: 'swapped' }));

			await expect(voiceProvidersSet('stt', LOCAL_PROVIDER_IDS.tts, {})).rejects.toThrow(
				`exit:${ExitCode.InvalidUsage}`
			);
			await expect(voiceProvidersSet('ears', WHISPER_STT_PROVIDER_ID, {})).rejects.toThrow(
				`exit:${ExitCode.InvalidUsage}`
			);
			expect(writeSettingValue).not.toHaveBeenCalled();
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('sends a model Brain to the assignment verb', async () => {
			await expect(voiceProvidersSet('brain', QWEN3_BRAIN_PROVIDER_ID, {})).rejects.toThrow(
				`exit:${ExitCode.InvalidUsage}`
			);
			expect(errors()).toContain('models assign voice-routing');
		});

		it('reports a swap the app refused as saved and not applied yet', async () => {
			mockBridge(() => ok({ status: 'refused', reason: 'A turn is in flight.' }));
			await voiceProvidersSet('tts', HOSTED_PROVIDER_IDS.tts, { json: true });

			// The write is not undone: the setting takes effect when the turn ends.
			expect(writeSettingValue).toHaveBeenCalled();
			expect(json()).toMatchObject({
				success: true,
				applied: 'refused',
				reason: 'A turn is in flight.',
			});
		});

		it('saves with Maestro closed, and says the app was not told', async () => {
			mockNoApp();
			await voiceProvidersSet('stt', WHISPER_STT_PROVIDER_ID, { json: true });

			expect(writeSettingValue).toHaveBeenCalled();
			expect(json()).toMatchObject({
				success: true,
				applied: null,
				reason: 'Maestro desktop app is not running',
			});
		});

		it('switches a model Voice routing assignment off when a Brain is picked', async () => {
			// Left on, the assignment would keep deciding the slot.
			mockSettings({
				localModelAssignments: { 'voice-routing': { type: 'local', modelId: 'qwen3-1.7b' } },
			});
			vi.mocked(readLocalModelAssignments).mockReturnValue({
				'voice-routing': { type: 'local', modelId: 'qwen3-1.7b' },
			} as never);
			mockBridge(() => ok({ status: 'swapped' }));

			await voiceProvidersSet('brain', LOCAL_PROVIDER_IDS.brain, { json: true });

			expect(writeLocalModelAssignments).toHaveBeenCalledTimes(1);
			const written = vi.mocked(writeLocalModelAssignments).mock.calls[0][0] as Record<
				string,
				unknown
			>;
			expect(written['voice-routing']).toBeUndefined();
			expect(json().clearedAssignment).toBe('local:qwen3-1.7b');
		});

		it('leaves the assignments alone when no model fills the Brain slot', async () => {
			mockBridge(() => ok({ status: 'swapped' }));
			await voiceProvidersSet('brain', LOCAL_PROVIDER_IDS.brain, {});
			expect(writeLocalModelAssignments).not.toHaveBeenCalled();
		});
	});

	describe('voices', () => {
		const voices = [
			{ id: 'af_heart', name: 'Heart' },
			{ id: 'am_adam', name: 'Adam' },
		];

		it('lists the voices and marks the one selected', async () => {
			mockSettings({ acappella: { voice: { voiceId: 'am_adam' } } });
			mockBridge(() => ok({ voices }));
			await voiceVoicesList({});

			expect(printed()).toContain('  af_heart  Heart');
			expect(printed()).toContain('* am_adam  Adam');
		});

		it('picks a voice the provider offers, then tells the app', async () => {
			const sent = mockBridge((request) =>
				request.action === 'voices' ? ok({ voices }) : ok({ status: 'swapped' })
			);
			await voiceVoicesSet('af_heart', {});

			expect(writeSettingValue).toHaveBeenCalledWith('acappella.voice.voiceId', 'af_heart');
			expect(sent.map((request) => request.action)).toEqual(['voices', 'apply-providers']);
		});

		it('refuses a voice the provider does not offer', async () => {
			mockBridge(() => ok({ voices }));
			await expect(voiceVoicesSet('zz_nobody', {})).rejects.toThrow(
				`exit:${ExitCode.InvalidUsage}`
			);
			expect(writeSettingValue).not.toHaveBeenCalled();
		});

		it('saves a voice with Maestro closed, since the list cannot be asked for', async () => {
			mockNoApp();
			await voiceVoicesSet('af_heart', { json: true });
			expect(writeSettingValue).toHaveBeenCalledWith('acappella.voice.voiceId', 'af_heart');
			expect(json()).toMatchObject({ success: true, voiceId: 'af_heart', applied: null });
		});

		it('previews a voice that is not the selected one', async () => {
			const sent = mockBridge(() => ok({ spoke: true }));
			await voiceVoicesPreview('af_heart', { text: 'Hello there.' });
			expect(sent).toEqual([{ action: 'preview', text: 'Hello there.', voiceId: 'af_heart' }]);
		});

		it('exits non-zero when nothing was spoken', async () => {
			mockBridge(() => ok({ spoke: false }));
			await expect(voiceVoicesPreview(undefined, {})).rejects.toThrow('exit:1');
			expect(errors()).toContain('Nothing was spoken');
		});
	});

	describe('credentials', () => {
		it('lists which keys are stored and never a key', async () => {
			mockBridge(() =>
				ok({
					credentials: [
						{ service: 'openai', label: 'OpenAI', configured: true, keyringAvailable: true },
						{ service: 'anthropic', label: 'Anthropic', configured: false, keyringAvailable: true },
					],
				})
			);
			await voiceCredentialsList({});

			expect(printed()).toContain('openai  OpenAI: stored');
			expect(printed()).toContain('anthropic  Anthropic: not set');
		});

		it('stores a key read from standard input, trimmed', async () => {
			const sent = mockBridge(() => ok({ service: 'openai', configured: true }));
			await voiceCredentialsSet('OpenAI', {});

			expect(sent).toEqual([{ action: 'set-credential', service: 'openai', key: 'sk-test-key' }]);
			// The key is in the request and nowhere on the screen.
			expect(printed()).not.toContain('sk-test-key');
		});

		it('refuses a key typed at a terminal, where it would be on the screen', async () => {
			vi.mocked(isStdinTerminal).mockReturnValue(true);
			mockBridge(() => ok({}));

			await expect(voiceCredentialsSet('openai', {})).rejects.toThrow(
				`exit:${ExitCode.InvalidUsage}`
			);
			expect(readStdinText).not.toHaveBeenCalled();
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('refuses an empty key and an unknown service', async () => {
			vi.mocked(readStdinText).mockReturnValue('  \n');
			mockBridge(() => ok({}));

			await expect(voiceCredentialsSet('openai', {})).rejects.toThrow(
				`exit:${ExitCode.InvalidUsage}`
			);
			await expect(voiceCredentialsSet('aws', {})).rejects.toThrow(`exit:${ExitCode.InvalidUsage}`);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('clears a key', async () => {
			const sent = mockBridge(() => ok({ service: 'elevenlabs', configured: false }));
			await voiceCredentialsClear('elevenlabs', {});
			expect(sent).toEqual([{ action: 'clear-credential', service: 'elevenlabs' }]);
		});

		it('tests the stored key without reading standard input', async () => {
			const sent = mockBridge(() =>
				ok({ service: 'openai', status: 'valid', message: 'The OpenAI key works.' })
			);
			await voiceCredentialsTest('openai', {});

			expect(sent).toEqual([{ action: 'test-credential', service: 'openai' }]);
			expect(readStdinText).not.toHaveBeenCalled();
			expect(printed()).toContain('The OpenAI key works.');
		});

		it('tests a key from standard input before it is stored', async () => {
			const sent = mockBridge(() =>
				ok({ service: 'openai', status: 'valid', message: 'The OpenAI key works.' })
			);
			await voiceCredentialsTest('openai', { stdin: true });
			expect(sent).toEqual([{ action: 'test-credential', service: 'openai', key: 'sk-test-key' }]);
		});

		it('exits non-zero for a key that does not work, with the verdict whole under --json', async () => {
			mockBridge(() =>
				ok({
					service: 'openai',
					status: 'invalid',
					message: 'OpenAI rejected the key.',
					httpStatus: 401,
				})
			);

			await expect(voiceCredentialsTest('openai', { json: true })).rejects.toThrow('exit:1');
			expect(json()).toEqual({
				success: false,
				service: 'openai',
				status: 'invalid',
				message: 'OpenAI rejected the key.',
				httpStatus: 401,
			});
			// Printed once: the verdict is not followed by a second error object.
			expect(logSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe('wake-phrase', () => {
		const stored = [
			{ agentSessionId: 'agent-scout', phrase: 'hey scout' },
			{ agentSessionId: 'agent-atlas', phrase: 'hey atlas' },
		];

		it('lists every agent with a phrase of its own', () => {
			mockSettings({ acappella: { controls: { agentPhrases: stored } } });
			voiceWakePhraseList({ json: true });

			expect(json().phrases).toEqual([
				{ agentId: 'agent-scout', name: 'Scout', phrase: 'hey scout' },
				{ agentId: 'agent-atlas', name: 'agent-atlas', phrase: 'hey atlas' },
			]);
		});

		it('rewrites one agent and keeps every other entry', () => {
			mockSettings({ acappella: { controls: { agentPhrases: stored } } });
			voiceWakePhraseSet('scout', ' hey ranger ', {});

			expect(writeSettingValue).toHaveBeenCalledWith('acappella.controls.agentPhrases', [
				{ agentSessionId: 'agent-atlas', phrase: 'hey atlas' },
				{ agentSessionId: 'agent-scout', phrase: 'hey ranger' },
			]);
			// The file is the setting; nothing is asked of the app.
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('removes one agent and keeps the rest', () => {
			mockSettings({ acappella: { controls: { agentPhrases: stored } } });
			voiceWakePhraseClear('scout', { json: true });

			expect(writeSettingValue).toHaveBeenCalledWith('acappella.controls.agentPhrases', [
				{ agentSessionId: 'agent-atlas', phrase: 'hey atlas' },
			]);
			expect(json()).toEqual({ success: true, agentId: 'agent-scout', phrase: null });
		});

		it('refuses an empty phrase and points at clear', () => {
			expect(() => voiceWakePhraseSet('scout', '  ', {})).toThrow(`exit:${ExitCode.InvalidUsage}`);
			expect(errors()).toContain('wake-phrase clear');
			expect(writeSettingValue).not.toHaveBeenCalled();
		});
	});
});
