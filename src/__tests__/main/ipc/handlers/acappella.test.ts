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
import { ipcMain } from 'electron';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn() },
}));
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
	registerACappellaHandlers,
	resetACappellaHandlerState,
	type VoiceStartSessionResult,
} from '../../../../main/ipc/handlers/acappella';
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

function register(): void {
	registerACappellaHandlers({
		settingsStore,
		getMainWindow: () => fakeWindow as never,
		safeSend: safeSend as never,
	});
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
