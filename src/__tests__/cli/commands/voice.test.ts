/**
 * @file voice.test.ts
 * @description Tests for the session and HUD verbs of `maestro-cli voice`:
 * every verb crosses the WS bridge as one `voice_control` request in the shape
 * the app reads, a refusal exits non-zero with the app's reason, the scope
 * flags become the scope the HUD would bind, and `voice setup` downloads
 * nothing unless it is asked to.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import * as path from 'path';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/services/storage', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/storage')>()),
	resolveAgentId: vi.fn((id: string) => {
		if (id === 'ghost') throw new Error('Agent not found: ghost');
		return `agent-${id}`;
	}),
	getSessionById: vi.fn((id: string) => (id === 'agent-scout' ? { name: 'Scout' } : undefined)),
	readActiveAgentId: vi.fn(() => 'agent-active'),
	readSettingValue: vi.fn(),
	writeSettingValue: vi.fn(() => true),
	readLocalModelAssignments: vi.fn(() => ({})),
}));

import {
	describeVoiceScope,
	describeVoiceSession,
	formatVoiceStatus,
	voiceInputList,
	voiceInputSet,
	voiceLatency,
	voiceListen,
	voiceMute,
	voiceScope,
	voiceSend,
	voiceSetup,
	voiceStart,
	voiceStatus,
	voiceStop,
	voiceStopReply,
	voiceUnmute,
	voiceVolume,
	voiceWait,
	voiceWakeTest,
} from '../../../cli/commands/voice';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { readSettingValue, writeSettingValue } from '../../../cli/services/storage';
import { ExitCode } from '../../../cli/exit-codes';
import { ACAPPELLA_SYSTEM_DEFAULT_INPUT } from '../../../shared/acappella/audio-host';
import { MODEL_SETS } from '../../../shared/acappella/voice-models';
import type {
	VoiceControlReply,
	VoiceControlRequest,
	VoiceSessionView,
} from '../../../shared/acappella/voice-control';

const SEND_WAIT = { waitMs: 900, defaultMs: 900, overridden: false, sendPhrases: ['go maestro'] };

function session(overrides: Partial<VoiceSessionView> = {}): VoiceSessionView {
	return {
		sessionId: 'voice-1',
		state: 'listening',
		scope: { kind: 'conductor' },
		origin: { kind: 'local' },
		windowId: 'window-1',
		listenPaused: false,
		startedAt: 1,
		providerIds: { stt: 'parakeet-local', tts: 'system-tts', brain: 'mock-brain' },
		...overrides,
	};
}

interface Sent {
	request: VoiceControlRequest;
	timeout?: number;
}

/**
 * Answer each `voice_control` request from `reply`, and any other bridge
 * message from `other`, recording the voice requests that were sent.
 */
function mockBridge(
	reply: (request: VoiceControlRequest) => VoiceControlReply,
	other: (payload: Record<string, unknown>) => Record<string, unknown> = () => ({ success: true })
) {
	const sent: Sent[] = [];
	const messages: Array<Record<string, unknown>> = [];
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi
				.fn()
				.mockImplementation(
					(payload: Record<string, unknown>, responseType: string, timeout?: number) => {
						messages.push(payload);
						if (payload.type !== 'voice_control') return Promise.resolve(other(payload));
						expect(responseType).toBe('voice_control_result');
						const request = payload.request as VoiceControlRequest;
						sent.push({ request, timeout });
						return Promise.resolve({ success: true, reply: reply(request) });
					}
				),
		} as never)
	);
	return { sent, messages };
}

/** A reply that answers every action with the same result. */
const ok = (result: unknown): VoiceControlReply => ({ ok: true, result }) as VoiceControlReply;

describe('voice commands', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	const printed = () => logSpy.mock.calls.map(([line]) => String(line)).join('\n');
	const errors = () => errorSpy.mock.calls.map(([line]) => String(line)).join('\n');
	const json = () => JSON.parse(String(logSpy.mock.calls[0][0]));

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(readSettingValue).mockReturnValue(undefined);
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
			throw new Error(`exit:${code}`);
		}) as never);
	});

	describe('status', () => {
		const status = {
			enabled: true,
			session: session(),
			readiness: {
				canStartSession: true,
				canRunHandsFree: false,
				slots: [{ slot: 'stt', providerId: 'parakeet-local', satisfied: true }],
				blocking: [],
			},
			sendWait: SEND_WAIT,
		};

		it('prints the status whole under --json', async () => {
			const { sent } = mockBridge(() => ok(status));
			await voiceStatus({ json: true });

			expect(sent.map((entry) => entry.request)).toEqual([{ action: 'status' }]);
			expect(json()).toEqual({ success: true, ...status });
		});

		it('says what is live and whether a session can start', () => {
			const text = formatVoiceStatus(status as never);
			expect(text).toContain('A Cappella: on');
			expect(text).toContain('Session: listening, talking to the Conductor, microphone open');
			expect(text).toContain('Engines: parakeet-local / mock-brain / system-tts');
			expect(text).toContain('or say: go maestro');
			expect(text).toContain('Ready: a session can start');
			expect(text).toContain('Hands-free: the wake word cannot run');
		});

		it('reads an idle snapshot as no session', () => {
			expect(describeVoiceSession(session({ state: 'idle' }))).toBe('no session');
			expect(describeVoiceSession(null)).toBe('no session');
		});

		it('says so when voice is switched off, without a readiness block', () => {
			const text = formatVoiceStatus({
				enabled: false,
				session: null,
				readiness: null,
				sendWait: SEND_WAIT,
			});
			expect(text).toContain('A Cappella: off');
			expect(text).not.toContain('Ready');
		});
	});

	describe('describeVoiceScope', () => {
		it('names the agent, the tab and the document a scope is bound to', () => {
			expect(describeVoiceScope({ kind: 'conductor' })).toBe('the Conductor');
			expect(describeVoiceScope({ kind: 'agent', sessionId: 'agent-scout' })).toBe(
				'agent Scout (agent-scout)'
			);
			expect(describeVoiceScope({ kind: 'agent', sessionId: 'agent-x', tabId: 'tab-1' })).toBe(
				'tab tab-1 of agent-x'
			);
			expect(
				describeVoiceScope({ kind: 'document', sessionId: 'agent-scout', path: '/notes/plan.md' })
			).toBe('document /notes/plan.md, with Scout (agent-scout)');
		});

		it('names Quick Chat, and that the session cannot be re-aimed', () => {
			expect(describeVoiceScope({ kind: 'quick-chat' })).toBe('Quick Chat (locked)');
		});
	});

	describe('start', () => {
		const started = { session: session(), substitutions: [] };

		it('starts on the Conductor when no scope is named', async () => {
			const { sent } = mockBridge(() => ok(started));
			await voiceStart({});

			expect(sent[0].request).toEqual({
				action: 'start',
				scope: { kind: 'conductor' },
				paused: false,
			});
			expect(printed()).toContain('Voice session started');
		});

		it('binds an agent, resolved the way every agent flag is', async () => {
			const { sent } = mockBridge(() => ok(started));
			await voiceStart({ agent: 'scout', paused: true });

			expect(sent[0].request).toEqual({
				action: 'start',
				scope: { kind: 'agent', sessionId: 'agent-scout' },
				paused: true,
			});
		});

		it('binds one tab, looked up in the open tabs of the app', async () => {
			const { sent } = mockBridge(
				() => ok(started),
				() => ({ sessions: [{ agentId: 'agent-scout', tabId: 'tab-123', active: true }] })
			);
			await voiceStart({ tab: 'tab-1' });

			expect(sent[0].request).toMatchObject({
				scope: { kind: 'agent', sessionId: 'agent-scout', tabId: 'tab-123' },
			});
		});

		it('binds a document to the agent it is discussed with, as an absolute path', async () => {
			const { sent } = mockBridge(() => ok(started));
			await voiceStart({ agent: 'scout', document: 'notes/plan.md' });

			expect(sent[0].request).toMatchObject({
				scope: {
					kind: 'document',
					sessionId: 'agent-scout',
					path: path.resolve('notes/plan.md'),
				},
			});
		});

		it('binds Quick Chat with --quick-chat, naming no agent or tab', async () => {
			const { sent } = mockBridge(() => ok(started));
			await voiceStart({ quickChat: true });

			expect(sent[0].request).toEqual({
				action: 'start',
				scope: { kind: 'quick-chat' },
				paused: false,
			});
		});

		it('refuses --quick-chat beside any other scope flag', async () => {
			// Quick Chat picks its own agent and tab, so a second flag would be one
			// the session ignores.
			mockBridge(() => ok(started));

			for (const options of [
				{ quickChat: true, agent: 'scout' },
				{ quickChat: true, tab: 'tab-1' },
				{ quickChat: true, document: 'plan.md' },
				{ quickChat: true, conductor: true },
			]) {
				await expect(voiceStart(options)).rejects.toThrow(`exit:${ExitCode.InvalidUsage}`);
			}
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('refuses a document with no agent, and --conductor beside a named scope', async () => {
			mockBridge(() => ok(started));

			await expect(voiceStart({ document: 'plan.md' })).rejects.toThrow(
				`exit:${ExitCode.InvalidUsage}`
			);
			await expect(voiceStart({ conductor: true, agent: 'scout' })).rejects.toThrow(
				`exit:${ExitCode.InvalidUsage}`
			);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('exits with the reason when an agent does not resolve', async () => {
			mockBridge(() => ok(started));
			await expect(voiceStart({ agent: 'ghost' })).rejects.toThrow('exit:1');
			expect(errors()).toContain('Agent not found: ghost');
		});

		it('exits non-zero with the reason the app refused the start', async () => {
			mockBridge(() => ({ ok: false, reason: 'Speech-to-Text needs a model.' }));

			await expect(voiceStart({ json: true })).rejects.toThrow('exit:1');
			expect(json()).toEqual({ success: false, error: 'Speech-to-Text needs a model.' });
		});

		it('prints a provider the session is running in place of the one asked for', async () => {
			mockBridge(() =>
				ok({
					session: session(),
					substitutions: [
						{
							role: 'tts',
							requestedId: 'kokoro-local',
							resolvedId: 'system-tts',
							reason: 'missing-model',
							message: 'Kokoro is not installed, so the system voice speaks.',
						},
					],
				})
			);
			await voiceStart({});
			expect(printed()).toContain('Kokoro is not installed, so the system voice speaks.');
		});
	});

	describe('the HUD controls', () => {
		it('sends one request per control', async () => {
			const { sent } = mockBridge((request) => {
				switch (request.action) {
					case 'listen':
						return ok({ applied: true, listening: request.listening });
					case 'stop-reply':
						return ok({ interrupted: true });
					default:
						return ok({ session: session() });
				}
			});

			await voiceStop({});
			await voiceListen('on', {});
			await voiceListen('off', { send: true });
			await voiceSend({});
			await voiceStopReply({});

			expect(sent.map((entry) => entry.request)).toEqual([
				{ action: 'stop' },
				{ action: 'listen', listening: true, send: false },
				{ action: 'listen', listening: false, send: true },
				{ action: 'send' },
				{ action: 'stop-reply' },
			]);
		});

		it('refuses a listen word that is not on or off, and --send with on', async () => {
			mockBridge(() => ok({ applied: true, listening: true }));

			await expect(voiceListen('maybe', {})).rejects.toThrow(`exit:${ExitCode.InvalidUsage}`);
			await expect(voiceListen('on', { send: true })).rejects.toThrow(
				`exit:${ExitCode.InvalidUsage}`
			);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('says there is no session when a control had nothing to act on', async () => {
			mockBridge((request) =>
				request.action === 'listen'
					? ok({ applied: false, listening: true })
					: ok({ session: session({ state: 'idle' }) })
			);

			await expect(voiceListen('on', {})).rejects.toThrow('exit:1');
			await expect(voiceSend({})).rejects.toThrow('exit:1');
			expect(errors()).toContain('No voice session is live');
		});

		it('reports a reply that was not playing without failing', async () => {
			mockBridge(() => ok({ interrupted: false }));
			await voiceStopReply({});
			expect(printed()).toContain('Nothing was being spoken.');
			expect(exitSpy).not.toHaveBeenCalled();
		});
	});

	describe('scope', () => {
		const applied = (request: VoiceControlRequest) =>
			request.action === 'scope' ? ok({ applied: true, scope: request.scope }) : ok({});

		it('re-aims the session at the Conductor, an agent, or a tab', async () => {
			const { sent } = mockBridge(applied, () => ({
				sessions: [{ agentId: 'agent-active', tabId: 'tab-9', active: true }],
			}));

			await voiceScope('conductor', {});
			await voiceScope('agent', { agent: 'scout' });
			await voiceScope('agent', {});
			await voiceScope('tab', {});

			expect(sent.map((entry) => entry.request)).toEqual([
				{ action: 'scope', scope: { kind: 'conductor' } },
				{ action: 'scope', scope: { kind: 'agent', sessionId: 'agent-scout' } },
				// No --agent: the agent the desktop has focused.
				{ action: 'scope', scope: { kind: 'agent', sessionId: 'agent-active' } },
				// No --tab: that agent's selected tab.
				{ action: 'scope', scope: { kind: 'agent', sessionId: 'agent-active', tabId: 'tab-9' } },
			]);
		});

		it('refuses a mode that is not one of the three', async () => {
			mockBridge(applied);
			await expect(voiceScope('everyone', {})).rejects.toThrow(`exit:${ExitCode.InvalidUsage}`);
		});

		it('says there is no session when there was nothing to re-aim', async () => {
			mockBridge(() => ok({ applied: false, scope: { kind: 'conductor' } }));
			await expect(voiceScope('conductor', {})).rejects.toThrow('exit:1');
			expect(errors()).toContain('No voice session is live');
		});

		it('prints the reason a Quick Chat session gives for staying where it is', async () => {
			mockBridge(() => ({
				ok: false,
				reason: 'This voice session is locked to Quick Chat. End it to talk somewhere else.',
			}));
			await expect(voiceScope('conductor', {})).rejects.toThrow('exit:1');
			expect(errors()).toContain('locked to Quick Chat');
			expect(errors()).not.toContain('No voice session is live');
		});
	});

	describe('wait', () => {
		it('reads the wait in force when no value is given', async () => {
			const { sent } = mockBridge(() =>
				ok({ enabled: true, session: null, readiness: null, sendWait: SEND_WAIT })
			);
			await voiceWait(undefined, { json: true });

			expect(sent[0].request).toEqual({ action: 'status' });
			expect(json()).toEqual({ success: true, ...SEND_WAIT });
		});

		it('sets a wait for this conversation, and "default" clears it', async () => {
			const { sent } = mockBridge(() => ok({ ...SEND_WAIT, waitMs: 2000, overridden: true }));
			await voiceWait('2000', {});
			await voiceWait('default', {});

			expect(sent.map((entry) => entry.request)).toEqual([
				{ action: 'wait', waitMs: 2000 },
				{ action: 'wait', waitMs: null },
			]);
		});

		it('refuses a wait outside the range the HUD slider has', async () => {
			mockBridge(() => ok(SEND_WAIT));
			await expect(voiceWait('999999999', {})).rejects.toThrow(`exit:${ExitCode.InvalidUsage}`);
			await expect(voiceWait('soon', {})).rejects.toThrow(`exit:${ExitCode.InvalidUsage}`);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});
	});

	describe('volume', () => {
		it('saves the volume and applies it to what is playing', async () => {
			const { sent } = mockBridge(() => ok({ applied: true, volume: 0.5 }));
			await voiceVolume('0.5', { json: true });

			expect(writeSettingValue).toHaveBeenCalledWith('acappella.voice.volume', 0.5);
			expect(sent[0].request).toEqual({ action: 'volume', volume: 0.5 });
			expect(json()).toEqual({ success: true, applied: true, volume: 0.5, saved: true });
		});

		it('refuses a volume the slider cannot reach, and saves nothing', async () => {
			mockBridge(() => ok({ applied: true, volume: 0 }));
			await expect(voiceVolume('0', {})).rejects.toThrow(`exit:${ExitCode.InvalidUsage}`);
			await expect(voiceVolume('loud', {})).rejects.toThrow(`exit:${ExitCode.InvalidUsage}`);
			expect(writeSettingValue).not.toHaveBeenCalled();
		});

		it('mutes without saving, like the HUD button', async () => {
			const { sent } = mockBridge(() => ok({ applied: true, volume: 0 }));
			await voiceMute({});

			expect(sent[0].request).toEqual({ action: 'volume', volume: 0 });
			expect(writeSettingValue).not.toHaveBeenCalled();
		});

		it('unmutes to the saved volume, or to full when none was saved', async () => {
			const { sent } = mockBridge(() => ok({ applied: true, volume: 1 }));
			await voiceUnmute({});
			vi.mocked(readSettingValue).mockReturnValue(0.4);
			await voiceUnmute({});

			expect(sent.map((entry) => entry.request)).toEqual([
				{ action: 'volume', volume: 1 },
				{ action: 'volume', volume: 0.4 },
			]);
		});

		it('says when nothing was playing to apply it to', async () => {
			mockBridge(() => ok({ applied: false, volume: 0.5 }));
			await voiceVolume('0.5', {});
			expect(printed()).toContain('Nothing is playing now');
		});
	});

	describe('input', () => {
		const inputs = {
			devices: [{ deviceId: 'mic-1', label: 'Desk Mic' }],
			selectedId: ACAPPELLA_SYSTEM_DEFAULT_INPUT,
		};

		it('lists the microphones and marks the one selected', async () => {
			mockBridge(() => ok(inputs));
			await voiceInputList({});

			expect(printed()).toContain('* default');
			expect(printed()).toContain('  mic-1  Desk Mic');
		});

		it('explains an empty list instead of printing nothing', async () => {
			mockBridge(() => ok({ devices: [], selectedId: ACAPPELLA_SYSTEM_DEFAULT_INPUT }));
			await voiceInputList({});
			expect(printed()).toContain('No microphones are listed yet');
		});

		it('sends the system default as the sentinel the app stores as no preference', async () => {
			const { sent } = mockBridge(() => ok({ selectedId: ACAPPELLA_SYSTEM_DEFAULT_INPUT }));
			await voiceInputSet('default', {});

			expect(sent.map((entry) => entry.request)).toEqual([
				{ action: 'set-input', deviceId: ACAPPELLA_SYSTEM_DEFAULT_INPUT },
			]);
		});

		it('chooses a microphone the app has seen', async () => {
			const { sent } = mockBridge((request) =>
				request.action === 'inputs' ? ok(inputs) : ok({ selectedId: 'mic-1' })
			);
			await voiceInputSet('mic-1', {});

			expect(sent.map((entry) => entry.request)).toEqual([
				{ action: 'inputs' },
				{ action: 'set-input', deviceId: 'mic-1' },
			]);
		});

		it('refuses an id the app has not seen, and sets nothing', async () => {
			const { sent } = mockBridge(() => ok(inputs));
			await expect(voiceInputSet('mic-9', {})).rejects.toThrow(`exit:${ExitCode.InvalidUsage}`);
			expect(sent.map((entry) => entry.request.action)).toEqual(['inputs']);
		});
	});

	describe('latency', () => {
		it('prints the breakdown the app formatted', async () => {
			mockBridge(() =>
				ok({ turn: { turnId: 't1' }, text: 'cascade: a / b / c\n  Total turn: 2s' })
			);
			await voiceLatency({});
			expect(printed()).toContain('Total turn: 2s');
		});

		it('says so when no turn has finished yet', async () => {
			mockBridge(() => ok({ turn: null, text: null }));
			await voiceLatency({});
			expect(printed()).toContain('No voice turn has finished');
		});
	});

	describe('setup', () => {
		const set = MODEL_SETS['hands-free-local'];
		const listing = (id: string, status: string) => ({
			entry: { id, displayName: `Model ${id}`, bytes: 1000 },
			status: { status },
			installPaths: [],
		});

		it('reads the bundle and downloads nothing without --download', async () => {
			const { messages } = mockBridge(
				() => ok({}),
				(payload) =>
					payload.type === 'local_models_list'
						? {
								success: true,
								listings: [
									...set.modelIds.map((id) => listing(id, 'not-installed')),
									listing('some-other-model', 'installed'),
								],
							}
						: { success: true }
			);
			await voiceSetup({ json: true });

			expect(messages.map((message) => message.type)).toEqual(['local_models_list']);
			const out = json();
			expect(out.ready).toBe(false);
			// Only the bundle's models, never the rest of the Library.
			expect(out.models.map((model: { modelId: string }) => model.modelId).sort()).toEqual(
				[...set.modelIds].sort()
			);
		});

		it('downloads only what is missing when asked to', async () => {
			const [first, ...rest] = set.modelIds;
			const { messages } = mockBridge(
				() => ok({}),
				(payload) =>
					payload.type === 'local_models_list'
						? {
								success: true,
								listings: [
									listing(first, 'installed'),
									...rest.map((id) => listing(id, 'not-installed')),
								],
							}
						: { success: true, result: { status: 'complete', runtime: { status: 'ready' } } }
			);
			await voiceSetup({ download: true, json: true });

			const downloads = messages.filter((message) => message.type === 'local_models_download');
			expect(downloads.map((message) => message.modelId)).toEqual(rest);
		});

		it('exits non-zero and names the model when a download fails', async () => {
			mockBridge(
				() => ok({}),
				(payload) =>
					payload.type === 'local_models_list'
						? { success: true, listings: set.modelIds.map((id) => listing(id, 'not-installed')) }
						: { success: true, result: { status: 'error', error: 'disk full' } }
			);

			await expect(voiceSetup({ download: true, json: true })).rejects.toThrow('exit:1');
			const out = json();
			expect(out.success).toBe(false);
			expect(out.failures[0]).toEqual({ modelId: set.modelIds[0], error: 'disk full' });
		});
	});

	describe('wake test', () => {
		it('runs for the time asked and reports how often the phrase fired', async () => {
			const { sent } = mockBridge(() =>
				ok({
					phrase: 'hey scout',
					seconds: 5,
					hits: [
						{ phrase: 'hey scout', score: 0.81, at: 1 },
						{ phrase: 'hey scout', score: 0.92, at: 2 },
					],
				})
			);
			await voiceWakeTest(' hey scout ', { seconds: '5', sensitivity: '0.7' });

			expect(sent[0].request).toEqual({
				action: 'wake-test',
				seconds: 5,
				phrase: 'hey scout',
				sensitivity: 0.7,
			});
			// The app answers when the run ends, so the wait outlasts the run.
			expect(sent[0].timeout).toBeGreaterThan(5000);
			expect(printed()).toContain('"hey scout" fired 2 times in 5 s (best score 0.92)');
		});

		it('says the phrase did not fire, without failing', async () => {
			mockBridge(() => ok({ phrase: 'hey scout', seconds: 10, hits: [] }));
			await voiceWakeTest(undefined, {});
			expect(printed()).toContain('"hey scout" did not fire in 10 s');
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('refuses a time or a sensitivity outside its range', async () => {
			mockBridge(() => ok({ phrase: null, seconds: 10, hits: [] }));
			await expect(voiceWakeTest(undefined, { seconds: '600' })).rejects.toThrow(
				`exit:${ExitCode.InvalidUsage}`
			);
			await expect(voiceWakeTest(undefined, { sensitivity: '2' })).rejects.toThrow(
				`exit:${ExitCode.InvalidUsage}`
			);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});
	});
});
