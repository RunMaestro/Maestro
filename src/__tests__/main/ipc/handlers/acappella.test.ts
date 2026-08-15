/**
 * @file acappella.test.ts
 *
 * Unit tests for the A Cappella IPC transport.
 *
 * Contracts defended:
 * - Registering the handlers builds NOTHING. Enabling the Encore Feature must
 *   not open a device or construct a provider, so the service appears only on
 *   the first start-session.
 * - The Encore gate rejects every channel with 'ACappellaDisabled' while the
 *   flag is off - except stop-session, which has to stay callable so toggling
 *   the feature off mid-session can still release the floor.
 * - Every protocol event is broadcast on `acappella:event` exactly once.
 * - A provider-selection change rebuilds the service; an unchanged one reuses
 *   it, so the fan-out is never registered twice.
 * - Untrusted payloads are validated at the boundary: a malformed agent scope is
 *   an error rather than a silent fall back to whichever agent is active.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { app, ipcMain, shell } from 'electron';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn(), on: vi.fn() },
	app: { on: vi.fn() },
	shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
}));

/**
 * The audio host window is a real `BrowserWindow` in production. Here it is a
 * webContents stand-in that records commands, plus a sender predicate a test can
 * flip: "only the audio host may push PCM" is enforced at this boundary, so it
 * has to be possible to fail it.
 */
const audioHost = vi.hoisted(() => ({
	webContents: { send: vi.fn(), isDestroyed: () => false },
	isHostContents: true,
}));

vi.mock('../../../../main/acappella/audio-host-window', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../../main/acappella/audio-host-window')>();
	return {
		...actual,
		ensureAcappellaAudioHostWindow: vi.fn(() => audioHost),
		closeAcappellaAudioHostWindow: vi.fn(),
		getAcappellaAudioHostWindow: vi.fn(() => audioHost),
		isAcappellaAudioHostContents: vi.fn(() => audioHost.isHostContents),
	};
});
vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/utils/safe-send', () => ({
	isWebContentsAvailable: (win: unknown) => !!win,
}));
vi.mock('../../../../main/web-server/callbacks/remoteRequest', () => ({
	requestFromRenderer: vi.fn(),
}));
vi.mock('../../../../main/stores/getters', () => ({
	getSessionsStore: vi.fn(),
}));

import { getSessionsStore } from '../../../../main/stores/getters';
import {
	disposeACappellaAudioBridge,
	registerACappellaHandlers,
	resetACappellaHandlerState,
	type VoiceStartSessionResult,
} from '../../../../main/ipc/handlers/acappella';
import {
	ACAPPELLA_AUDIO_FRAME_CHANNEL,
	ACAPPELLA_AUDIO_FRAME_SAMPLES,
	ACAPPELLA_AUDIO_SAMPLE_RATE,
	ACAPPELLA_AUDIO_STATUS_CHANNEL,
	type AudioFrame,
	type AudioHostCommand,
	type AudioHostStatus,
} from '../../../../shared/acappella/audio-host';
import { ECHO_STT_PROVIDER_ID } from '../../../../main/acappella/providers/echo-stt';
import { disposeVoiceSessionService, getVoiceSessionService } from '../../../../main/acappella';
import type { RosterAgent, VoiceEvent } from '../../../../shared/acappella/protocol';
import type { VoiceSessionSnapshot } from '../../../../main/acappella';
import type { StoredSession } from '../../../../main/stores/types';
import { createMockSession } from '../../../helpers/mockSession';
import { createMockAITab } from '../../../helpers/mockTab';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

/** Settings the gate and the provider registry both read. */
interface FakeSettings {
	encoreFeatures?: Record<string, unknown>;
	acappella?: { providers?: Record<string, string> };
}

let settings: FakeSettings;
let broadcasts: Array<{ channel: string; args: unknown[] }>;
let sessions: StoredSession[];

const settingsStore = {
	get: (key: string, defaultValue?: unknown) =>
		(settings as Record<string, unknown>)[key] ?? defaultValue,
};

const safeSend = vi.fn((channel: string, ...args: unknown[]) => {
	broadcasts.push({ channel, args });
});

/** A window stand-in - the executor only ever checks it is alive and sends. */
const fakeWindow = { webContents: { send: vi.fn() } };

function handlerFor(channel: string): Handler {
	const registration = vi
		.mocked(ipcMain.handle)
		.mock.calls.find(([registered]) => registered === channel);
	expect(registration, `no handler registered for ${channel}`).toBeDefined();
	return registration?.[1] as unknown as Handler;
}

function voiceEvents(): VoiceEvent[] {
	return broadcasts
		.filter((entry) => entry.channel === 'acappella:event')
		.map((entry) => entry.args[0] as VoiceEvent);
}

function register(options: { withAudio?: boolean } = {}): void {
	registerACappellaHandlers({
		settingsStore,
		getMainWindow: () => fakeWindow as never,
		safeSend: safeSend as never,
		// Absent by default, exactly as in a test process with no window: the
		// session still runs, it is simply text-in.
		audioHostDeps: options.withAudio ? ({} as never) : undefined,
	});
}

/** The `ipcMain.on` listener for one of the audio host's two channels. */
function listenerFor(channel: string): (event: unknown, payload: unknown) => void {
	const registration = vi.mocked(ipcMain.on).mock.calls.find(([name]) => name === channel);
	expect(registration, `no listener registered for ${channel}`).toBeDefined();
	return registration?.[1] as unknown as (event: unknown, payload: unknown) => void;
}

/** Commands pushed to the audio host renderer, in order. */
function audioCommands(): AudioHostCommand[] {
	return vi
		.mocked(audioHost.webContents.send)
		.mock.calls.map(([, command]) => command as AudioHostCommand);
}

beforeEach(async () => {
	vi.clearAllMocks();
	await disposeVoiceSessionService();
	resetACappellaHandlerState();

	settings = { encoreFeatures: { aCappella: true } };
	broadcasts = [];
	sessions = [
		createMockSession({
			id: 'agent-backend',
			name: 'Backend',
			toolType: 'claude-code',
			cwd: '/repo/api',
			activeTabId: 'tab-auth',
			aiTabs: [createMockAITab({ id: 'tab-auth', name: 'Auth Refactor', createdAt: 1_000 })],
		} as never) as unknown as StoredSession,
	];

	vi.mocked(getSessionsStore).mockReturnValue({
		get: (key: string, fallback?: unknown) => (key === 'sessions' ? sessions : fallback),
	} as never);

	register();
});

afterEach(async () => {
	await disposeVoiceSessionService();
	resetACappellaHandlerState();
});

// ---------------------------------------------------------------------------
// Registration and laziness
// ---------------------------------------------------------------------------

describe('A Cappella IPC handlers - registration', () => {
	it('registers every documented channel', () => {
		const channels = vi.mocked(ipcMain.handle).mock.calls.map(([channel]) => channel);
		expect(channels).toEqual(
			expect.arrayContaining([
				'acappella:start-session',
				'acappella:stop-session',
				'acappella:submit-utterance',
				'acappella:interrupt',
				'acappella:stop-word',
				'acappella:get-roster',
				'acappella:get-state',
				'acappella:open-mic-settings',
			])
		);
	});

	it('builds no session service until a session is started', async () => {
		expect(getVoiceSessionService()).toBeNull();
		expect(await handlerFor('acappella:get-state')({})).toBeNull();
		expect(getVoiceSessionService()).toBeNull();

		await handlerFor('acappella:start-session')({});
		expect(getVoiceSessionService()).not.toBeNull();
	});

	it('disposes the live session on app quit', async () => {
		await handlerFor('acappella:start-session')({});
		expect(getVoiceSessionService()).not.toBeNull();

		// `app.on` is a union of ~40 per-event overloads, so the mock's call tuples
		// narrow to the first one. Widen them before looking for our event.
		const lifecycleCalls = vi.mocked(app.on).mock.calls as unknown as Array<[string, () => void]>;
		const willQuit = lifecycleCalls.find(([event]) => event === 'will-quit')?.[1];
		expect(willQuit, 'no will-quit listener registered').toBeDefined();

		willQuit?.();
		// The dispose is fire-and-forget from a synchronous lifecycle hook, so the
		// singleton is cleared on the next tick rather than inline.
		await vi.waitFor(() => expect(getVoiceSessionService()).toBeNull());
	});
});

// ---------------------------------------------------------------------------
// Encore gate
// ---------------------------------------------------------------------------

describe('A Cappella IPC handlers - Encore gate', () => {
	beforeEach(() => {
		settings.encoreFeatures = { aCappella: false };
	});

	it.each([
		['acappella:start-session'],
		['acappella:submit-utterance'],
		['acappella:interrupt'],
		['acappella:stop-word'],
		['acappella:get-roster'],
		['acappella:get-state'],
	])('%s rejects with ACappellaDisabled while the flag is off', async (channel) => {
		await expect(handlerFor(channel)({}, 'anything')).rejects.toThrow('ACappellaDisabled');
	});

	it('still allows stop-session so a live session can be released', async () => {
		settings.encoreFeatures = { aCappella: true };
		await handlerFor('acappella:start-session')({});
		settings.encoreFeatures = { aCappella: false };

		await expect(handlerFor('acappella:stop-session')({})).resolves.toBeUndefined();
		expect(getVoiceSessionService()?.getState()).toBe('idle');
	});

	it('treats a missing encoreFeatures key as off', async () => {
		settings = {};
		await expect(handlerFor('acappella:get-state')({})).rejects.toThrow('ACappellaDisabled');
	});

	it('still allows open-mic-settings, the one recovery for a denied microphone', async () => {
		// The value depends on the host platform; what matters is that the gate does
		// not reject it, since a denied microphone is exactly the situation in which
		// the feature may already have been switched back off.
		await expect(handlerFor('acappella:open-mic-settings')({})).resolves.toEqual(
			expect.any(Boolean)
		);
	});
});

// ---------------------------------------------------------------------------
// Microphone settings
// ---------------------------------------------------------------------------

describe('A Cappella IPC handlers - open-mic-settings', () => {
	const realPlatform = process.platform;

	function setPlatform(platform: string): void {
		Object.defineProperty(process, 'platform', { value: platform, configurable: true });
	}

	afterEach(() => {
		setPlatform(realPlatform);
	});

	it.each([
		['darwin', 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'],
		['win32', 'ms-settings:privacy-microphone'],
	])('opens the %s privacy pane', async (platform, url) => {
		setPlatform(platform);
		await expect(handlerFor('acappella:open-mic-settings')({})).resolves.toBe(true);
		expect(shell.openExternal).toHaveBeenCalledWith(url);
	});

	it('reports false and opens nothing where no deep link exists', async () => {
		setPlatform('linux');
		await expect(handlerFor('acappella:open-mic-settings')({})).resolves.toBe(false);
		expect(shell.openExternal).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

describe('A Cappella IPC handlers - session lifecycle', () => {
	it('starts a conductor session and reports the mock trio with no substitutions', async () => {
		const result = (await handlerFor('acappella:start-session')({})) as VoiceStartSessionResult;

		expect(result.snapshot.state).toBe('listening');
		expect(result.snapshot.scope).toEqual({ kind: 'conductor' });
		expect(result.snapshot.providerIds).toEqual({
			stt: 'mock-stt',
			tts: 'mock-tts',
			brain: 'mock-brain',
		});
		// Not configuring a provider is the documented default, not a downgrade.
		expect(result.substitutions).toEqual([]);
	});

	it('reports a substitution when the configured provider is unknown', async () => {
		settings.acappella = { providers: { stt: 'whisper-local' } };

		const result = (await handlerFor('acappella:start-session')({})) as VoiceStartSessionResult;

		expect(result.substitutions).toHaveLength(1);
		expect(result.substitutions[0]).toMatchObject({
			role: 'stt',
			requestedId: 'whisper-local',
			resolvedId: 'mock-stt',
			reason: 'unknown-provider',
		});
		expect(result.snapshot.providerIds.stt).toBe('mock-stt');
	});

	it('binds an agent scope when one is given', async () => {
		const result = (await handlerFor('acappella:start-session')(
			{},
			{
				kind: 'agent',
				sessionId: 'agent-backend',
			}
		)) as VoiceStartSessionResult;

		expect(result.snapshot.scope).toEqual({ kind: 'agent', sessionId: 'agent-backend' });
	});

	it('rejects an agent scope with no agent id rather than guessing one', async () => {
		await expect(handlerFor('acappella:start-session')({}, { kind: 'agent' })).rejects.toThrow(
			'InvalidVoiceScope'
		);
		expect(getVoiceSessionService()).toBeNull();
	});

	it('returns a live snapshot from get-state once started', async () => {
		await handlerFor('acappella:start-session')({});

		const snapshot = (await handlerFor('acappella:get-state')({})) as VoiceSessionSnapshot;
		expect(snapshot.state).toBe('listening');
		expect(snapshot.sessionId).toEqual(expect.any(String));
		expect(snapshot.seq).toBeGreaterThan(0);
	});

	it('stop-session returns the session to idle', async () => {
		await handlerFor('acappella:start-session')({});
		await handlerFor('acappella:stop-session')({});

		const snapshot = (await handlerFor('acappella:get-state')({})) as VoiceSessionSnapshot;
		expect(snapshot.state).toBe('idle');
		expect(snapshot.sessionId).toBeNull();
	});

	it('stop-session with no service is a no-op', async () => {
		await expect(handlerFor('acappella:stop-session')({})).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Event fan-out
// ---------------------------------------------------------------------------

describe('A Cappella IPC handlers - event fan-out', () => {
	it('broadcasts every protocol event once on acappella:event', async () => {
		await handlerFor('acappella:start-session')({});

		const types = voiceEvents().map((event) => event.type);
		expect(types).toEqual(['wake', 'listen-start', 'agent-roster']);
		expect(voiceEvents().map((event) => event.seq)).toEqual([1, 2, 3]);
	});

	it('reuses the service across starts, so the fan-out is registered once', async () => {
		await handlerFor('acappella:start-session')({});
		const first = getVoiceSessionService();
		broadcasts = [];

		await handlerFor('acappella:start-session')({});

		expect(getVoiceSessionService()).toBe(first);
		// One wake per start, not two: a second subscriber would double every event.
		expect(voiceEvents().filter((event) => event.type === 'wake')).toHaveLength(1);
	});

	it('rebuilds the service when the provider selection changed', async () => {
		await handlerFor('acappella:start-session')({});
		const first = getVoiceSessionService();

		settings.acappella = { providers: { stt: 'whisper-local' } };
		const result = (await handlerFor('acappella:start-session')({})) as VoiceStartSessionResult;

		expect(getVoiceSessionService()).not.toBe(first);
		expect(result.substitutions).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Input channels
// ---------------------------------------------------------------------------

describe('A Cappella IPC handlers - input', () => {
	it('accepts an utterance while listening', async () => {
		await handlerFor('acappella:start-session')({});

		await expect(handlerFor('acappella:submit-utterance')({}, 'hello there')).resolves.toBe(true);

		// Release the mock STT's pending partial timers.
		await handlerFor('acappella:stop-session')({});
	});

	it('rejects a non-string utterance at the boundary', async () => {
		await handlerFor('acappella:start-session')({});

		await expect(handlerFor('acappella:submit-utterance')({}, 42)).rejects.toThrow(
			'InvalidUtterance'
		);
	});

	it('reports false for an utterance with no session', async () => {
		await expect(handlerFor('acappella:submit-utterance')({}, 'hello')).resolves.toBe(false);
	});

	it('reports false for an interrupt when nothing is speaking', async () => {
		await handlerFor('acappella:start-session')({});
		await expect(handlerFor('acappella:interrupt')({}, 'client-button')).resolves.toBe(false);
	});

	it('stop-word ends the session and is distinct from barge-in', async () => {
		await handlerFor('acappella:start-session')({});
		broadcasts = [];

		await handlerFor('acappella:stop-word')({}, { phrase: 'never mind', source: 'voice' });

		const types = voiceEvents().map((event) => event.type);
		expect(types).toContain('stop-word');
		expect(types).not.toContain('barge-in');
		expect(getVoiceSessionService()?.getState()).toBe('idle');
	});

	it('stop-word with no payload is still accepted', async () => {
		await handlerFor('acappella:start-session')({});
		await expect(handlerFor('acappella:stop-word')({})).resolves.toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Audio host transport
// ---------------------------------------------------------------------------

describe('A Cappella IPC handlers - audio host transport', () => {
	let nodeEnv: string | undefined;

	/** One 20 ms frame of 200 Hz tone: voiced, and inside the detector's ZCR band. */
	function toneFrame(seq: number): AudioFrame {
		const samples = new Int16Array(ACAPPELLA_AUDIO_FRAME_SAMPLES);
		for (let i = 0; i < samples.length; i++) {
			samples[i] = 0.4 * Math.sin((2 * Math.PI * 200 * i) / ACAPPELLA_AUDIO_SAMPLE_RATE) * 0x7fff;
		}
		return { seq, capturedAt: 1_000 + seq * 20, rms: 0.28, pcm: samples.buffer };
	}

	function pushStatus(status: AudioHostStatus): void {
		listenerFor(ACAPPELLA_AUDIO_STATUS_CHANNEL)({ sender: audioHost.webContents }, status);
	}

	function pushFrames(count: number): void {
		const listener = listenerFor(ACAPPELLA_AUDIO_FRAME_CHANNEL);
		for (let seq = 1; seq <= count; seq++) {
			listener({ sender: audioHost.webContents }, toneFrame(seq));
		}
	}

	beforeEach(async () => {
		// The echo provider is the development default and the only registered STT
		// that consumes audio, so the whole capture path hangs off this flag.
		nodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = 'development';
		settings.acappella = { providers: { stt: ECHO_STT_PROVIDER_ID } };

		vi.clearAllMocks();
		await disposeVoiceSessionService();
		resetACappellaHandlerState();
		audioHost.isHostContents = true;
		register({ withAudio: true });
	});

	afterEach(() => {
		process.env.NODE_ENV = nodeEnv;
	});

	it('registers the two host channels as sends, not invokes', () => {
		const channels = vi.mocked(ipcMain.on).mock.calls.map(([channel]) => channel);
		expect(channels).toEqual(
			expect.arrayContaining([ACAPPELLA_AUDIO_FRAME_CHANNEL, ACAPPELLA_AUDIO_STATUS_CHANNEL])
		);
	});

	it('opens the microphone once the host reports ready', async () => {
		await handlerFor('acappella:start-session')({});
		pushStatus({ kind: 'ready' });

		expect(audioCommands().map((command) => command.kind)).toContain('start-capture');
	});

	it('turns captured frames into meter events on the one ordered stream', async () => {
		await handlerFor('acappella:start-session')({});
		pushStatus({ kind: 'ready' });
		broadcasts = [];

		pushFrames(9);

		const levels = voiceEvents().filter((event) => event.type === 'audio-level');
		expect(levels.length).toBeGreaterThan(0);
		// Downsampled: nine 20 ms frames is well under nine updates.
		expect(levels.length).toBeLessThan(9);
	});

	it('publishes the microphone state a capture start proves', async () => {
		await handlerFor('acappella:start-session')({});
		broadcasts = [];

		pushStatus({
			kind: 'capture-start',
			device: { deviceId: 'default', label: 'Built-in Microphone' },
			contextSampleRate: 48_000,
		});

		expect(voiceEvents().at(-1)).toMatchObject({
			type: 'mic-state',
			permission: 'granted',
			deviceLabel: 'Built-in Microphone',
		});
	});

	it('turns a capture failure into a session error rather than a quiet session', async () => {
		await handlerFor('acappella:start-session')({});
		broadcasts = [];

		pushStatus({ kind: 'mic-error', code: 'permission-denied', message: 'Permission denied' });

		expect(voiceEvents().map((event) => event.type)).toContain('session-error');
		expect(voiceEvents().find((event) => event.type === 'session-error')).toMatchObject({
			code: 'audio-capture-failed',
			recoverable: true,
		});
	});

	it('ignores audio from a sender that is not the audio host', async () => {
		await handlerFor('acappella:start-session')({});
		pushStatus({ kind: 'ready' });
		broadcasts = [];

		// A browser tab that found the channel must not be able to inject PCM into a
		// live voice session.
		audioHost.isHostContents = false;
		pushFrames(9);

		expect(voiceEvents().filter((event) => event.type === 'audio-level')).toEqual([]);
	});

	it('ignores a malformed frame instead of throwing fifty times a second', async () => {
		await handlerFor('acappella:start-session')({});
		pushStatus({ kind: 'ready' });
		const listener = listenerFor(ACAPPELLA_AUDIO_FRAME_CHANNEL);

		expect(() => listener({ sender: audioHost.webContents }, { seq: 1 })).not.toThrow();
		expect(() => listener({ sender: audioHost.webContents }, null)).not.toThrow();
	});

	it('releases the microphone when the Encore Feature is switched off', async () => {
		await handlerFor('acappella:start-session')({});
		pushStatus({ kind: 'ready' });
		vi.mocked(audioHost.webContents.send).mockClear();

		disposeACappellaAudioBridge();

		expect(audioCommands().map((command) => command.kind)).toContain('stop-capture');
	});

	it('rewires audio when the Encore Feature is switched back on', async () => {
		await handlerFor('acappella:start-session')({});
		pushStatus({ kind: 'ready' });

		// Switching the feature off drops the bridge but deliberately leaves the
		// session service alive, so the next start reuses it. Without rewiring, the
		// host window opens and captures into nothing: no meter, no transcript, no
		// barge-in, and nothing on screen to say the microphone is dead.
		disposeACappellaAudioBridge();
		await handlerFor('acappella:stop-session')({});
		vi.mocked(audioHost.webContents.send).mockClear();
		broadcasts = [];

		await handlerFor('acappella:start-session')({});
		pushStatus({ kind: 'ready' });
		pushFrames(9);

		expect(audioCommands().map((command) => command.kind)).toContain('start-capture');
		expect(voiceEvents().filter((event) => event.type === 'audio-level').length).toBeGreaterThan(0);
	});

	it('wires no audio at all without a host window', async () => {
		vi.clearAllMocks();
		await disposeVoiceSessionService();
		resetACappellaHandlerState();
		register();

		await handlerFor('acappella:start-session')({});
		pushStatus({ kind: 'ready' });

		// A session with no audio host is text-in, which is exactly what the mock
		// tier promises; it must not reach for a device that is not there.
		expect(audioCommands()).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

describe('A Cappella IPC handlers - roster', () => {
	it('reads the roster straight from the sessions store', async () => {
		const roster = (await handlerFor('acappella:get-roster')({})) as RosterAgent[];

		expect(roster).toHaveLength(1);
		expect(roster[0]).toMatchObject({
			sessionId: 'agent-backend',
			name: 'Backend',
			agentType: 'claude-code',
			cwd: '/repo/api',
		});
		expect(roster[0].tabs.map((tab) => tab.id)).toEqual(['tab-auth']);
	});
});
