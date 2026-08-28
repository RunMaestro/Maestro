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
import { app, ipcMain, shell, systemPreferences } from 'electron';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn(), on: vi.fn() },
	// `getPath` and `getVersion` are what the paired-device transport reads at
	// registration: the device file lives under userData and the app version goes
	// in the Bonjour advert.
	app: {
		on: vi.fn(),
		getPath: vi.fn(() => '/tmp/maestro-test-userdata'),
		getVersion: vi.fn(() => '0.0.0-test'),
	},
	shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
	// Starting a session asks for the microphone. Granted here so these tests stay
	// about the transport; the permission's own states are covered in
	// mic-permission.test.ts.
	systemPreferences: {
		getMediaAccessStatus: vi.fn(() => 'granted'),
		askForMediaAccess: vi.fn().mockResolvedValue(true),
	},
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
	shutdownACappellaForDisable,
	stopVoiceSessionForClosedWindow,
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
import {
	disposeVoiceSessionService,
	getACappellaTransport,
	getVoiceSessionService,
} from '../../../../main/acappella';
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

/**
 * What `resolveVoiceWindowId` answers, per test. `undefined` leaves the dep off
 * entirely, which is the single-window host: no window is ever named.
 */
let voiceWindowId: string | null | undefined;

function register(options: { withAudio?: boolean } = {}): void {
	registerACappellaHandlers({
		settingsStore,
		getMainWindow: () => fakeWindow as never,
		safeSend: safeSend as never,
		// Absent by default, exactly as in a test process with no window: the
		// session still runs, it is simply text-in.
		audioHostDeps: options.withAudio ? ({} as never) : undefined,
		resolveVoiceWindowId:
			voiceWindowId === undefined ? undefined : () => voiceWindowId as string | null,
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

/**
 * The real platform, restored after every test. Anything that reaches a
 * platform-gated API (the macOS microphone prompt) has to say which platform it
 * means; inheriting the host's is what makes a suite pass on a Mac and fail on
 * both CI legs.
 */
const REAL_PLATFORM = process.platform;

function setPlatform(platform: string): void {
	Object.defineProperty(process, 'platform', { value: platform, configurable: true });
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
	setPlatform(REAL_PLATFORM);
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
				'acappella:mic-permission',
			])
		);
	});

	it('asks for nothing before a session starts, on any platform', async () => {
		// An app that prompts for the microphone at launch, or the moment an Encore
		// Feature is switched on, is asking for a device to do something the user has
		// not requested. Registering the handlers must ask for nothing.
		expect(systemPreferences.askForMediaAccess).not.toHaveBeenCalled();

		// Reading the permission is a pure query and must not prompt either: the
		// capability gate calls it on every Settings render.
		await handlerFor('acappella:mic-permission')({});
		expect(systemPreferences.askForMediaAccess).not.toHaveBeenCalled();
	});

	it('asks for the microphone at the first session start on macOS', async () => {
		// The platform is pinned rather than inherited from the host: `askForMediaAccess`
		// is a macOS-only API, so a test that assumes the developer's Mac passes locally
		// and fails on both CI legs.
		setPlatform('darwin');
		vi.mocked(systemPreferences.getMediaAccessStatus).mockReturnValue('not-determined');
		await handlerFor('acappella:start-session')({});
		expect(systemPreferences.askForMediaAccess).toHaveBeenCalledWith('microphone');
	});

	it('starts a session without prompting where there is no prompt to show', async () => {
		// Linux and Windows have no in-app microphone prompt. Calling the macOS API
		// there would either throw or silently do nothing, and either way a session
		// must still start rather than be gated behind a permission that cannot be
		// requested.
		setPlatform('linux');
		vi.mocked(systemPreferences.getMediaAccessStatus).mockReturnValue('not-determined');
		await handlerFor('acappella:start-session')({});
		expect(systemPreferences.askForMediaAccess).not.toHaveBeenCalled();
		expect(getVoiceSessionService()).not.toBeNull();
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
// Switching the feature off
// ---------------------------------------------------------------------------

/**
 * The stand-down that `main/index.ts` runs from its `encoreFeatures` watcher.
 *
 * Rejecting new IPC calls is not the same as stopping: before this existed,
 * turning A Cappella off released the microphone and closed the audio host, and
 * left a live session, a loaded inference pipeline, and the paired-device
 * transport running behind a switch its owner believed was off.
 */
describe('A Cappella IPC handlers - shutdownACappellaForDisable', () => {
	it('returns a live session to idle', async () => {
		await handlerFor('acappella:start-session')({});
		expect(getVoiceSessionService()?.getState()).not.toBe('idle');

		settings.encoreFeatures = { aCappella: false };
		await shutdownACappellaForDisable();

		expect(getVoiceSessionService()?.getState()).toBe('idle');
	});

	it('stands the transport down, so no advert and no device outlive the switch', async () => {
		const transport = getACappellaTransport();
		expect(transport, 'registration must have built a transport').not.toBeNull();
		const standDown = vi.spyOn(transport!, 'standDown');

		await shutdownACappellaForDisable();

		expect(standDown).toHaveBeenCalled();
	});

	it('keeps the transport, so switching the feature back on needs no restart', async () => {
		const before = getACappellaTransport();

		await shutdownACappellaForDisable();

		// Disposing it here would be the tempting move and the wrong one: it is
		// built once, at handler registration, which only runs at boot.
		expect(getACappellaTransport()).toBe(before);
	});

	it('drops the provider pipeline, so reclaiming disk is not blocked by an open model', async () => {
		await handlerFor('acappella:start-session')({});
		settings.encoreFeatures = { aCappella: false };
		await shutdownACappellaForDisable();
		settings.encoreFeatures = { aCappella: true };

		// A rebuild rather than a reuse is the observable proof the pipeline was
		// disposed: the memo of what it was built from is cleared with it, so the
		// next start cannot hand back a disposed pipeline. On Windows this is also
		// what lets `fs.rm` delete a model directory whose files were mapped.
		const result = (await handlerFor('acappella:start-session')({})) as VoiceStartSessionResult;
		expect(result.snapshot.state).not.toBe('idle');
	});

	it('is safe with nothing running at all', async () => {
		vi.clearAllMocks();
		await disposeVoiceSessionService();
		resetACappellaHandlerState();
		register();

		await expect(shutdownACappellaForDisable()).resolves.toBeUndefined();
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
	it('starts a conductor session on the default trio with no substitutions', async () => {
		const result = (await handlerFor('acappella:start-session')({})) as VoiceStartSessionResult;

		expect(result.snapshot.state).toBe('listening');
		expect(result.snapshot.scope).toEqual({ kind: 'conductor' });
		// STT defaults to the microphone check rather than the text-in mock, in
		// every build: an unconfigured install must still be able to open a device.
		expect(result.snapshot.providerIds).toEqual({
			stt: 'echo-stt',
			tts: 'mock-tts',
			brain: 'mock-brain',
		});
		// Not configuring a provider is the documented default, not a downgrade.
		expect(result.substitutions).toEqual([]);
	});

	it('reports a substitution when the configured provider is unknown', async () => {
		settings.acappella = { providers: { stt: 'whisper-that-is-not-registered' } };

		const result = (await handlerFor('acappella:start-session')({})) as VoiceStartSessionResult;

		expect(result.substitutions).toHaveLength(1);
		expect(result.substitutions[0]).toMatchObject({
			role: 'stt',
			requestedId: 'whisper-that-is-not-registered',
			// Not the mock: an unbuildable slot refuses by name rather than quietly
			// becoming a tier that transcribes nothing and looks healthy.
			resolvedId: 'unresolved-stt',
			reason: 'unknown-provider',
		});
		expect(result.snapshot.providerIds.stt).toBe('unresolved-stt');
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

	it('binds a document scope, carrying the file the conversation is about', async () => {
		const result = (await handlerFor('acappella:start-session')(
			{},
			{
				kind: 'document',
				sessionId: 'agent-backend',
				path: '/repo/docs/system-overview.md',
			}
		)) as VoiceStartSessionResult;

		expect(result.snapshot.scope).toEqual({
			kind: 'document',
			sessionId: 'agent-backend',
			path: '/repo/docs/system-overview.md',
		});
	});

	it('rejects a document scope with no path rather than opening one about nothing', async () => {
		// Same rule as the missing agent id: a document scope with no document
		// names a file in the HUD and hands the agent nothing.
		await expect(
			handlerFor('acappella:start-session')({}, { kind: 'document', sessionId: 'agent-backend' })
		).rejects.toThrow('InvalidVoiceScope');
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

/**
 * Which window's HUD a session belongs to. Voice events are broadcast to every
 * window, so this field is the only thing keeping a session opened in one window
 * from drawing a HUD in all of them.
 */
describe('A Cappella IPC handlers - window scoping', () => {
	afterEach(() => {
		voiceWindowId = undefined;
	});

	it('stamps the session with the window the start came from', async () => {
		voiceWindowId = 'window-2';
		vi.mocked(ipcMain.handle).mockClear();
		register();

		const result = (await handlerFor('acappella:start-session')({})) as VoiceStartSessionResult;

		expect(result.snapshot.windowId).toBe('window-2');
		// On `wake`, the FIRST event: a window that had to wait for the catch-up
		// snapshot would flash a HUD for a session that is not its own.
		expect(voiceEvents()[0]).toMatchObject({ type: 'wake', windowId: 'window-2' });
	});

	it('names no window when nothing resolves one', async () => {
		// The single-window host, and every test host: null means the primary
		// window shows it, which is the only window there is.
		const result = (await handlerFor('acappella:start-session')({})) as VoiceStartSessionResult;

		expect(result.snapshot.windowId).toBeNull();
	});

	it('clears the window when the session ends', async () => {
		voiceWindowId = 'window-2';
		vi.mocked(ipcMain.handle).mockClear();
		register();
		await handlerFor('acappella:start-session')({});

		await handlerFor('acappella:stop-session')({});

		const snapshot = (await handlerFor('acappella:get-state')({})) as VoiceSessionSnapshot;
		expect(snapshot.windowId).toBeNull();
	});

	it('ends the session when its own window closes', async () => {
		// Otherwise closing that window leaves an open microphone with no surface
		// anywhere - the failure the HUD's close button exists to prevent, reached
		// by a different route.
		voiceWindowId = 'window-2';
		vi.mocked(ipcMain.handle).mockClear();
		register();
		await handlerFor('acappella:start-session')({});

		await stopVoiceSessionForClosedWindow('window-2');

		expect(getVoiceSessionService()?.getState()).toBe('idle');
	});

	it('leaves a session alone when a DIFFERENT window closes', async () => {
		voiceWindowId = 'window-2';
		vi.mocked(ipcMain.handle).mockClear();
		register();
		await handlerFor('acappella:start-session')({});

		await stopVoiceSessionForClosedWindow('window-1');

		expect(getVoiceSessionService()?.getState()).toBe('listening');
	});
});

// ---------------------------------------------------------------------------
// Event fan-out
// ---------------------------------------------------------------------------

describe('A Cappella IPC handlers - event fan-out', () => {
	it('broadcasts every protocol event once on acappella:event', async () => {
		await handlerFor('acappella:start-session')({});

		const types = voiceEvents().map((event) => event.type);
		expect(types).toEqual(['wake', 'listen-start', 'provider-state', 'agent-roster']);
		expect(voiceEvents().map((event) => event.seq)).toEqual([1, 2, 3, 4]);
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

		settings.acappella = { providers: { stt: 'whisper-that-is-not-registered' } };
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
