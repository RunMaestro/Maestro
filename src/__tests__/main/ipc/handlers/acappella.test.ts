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
/**
 * The core dictation service is not under test here; what is, is that these
 * handlers hand it a microphone. The registration is captured so a test can
 * drive that microphone exactly as the service would.
 */
const dictation = vi.hoisted(() => ({
	microphones: [] as unknown[],
	unregister: vi.fn(),
}));
vi.mock('../../../../main/local-models/dictation', () => ({
	registerDictationMicrophone: vi.fn((device: unknown) => {
		dictation.microphones.push(device);
		return dictation.unregister;
	}),
}));
/**
 * The core spoken notices queue is not under test here either; what is, is that
 * these handlers hand it a speaker, and cut it off when a voice session starts.
 */
const notices = vi.hoisted(() => ({
	speakers: [] as unknown[],
	unregister: vi.fn(),
	cancelSpokenNotices: vi.fn(),
}));
vi.mock('../../../../main/local-models/spoken-notices', () => ({
	registerNoticeSpeaker: vi.fn((device: unknown) => {
		notices.speakers.push(device);
		return notices.unregister;
	}),
	cancelSpokenNotices: notices.cancelSpokenNotices,
}));
/**
 * The voice a notice speaks with is the operating system's, which is a child
 * process. Here it is one second of silence, so a test can follow the audio
 * through the host without making any.
 */
const noticeVoice = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('../../../../main/acappella/providers/provider-registry', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../../main/acappella/providers/provider-registry')>();
	return {
		...actual,
		createNoticeTtsProvider: vi.fn((voiceSettings: { tts?: string }) => {
			const id = actual.noticeTtsProviderId(voiceSettings);
			noticeVoice.ids.push(id);
			return {
				id,
				label: 'Notice voice',
				tier: 'local',
				cancel: vi.fn(),
				async *speak(text: string, options: { utteranceId: string }) {
					yield {
						utteranceId: options.utteranceId,
						index: 0,
						text,
						format: 'pcm16',
						audio: new Uint8Array(48_000),
						sampleRate: 24_000,
					};
				},
			};
		}),
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

import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { getSessionsStore } from '../../../../main/stores/getters';
import {
	ACAPPELLA_WAKE_ENROLLMENT_CHANNEL,
	disposeACappellaAudioBridge,
	registerACappellaHandlers,
	resetACappellaHandlerState,
	shutdownACappellaForDisable,
	stopVoiceSessionForWindow,
	type VoiceStartSessionResult,
	type WakeTestStartResult,
} from '../../../../main/ipc/handlers/acappella';
import { setWakeEnrollmentRoot } from '../../../../main/acappella/wake/wake-enrollment-store';
import type {
	WakeEnrollmentEvent,
	WakeEnrollmentReply,
} from '../../../../shared/acappella/wake-enrollment';
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
import type { QuickChatVoiceHost } from '../../../../main/acappella/dispatch/quick-chat-dispatch';
import { runVoiceControlRequest } from '../../../../main/acappella/voice-control-service';
import { EMPTY_QUICK_CHAT_SNAPSHOT, type QuickChatStatus } from '../../../../shared/quickChat';
import type { DictationMicrophone } from '../../../../main/local-models/dictation';
import type { NoticeSpeaker } from '../../../../main/local-models/spoken-notices';
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
	acappella?: { providers?: Record<string, string>; controls?: Record<string, unknown> };
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

function register(
	options: { withAudio?: boolean; quickChat?: QuickChatVoiceHost | null } = {}
): void {
	registerACappellaHandlers({
		settingsStore,
		getMainWindow: () => fakeWindow as never,
		safeSend: safeSend as never,
		// Absent by default, exactly as in a test process with no window: the
		// session still runs, it is simply text-in.
		audioHostDeps: options.withAudio ? ({} as never) : undefined,
		resolveVoiceWindowId:
			voiceWindowId === undefined ? undefined : () => voiceWindowId as string | null,
		// Absent by default, as in a host with no Quick Chat.
		getQuickChat: options.quickChat === undefined ? undefined : () => options.quickChat ?? null,
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

	// The mock trio is pinned EXPLICITLY rather than inherited from the default.
	// These tests are about IPC plumbing - handler registration, event fan-out,
	// window scoping, the audio bridge - and the default is the local tier, which
	// needs model files on disk. Leaning on the default would make every test in
	// this file fail the day the default changed, for reasons having nothing to do
	// with what any of them assert. Which trio the default resolves to is
	// `provider-registry.test.ts`'s question, and it is asked there.
	settings = {
		encoreFeatures: { aCappella: true },
		acappella: { providers: { stt: 'echo-stt', tts: 'mock-tts', brain: 'mock-brain' } },
	};
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
				'acappella:set-listening',
				'acappella:get-send-wait',
				'acappella:set-send-wait',
				'acappella:stop-word',
				'acappella:get-roster',
				'acappella:get-state',
				'acappella:open-mic-settings',
				'acappella:mic-permission',
				'acappella:wake-enrollment',
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
	it('starts a conductor session on the configured trio with no substitutions', async () => {
		const result = (await handlerFor('acappella:start-session')({})) as VoiceStartSessionResult;

		expect(result.snapshot.state).toBe('listening');
		expect(result.snapshot.scope).toEqual({ kind: 'conductor' });
		// Exactly what was asked for, in the order the slots were named.
		expect(result.snapshot.providerIds).toEqual({
			stt: 'echo-stt',
			tts: 'mock-tts',
			brain: 'mock-brain',
		});
		// Choosing a provider explicitly is honoured, never quietly upgraded or
		// downgraded to something else.
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

		await stopVoiceSessionForWindow('window-2');

		expect(getVoiceSessionService()?.getState()).toBe('idle');
	});

	it('leaves a session alone when a DIFFERENT window closes', async () => {
		voiceWindowId = 'window-2';
		vi.mocked(ipcMain.handle).mockClear();
		register();
		await handlerFor('acappella:start-session')({});

		await stopVoiceSessionForWindow('window-1');

		expect(getVoiceSessionService()?.getState()).toBe('listening');
	});
});

/**
 * A session bound to Quick Chat: shown by the Quick Chat window whoever asked
 * for it, ended when that window is put away, and never re-bound.
 */
describe('A Cappella IPC handlers - a Quick Chat session', () => {
	const QUICK_CHAT_SCOPE = { kind: 'quick-chat' };

	function makeQuickChat(windowId: string | null = 'window-quick'): QuickChatVoiceHost {
		return {
			showForVoice: vi.fn(() => windowId),
			getStatus: vi.fn(() => ({ snapshot: { ...EMPTY_QUICK_CHAT_SNAPSHOT } }) as QuickChatStatus),
			runCommand: vi.fn(async () => ({ ok: true, snapshot: { ...EMPTY_QUICK_CHAT_SNAPSHOT } })),
			onSnapshot: vi.fn(() => () => {}),
		};
	}

	function registerWith(quickChat: QuickChatVoiceHost | null | undefined): void {
		vi.mocked(ipcMain.handle).mockClear();
		register({ quickChat });
	}

	afterEach(() => {
		voiceWindowId = undefined;
	});

	it('is owned by the Quick Chat window, not the window the start came from', async () => {
		// An app window asked (the CLI lands here too, with the focused window).
		voiceWindowId = 'window-2';
		const quickChat = makeQuickChat();
		registerWith(quickChat);

		const result = (await handlerFor('acappella:start-session')(
			{},
			QUICK_CHAT_SCOPE
		)) as VoiceStartSessionResult;

		expect(quickChat.showForVoice).toHaveBeenCalledTimes(1);
		expect(result.snapshot.scope).toEqual({ kind: 'quick-chat' });
		expect(result.snapshot.windowId).toBe('window-quick');
		expect(voiceEvents()[0]).toMatchObject({ type: 'wake', windowId: 'window-quick' });
	});

	it('leaves Quick Chat alone for every other scope', async () => {
		voiceWindowId = 'window-2';
		const quickChat = makeQuickChat();
		registerWith(quickChat);

		const result = (await handlerFor('acappella:start-session')({})) as VoiceStartSessionResult;

		expect(quickChat.showForVoice).not.toHaveBeenCalled();
		expect(result.snapshot.windowId).toBe('window-2');
	});

	it('refuses by name when Quick Chat is turned off, and opens no session', async () => {
		registerWith(makeQuickChat(null));

		await expect(handlerFor('acappella:start-session')({}, QUICK_CHAT_SCOPE)).rejects.toThrow(
			/Quick Chat is turned off/
		);
		expect(getVoiceSessionService()?.getState() ?? 'idle').toBe('idle');
	});

	it('refuses by name in a host with no Quick Chat at all', async () => {
		registerWith(undefined);

		await expect(handlerFor('acappella:start-session')({}, QUICK_CHAT_SCOPE)).rejects.toThrow(
			/Quick Chat is turned off/
		);
	});

	it('ends when the Quick Chat window is put away', async () => {
		registerWith(makeQuickChat());
		await handlerFor('acappella:start-session')({}, QUICK_CHAT_SCOPE);

		await stopVoiceSessionForWindow('window-quick', 'hidden');

		expect(getVoiceSessionService()?.getState()).toBe('idle');
	});

	it('is not re-bound by the mode switch', async () => {
		registerWith(makeQuickChat());
		await handlerFor('acappella:start-session')({}, QUICK_CHAT_SCOPE);

		await expect(
			handlerFor('acappella:set-scope')({}, { kind: 'agent', sessionId: 'agent-backend' })
		).resolves.toBe(false);

		expect(getVoiceSessionService()?.getSnapshot().scope).toEqual({ kind: 'quick-chat' });
	});

	it('tells `maestro-cli voice scope` WHY, instead of claiming there is no session', async () => {
		registerWith(makeQuickChat());
		await handlerFor('acappella:start-session')({}, QUICK_CHAT_SCOPE);

		const reply = await runVoiceControlRequest({ action: 'scope', scope: { kind: 'conductor' } });

		expect(reply).toEqual({ ok: false, reason: expect.stringMatching(/locked to Quick Chat/) });
	});

	it('starts from `maestro-cli voice start --quick-chat` through the same claim', async () => {
		const quickChat = makeQuickChat();
		registerWith(quickChat);

		const reply = await runVoiceControlRequest({ action: 'start', scope: QUICK_CHAT_SCOPE });

		expect(reply).toMatchObject({
			ok: true,
			result: { session: { scope: { kind: 'quick-chat' }, windowId: 'window-quick' } },
		});
		expect(quickChat.showForVoice).toHaveBeenCalledTimes(1);
	});

	it('answers the CLI with a refusal, not an error, when Quick Chat is off', async () => {
		registerWith(makeQuickChat(null));

		const reply = await runVoiceControlRequest({ action: 'start', scope: QUICK_CHAT_SCOPE });

		expect(reply).toEqual({ ok: false, reason: expect.stringMatching(/Quick Chat is turned off/) });
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
// The microphone gate and the send wait
// ---------------------------------------------------------------------------

describe('A Cappella IPC handlers - microphone gate', () => {
	it('shuts the microphone and keeps the session', async () => {
		await handlerFor('acappella:start-session')({});
		broadcasts = [];

		await expect(handlerFor('acappella:set-listening')({}, { listening: false })).resolves.toBe(
			true
		);

		// A pause is not a hang-up: the session is still there to resume.
		expect(getVoiceSessionService()?.getState()).toBe('listening');
		expect(getVoiceSessionService()?.getSnapshot().listenPaused).toBe(true);
		expect(voiceEvents().map((event) => event.type)).toContain('listen-gate');
	});

	it('reports false with no session, so the caller starts one', async () => {
		await expect(handlerFor('acappella:set-listening')({}, { listening: true })).resolves.toBe(
			false
		);
	});

	it('rejects a payload that does not say which way the gate goes', async () => {
		await handlerFor('acappella:start-session')({});

		await expect(handlerFor('acappella:set-listening')({}, {})).rejects.toThrow('InvalidListening');
		await expect(handlerFor('acappella:set-listening')({}, undefined)).rejects.toThrow(
			'InvalidListening'
		);
	});

	it('opens a session gated only on a literal paused: true', async () => {
		const gated = (await handlerFor('acappella:start-session')({}, undefined, {
			paused: true,
		})) as VoiceStartSessionResult;
		expect(gated.snapshot.listenPaused).toBe(true);
		await handlerFor('acappella:stop-session')({});

		// Anything else opens hot. A malformed option must not produce a session
		// that looks live and hears nothing.
		const hot = (await handlerFor('acappella:start-session')({}, undefined, {
			paused: 'yes',
		})) as VoiceStartSessionResult;
		expect(hot.snapshot.listenPaused).toBe(false);
	});

	it('is refused while the feature is off', async () => {
		settings.encoreFeatures = { aCappella: false };

		await expect(handlerFor('acappella:set-listening')({}, { listening: true })).rejects.toThrow(
			'ACappellaDisabled'
		);
	});
});

describe('A Cappella IPC handlers - send wait', () => {
	it('reports the stored default until the HUD picks something', async () => {
		settings.acappella = { ...(settings.acappella as object), controls: { turnSettleMs: 1200 } };

		await expect(handlerFor('acappella:get-send-wait')({})).resolves.toMatchObject({
			waitMs: 1200,
			defaultMs: 1200,
			overridden: false,
		});
	});

	it('uses the long backstop as the default when requests are held for a send phrase', async () => {
		settings.acappella = {
			...(settings.acappella as object),
			controls: { holdUntilSend: true, sendHoldMs: 20_000, turnSettleMs: 1200 },
		};

		await expect(handlerFor('acappella:get-send-wait')({})).resolves.toMatchObject({
			waitMs: 20_000,
			defaultMs: 20_000,
		});
	});

	it('lets the HUD override the wait without touching the stored default', async () => {
		settings.acappella = { ...(settings.acappella as object), controls: { turnSettleMs: 1200 } };

		await expect(handlerFor('acappella:set-send-wait')({}, 5000)).resolves.toMatchObject({
			waitMs: 5000,
			defaultMs: 1200,
			overridden: true,
		});
		// The read agrees with the write, and Settings still holds what it held.
		await expect(handlerFor('acappella:get-send-wait')({})).resolves.toMatchObject({
			waitMs: 5000,
			overridden: true,
		});
		expect(
			(settings.acappella as { controls: { turnSettleMs: number } }).controls.turnSettleMs
		).toBe(1200);
	});

	it('returns to the default on null, and on anything that is not a wait', async () => {
		await handlerFor('acappella:set-send-wait')({}, 5000);
		await expect(handlerFor('acappella:set-send-wait')({}, null)).resolves.toMatchObject({
			overridden: false,
		});

		await handlerFor('acappella:set-send-wait')({}, 5000);
		await expect(handlerFor('acappella:set-send-wait')({}, 'soon')).resolves.toMatchObject({
			overridden: false,
		});
	});

	it('names the phrases that send before the wait runs out', async () => {
		settings.acappella = {
			...(settings.acappella as object),
			controls: { sendPhrases: 'ship it, over' },
		};

		await expect(handlerFor('acappella:get-send-wait')({})).resolves.toMatchObject({
			sendPhrases: ['ship it', 'over'],
		});
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
		// The echo provider consumes real PCM without needing a model on disk, which
		// is exactly what the capture path needs to be exercised against. The other
		// two slots are pinned to the mock tier for the same reason: this assignment
		// REPLACES the shared one, so naming only `stt` would leave text-to-speech
		// and the brain on the local default and error the session before a single
		// frame was captured.
		nodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = 'development';
		settings.acappella = {
			providers: { stt: ECHO_STT_PROVIDER_ID, tts: 'mock-tts', brain: 'mock-brain' },
		};

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

	// -- Wake phrase enrollment: recording a phrase with no session behind it ---

	describe('wake phrase enrollment', () => {
		let enrollmentRoot: string;

		const enroll = (request: unknown) =>
			handlerFor('acappella:wake-enrollment')({}, request) as Promise<WakeEnrollmentReply>;

		function enrollmentEvents(): WakeEnrollmentEvent[] {
			return broadcasts
				.filter((entry) => entry.channel === ACAPPELLA_WAKE_ENROLLMENT_CHANNEL)
				.map((entry) => entry.args[0] as WakeEnrollmentEvent);
		}

		function pushSilence(count: number): void {
			const listener = listenerFor(ACAPPELLA_AUDIO_FRAME_CHANNEL);
			for (let seq = 1; seq <= count; seq++) {
				listener(
					{ sender: audioHost.webContents },
					{
						seq,
						capturedAt: seq * 20,
						rms: 0,
						pcm: new Int16Array(ACAPPELLA_AUDIO_FRAME_SAMPLES).buffer,
					}
				);
			}
		}

		beforeEach(async () => {
			enrollmentRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'wake-enrollment-ipc-'));
			setWakeEnrollmentRoot(enrollmentRoot);
		});

		afterEach(async () => {
			await enroll({ action: 'stop' });
			setWakeEnrollmentRoot(null);
			await fsPromises.rm(enrollmentRoot, { recursive: true, force: true });
		});

		it('records a take through the audio host without starting a voice session', async () => {
			broadcasts = [];

			const started = await enroll({ action: 'record', phrase: 'hey scout', kind: 'phrase' });
			expect(started).toMatchObject({ ok: true, status: { recording: 'phrase', clips: 0 } });
			expect(audioCommands().map((command) => command.kind)).toEqual(['start-capture']);

			// Half a second of quiet, 600 ms of voice, then enough quiet to end it.
			pushSilence(25);
			pushFrames(30);
			pushSilence(40);
			const stopped = await enroll({ action: 'stop' });

			expect(stopped).toMatchObject({ ok: true, status: { clips: 1, recording: null } });
			expect(audioCommands().map((command) => command.kind)).toEqual([
				'start-capture',
				'stop-capture',
			]);
			expect(enrollmentEvents().some((event) => event.type === 'level')).toBe(true);
			// No session was started and nothing was published on the voice stream.
			expect(getVoiceSessionService()?.getState() ?? 'idle').toBe('idle');
			expect(voiceEvents()).toEqual([]);
		});

		it('asks again for the microphone when the audio host finishes booting mid-run', async () => {
			await enroll({ action: 'record', phrase: 'hey scout', kind: 'phrase' });

			pushStatus({ kind: 'ready' });

			expect(audioCommands().map((command) => command.kind)).toEqual([
				'start-capture',
				'start-capture',
			]);
		});

		it('will not record under a live voice session, and leaves its microphone alone', async () => {
			await handlerFor('acappella:start-session')({});
			vi.mocked(audioHost.webContents.send).mockClear();

			const result = await enroll({ action: 'record', phrase: 'hey scout', kind: 'phrase' });

			expect(result).toMatchObject({ ok: false });
			expect((result as { reason: string }).reason).toMatch(/End the voice session first/);
			expect(audioCommands()).toEqual([]);
		});

		it("keeps the wake word Test and a recording out of each other's way", async () => {
			await enroll({ action: 'record', phrase: 'hey scout', kind: 'phrase' });

			const test = (await handlerFor('acappella:wake-test')({}, {})) as WakeTestStartResult;

			expect(test).toMatchObject({ started: false });
			expect((test as { reason: string }).reason).toMatch(/Finish recording the phrase first/);
		});

		it('refuses dictation while a phrase is being recorded', async () => {
			await enroll({ action: 'record', phrase: 'hey scout', kind: 'phrase' });

			const result = await (dictation.microphones.at(-1) as DictationMicrophone).start();

			expect(result).toMatchObject({ started: false, code: 'busy' });
		});

		it('refuses a request it does not know rather than guessing', async () => {
			expect(await enroll({ action: 'upload', phrase: 'hey scout' })).toEqual({
				ok: false,
				reason: 'Unknown wake phrase request.',
			});
		});

		it('lists the phrases that have recordings', async () => {
			await enroll({ action: 'record', phrase: 'Hey Scout', kind: 'phrase' });
			pushSilence(25);
			pushFrames(30);
			pushSilence(40);
			await enroll({ action: 'stop' });

			// Each phrase's status rides along, so a client lists them in one round trip.
			expect(await enroll({ action: 'list' })).toEqual({
				ok: true,
				status: null,
				phrases: ['Hey Scout'],
				statuses: [expect.objectContaining({ phrase: 'Hey Scout', clips: 1 })],
			});
		});

		it('reads, stops and deletes with the feature off, but will not record or train', async () => {
			// Switching voice off must still be able to close a microphone and remove
			// a recording of the user's voice. The refusal is an answer, not a throw:
			// the same entry point serves `maestro-cli voice wake`.
			settings.encoreFeatures = { aCappella: false };
			const off = { ok: false, reason: expect.stringMatching(/switched off/) };

			await expect(enroll({ action: 'status', phrase: 'hey scout' })).resolves.toMatchObject({
				ok: true,
				status: { clips: 0, model: null },
			});
			await expect(enroll({ action: 'stop' })).resolves.toMatchObject({ ok: true });
			await expect(enroll({ action: 'remove', phrase: 'hey scout' })).resolves.toMatchObject({
				ok: true,
			});
			await expect(
				enroll({ action: 'record', phrase: 'hey scout', kind: 'phrase' })
			).resolves.toEqual(off);
			await expect(enroll({ action: 'train', phrase: 'hey scout' })).resolves.toEqual(off);
			expect(audioCommands()).toEqual([]);
		});
	});

	// -- Dictation's microphone: the capture path with no session behind it ----

	describe('the dictation microphone', () => {
		const CAPTURE_START: AudioHostStatus = {
			kind: 'capture-start',
			device: { deviceId: 'default', label: 'Built-in Microphone' },
			contextSampleRate: 48_000,
		};

		/** The microphone the latest registration handed the dictation service. */
		function microphone(): DictationMicrophone {
			return dictation.microphones.at(-1) as DictationMicrophone;
		}

		/** Open the microphone the way the dictation service does. */
		async function startRecording(): Promise<void> {
			const starting = microphone().start();
			await vi.waitFor(() =>
				expect(audioCommands().map((command) => command.kind)).toContain('start-capture')
			);
			pushStatus(CAPTURE_START);
			await expect(starting).resolves.toEqual({ started: true });
		}

		it('records a clip through the audio host without starting a voice session', async () => {
			broadcasts = [];
			await startRecording();
			pushFrames(10);

			const clip = await microphone().stop();

			expect(clip.sampleRate).toBe(ACAPPELLA_AUDIO_SAMPLE_RATE);
			expect(clip.audio).toHaveLength(10 * ACAPPELLA_AUDIO_FRAME_SAMPLES);
			expect(audioCommands().map((command) => command.kind)).toEqual([
				'start-capture',
				'stop-capture',
			]);
			// No session was started, the floor never opened, and nothing was
			// published on the voice event stream.
			expect(getVoiceSessionService()?.getState() ?? 'idle').toBe('idle');
			expect(voiceEvents()).toEqual([]);
		});

		it('is offered with the A Cappella Encore Feature switched off', async () => {
			// Dictation is a core Local Models feature that only borrows this capture
			// path, so the Encore gate on the voice channels does not apply to it.
			settings.encoreFeatures = {};

			await startRecording();
			pushFrames(3);

			expect((await microphone().stop()).audio).toHaveLength(3 * ACAPPELLA_AUDIO_FRAME_SAMPLES);
		});

		it('is refused while a voice session is using the microphone', async () => {
			await handlerFor('acappella:start-session')({});
			vi.mocked(audioHost.webContents.send).mockClear();

			await expect(microphone().start()).resolves.toMatchObject({
				started: false,
				code: 'voice-session-active',
			});
			// Refused before anything was asked of the device.
			expect(audioCommands()).toEqual([]);
		});

		it('leaves the microphone open for a voice session that started during the clip', async () => {
			await startRecording();
			await handlerFor('acappella:start-session')({});
			vi.mocked(audioHost.webContents.send).mockClear();

			await microphone().stop();

			// The session owns the device now; closing it would cut it off.
			expect(audioCommands().map((command) => command.kind)).not.toContain('stop-capture');
		});

		it('records nothing from a sender that is not the audio host', async () => {
			await startRecording();

			audioHost.isHostContents = false;
			pushFrames(5);
			audioHost.isHostContents = true;

			expect((await microphone().stop()).audio).toHaveLength(0);
		});

		it('has no microphone to open without a host window', async () => {
			vi.clearAllMocks();
			resetACappellaHandlerState();
			register();

			await expect(microphone().start()).resolves.toMatchObject({
				started: false,
				code: 'no-microphone',
			});
			expect(audioCommands()).toEqual([]);
		});

		it('unregisters the microphone when the handler state is reset', () => {
			dictation.unregister.mockClear();
			resetACappellaHandlerState();
			expect(dictation.unregister).toHaveBeenCalledTimes(1);
		});
	});

	// -- Spoken notices' speaker: the playback path with no session behind it --

	describe('the notice speaker', () => {
		const DRAINED: AudioHostStatus = {
			kind: 'playback-state',
			playing: false,
			utteranceId: null,
			queuedMs: 0,
		};

		beforeEach(() => {
			noticeVoice.ids.length = 0;
		});

		/** The speaker the latest registration handed the notice service. */
		function speaker(): NoticeSpeaker {
			return notices.speakers.at(-1) as NoticeSpeaker;
		}

		function kinds(): string[] {
			return audioCommands().map((command) => command.kind);
		}

		/** Speak one line the way the notice queue does, to the end. */
		async function speakLine(text: string): Promise<void> {
			const speaking = speaker().speak(text, new AbortController().signal);
			// The host window was just created and has not loaded its bundle yet.
			pushStatus({ kind: 'ready' });
			await vi.waitFor(() => expect(kinds()).toContain('end-utterance'));
			pushStatus(DRAINED);
			await speaking;
		}

		it('speaks through the audio host without starting a voice session', async () => {
			broadcasts = [];
			await speakLine('Backend finished');

			expect(kinds()).toEqual(['set-volume', 'play', 'end-utterance']);
			// No microphone was opened, no session was started, and nothing was
			// published on the voice event stream.
			expect(kinds()).not.toContain('start-capture');
			expect(getVoiceSessionService()?.getState() ?? 'idle').toBe('idle');
			expect(voiceEvents()).toEqual([]);
		});

		it('is offered with the A Cappella Encore Feature switched off', async () => {
			// Spoken notices are a core Local Models feature that only borrows this
			// playback path, so the Encore gate on the voice channels does not apply.
			settings.encoreFeatures = {};

			await speakLine('Backend finished');

			expect(kinds()).toContain('play');
		});

		it('speaks with the system voice when the voice chosen for A Cappella is not a local one', async () => {
			// The suite pins `mock-tts`; a hosted voice is treated the same way. A
			// notice fires unasked, so its text never goes to a hosted service.
			await speakLine('Backend finished');
			expect(noticeVoice.ids).toEqual(['system-tts']);

			settings.acappella = { providers: { tts: 'elevenlabs-tts' } };
			await speakLine('Backend finished');
			// Same local voice as before, so it was kept rather than rebuilt.
			expect(noticeVoice.ids).toEqual(['system-tts']);
		});

		it('keeps a local voice the user chose', async () => {
			settings.acappella = { providers: { tts: 'kokoro-local' } };
			await speakLine('Backend finished');
			expect(noticeVoice.ids).toEqual(['kokoro-local']);
		});

		it('stays silent while a voice session is live', async () => {
			expect(speaker().refusal()).toBeNull();

			await handlerFor('acappella:start-session')({});

			expect(speaker().refusal()).toMatchObject({ code: 'voice-session-active' });
		});

		it('cuts notices off when a voice session opens the floor', async () => {
			expect(notices.cancelSpokenNotices).not.toHaveBeenCalled();

			await handlerFor('acappella:start-session')({});

			expect(notices.cancelSpokenNotices).toHaveBeenCalledWith(
				'voice-session-active',
				expect.any(String)
			);
		});

		it('has no speaker to play through without a host window', async () => {
			vi.clearAllMocks();
			resetACappellaHandlerState();
			register();

			await expect(speaker().speak('hi', new AbortController().signal)).rejects.toThrow(
				/no audio host/
			);
			expect(audioCommands()).toEqual([]);
		});

		it('unregisters the speaker when the handler state is reset', () => {
			notices.unregister.mockClear();
			resetACappellaHandlerState();
			expect(notices.unregister).toHaveBeenCalledTimes(1);
		});
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
