/**
 * Tests for src/main/ipc/handlers/provider-auth.ts
 *
 * The handlers are thin, so what these cover is the wiring that is easy to get
 * wrong: a re-probe must go through `runStartupAuthProbe` in `'manual'` mode
 * (never re-derive env resolution at the call site), a single-key re-probe must
 * narrow with `onlyKeys`, and a snapshot write from ANYWHERE in main must reach
 * every window exactly once.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ipcMain } from 'electron';

const { mockWindows } = vi.hoisted(() => ({
	mockWindows: [] as Array<Record<string, unknown>>,
}));

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
	BrowserWindow: { getAllWindows: () => mockWindows },
}));

// In-memory electron-store so the real providerAuthStore (and therefore its
// real change emitter) is exercised rather than a mock of it.
vi.mock('electron-store', () => ({
	default: class MockStore {
		data: Record<string, unknown>;
		constructor(options: Record<string, unknown>) {
			this.data = { ...((options.defaults as Record<string, unknown>) ?? {}) };
		}
		get(key: string, defaultValue?: unknown): unknown {
			return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : defaultValue;
		}
		set(key: string, value: unknown): void {
			this.data[key] = value;
		}
	},
}));

const mockRunStartupAuthProbe = vi.fn();
vi.mock('../../../../main/agents/auth/auth-startup', () => ({
	runStartupAuthProbe: (...args: unknown[]) => mockRunStartupAuthProbe(...args),
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerProviderAuthHandlers } from '../../../../main/ipc/handlers/provider-auth';
import {
	setSnapshot,
	clearSnapshot,
	__resetForTests,
} from '../../../../main/stores/providerAuthStore';
import type { CredentialIdentity, ProviderAuthSnapshot } from '../../../../shared/providerAuth';

const KEY = 'claude-code::oauth::/Users/test/.claude::local';

const IDENTITY: CredentialIdentity = {
	key: KEY,
	provider: 'claude-code',
	kind: 'oauth',
	scope: '/Users/test/.claude',
	host: 'local',
	label: '.claude',
};

function makeSnapshot(overrides: Partial<ProviderAuthSnapshot> = {}): ProviderAuthSnapshot {
	return {
		identity: IDENTITY,
		status: 'authenticated',
		checkedAt: 1_700_000_000_000,
		source: 'probe',
		...overrides,
	};
}

const EMPTY_RESULT = {
	identities: 0,
	probed: 0,
	skippedFresh: 0,
	skippedNotInstalled: 0,
	byStatus: {},
};

function makeWindow(): {
	webContents: { send: ReturnType<typeof vi.fn>; isDestroyed: () => boolean };
} & {
	isDestroyed: () => boolean;
} {
	return {
		isDestroyed: () => false,
		webContents: { send: vi.fn(), isDestroyed: () => false },
	};
}

describe('Provider Auth IPC Handlers', () => {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const detector = { getAgent: vi.fn() } as unknown as never;
	const processManager = { spawn: vi.fn(), kill: vi.fn() } as unknown as never;

	function makeDeps(overrides: Record<string, unknown> = {}) {
		return {
			sessionsStore: { get: vi.fn().mockReturnValue([]) },
			agentConfigsStore: { get: vi.fn().mockReturnValue({}) },
			settingsStore: { get: vi.fn().mockReturnValue(undefined) },
			getAgentDetector: () => detector,
			getProcessManager: () => processManager,
			...overrides,
		} as Parameters<typeof registerProviderAuthHandlers>[0];
	}

	beforeEach(() => {
		vi.clearAllMocks();
		handlers.clear();
		mockWindows.length = 0;
		__resetForTests();
		mockRunStartupAuthProbe.mockResolvedValue({ ...EMPTY_RESULT, identities: 1, probed: 1 });
		vi.mocked(ipcMain.handle).mockImplementation(((channel: string, handler: never) => {
			handlers.set(channel, handler as unknown as (...args: unknown[]) => unknown);
		}) as never);
	});

	it('registers every provider auth channel', () => {
		registerProviderAuthHandlers(makeDeps());
		expect([...handlers.keys()].sort()).toEqual([
			'providerAuth:getAll',
			'providerAuth:mark',
			'providerAuth:reprobe',
			'providerAuth:reprobeAll',
			'providerAuth:startLogin',
			'providerAuth:stopLogin',
		]);
	});

	it('getAll returns every stored snapshot', async () => {
		registerProviderAuthHandlers(makeDeps());
		setSnapshot(KEY, makeSnapshot());

		const result = await handlers.get('providerAuth:getAll')!({});
		expect(result).toEqual({ [KEY]: makeSnapshot() });
	});

	it('reprobe runs a manual pass narrowed to the one key and returns the stored snapshot', async () => {
		registerProviderAuthHandlers(makeDeps());
		setSnapshot(KEY, makeSnapshot({ status: 'logged-out' }));

		const result = (await handlers.get('providerAuth:reprobe')!({}, KEY)) as {
			probed: number;
			snapshot: ProviderAuthSnapshot | null;
		};

		expect(mockRunStartupAuthProbe).toHaveBeenCalledTimes(1);
		expect(mockRunStartupAuthProbe.mock.calls[0][0]).toMatchObject({
			mode: 'manual',
			onlyKeys: [KEY],
		});
		expect(result.probed).toBe(1);
		expect(result.snapshot?.status).toBe('logged-out');
	});

	it('reprobeAll runs a manual pass with no key filter', async () => {
		registerProviderAuthHandlers(makeDeps());

		const result = await handlers.get('providerAuth:reprobeAll')!({});

		expect(mockRunStartupAuthProbe).toHaveBeenCalledTimes(1);
		const passedDeps = mockRunStartupAuthProbe.mock.calls[0][0] as Record<string, unknown>;
		expect(passedDeps.mode).toBe('manual');
		expect(passedDeps.onlyKeys).toBeUndefined();
		expect(result).toMatchObject({ probed: 1 });
	});

	it('skips the probe (rather than throwing) when the agent detector is not up yet', async () => {
		registerProviderAuthHandlers(makeDeps({ getAgentDetector: () => null }));

		const result = await handlers.get('providerAuth:reprobeAll')!({});

		expect(mockRunStartupAuthProbe).not.toHaveBeenCalled();
		expect(result).toEqual(EMPTY_RESULT);
	});

	it('mark flips a stored snapshot and keeps the identity', async () => {
		registerProviderAuthHandlers(makeDeps());
		setSnapshot(KEY, makeSnapshot({ accountLabel: 'dev@example.com' }));

		const result = (await handlers.get('providerAuth:mark')!({}, KEY, {
			detail: 'session expired',
			source: 'login-flow',
		})) as ProviderAuthSnapshot | null;

		expect(result).toMatchObject({
			status: 'logged-out',
			detail: 'session expired',
			source: 'login-flow',
			accountLabel: 'dev@example.com',
			identity: IDENTITY,
		});
	});

	it('mark falls back to error-pattern for an unrecognized source', async () => {
		registerProviderAuthHandlers(makeDeps());
		setSnapshot(KEY, makeSnapshot());

		const result = (await handlers.get('providerAuth:mark')!({}, KEY, {
			source: 'probe',
		})) as ProviderAuthSnapshot | null;

		// `probe` is a real source but not one a renderer may claim - it would
		// mean "a status command said so", which no renderer ever ran.
		expect(result?.source).toBe('error-pattern');
	});

	it('mark records an unsupported status for a credential no login can fix', async () => {
		registerProviderAuthHandlers(makeDeps());
		const apiKeyIdentity: CredentialIdentity = {
			key: 'claude-code::api-key::fp_1a2b3c4d::local',
			provider: 'claude-code',
			kind: 'api-key',
			scope: 'fp_1a2b3c4d',
			host: 'local',
			envVarName: 'ANTHROPIC_API_KEY',
			label: 'Claude Code fp_1a2b3c4d',
		};

		const result = (await handlers.get('providerAuth:mark')!({}, apiKeyIdentity.key, {
			status: 'unsupported',
			detail: 'ANTHROPIC_API_KEY was rejected.',
			identity: apiKeyIdentity,
		})) as ProviderAuthSnapshot | null;

		expect(result).toMatchObject({
			status: 'unsupported',
			identity: apiKeyIdentity,
			source: 'error-pattern',
		});
	});

	it('mark records a never-probed identity supplied by the caller', async () => {
		registerProviderAuthHandlers(makeDeps());

		const result = (await handlers.get('providerAuth:mark')!({}, KEY, {
			identity: IDENTITY,
			detail: 'not signed in',
		})) as ProviderAuthSnapshot | null;

		expect(result).toMatchObject({ status: 'logged-out', identity: IDENTITY });
	});

	it('mark rejects an identity filed under a different key', async () => {
		registerProviderAuthHandlers(makeDeps());

		const result = await handlers.get('providerAuth:mark')!({}, 'someone::else::key', {
			identity: IDENTITY,
		});

		// Nothing stored for that key and the identity does not belong to it, so
		// there is nothing to file the mark under.
		expect(result).toBeNull();
	});

	it('mark rejects a malformed identity rather than persisting it', async () => {
		registerProviderAuthHandlers(makeDeps());

		const result = await handlers.get('providerAuth:mark')!({}, KEY, {
			identity: { key: KEY, provider: 'claude-code' },
		});

		expect(result).toBeNull();
	});

	it('mark returns null for a key with nothing stored and no identity', async () => {
		registerProviderAuthHandlers(makeDeps());

		const result = await handlers.get('providerAuth:mark')!({}, 'unknown::key');
		expect(result).toBeNull();
	});

	it('mark ignores a status a renderer may not claim', async () => {
		registerProviderAuthHandlers(makeDeps());
		setSnapshot(KEY, makeSnapshot());

		const result = (await handlers.get('providerAuth:mark')!({}, KEY, {
			status: 'authenticated',
		})) as ProviderAuthSnapshot | null;

		// A renderer never ran a probe, so it cannot declare a credential healthy.
		expect(result?.status).toBe('logged-out');
	});

	it('broadcasts a snapshot write to every live window', () => {
		const winA = makeWindow();
		const winB = makeWindow();
		const destroyed = { isDestroyed: () => true, webContents: { send: vi.fn() } };
		mockWindows.push(winA, winB, destroyed);
		registerProviderAuthHandlers(makeDeps());

		setSnapshot(KEY, makeSnapshot());

		const expected = { key: KEY, snapshot: makeSnapshot() };
		expect(winA.webContents.send).toHaveBeenCalledWith('providerAuth:changed', expected);
		expect(winB.webContents.send).toHaveBeenCalledWith('providerAuth:changed', expected);
		expect(destroyed.webContents.send).not.toHaveBeenCalled();
	});

	it('broadcasts a null snapshot when a record is cleared', () => {
		const win = makeWindow();
		mockWindows.push(win);
		registerProviderAuthHandlers(makeDeps());
		setSnapshot(KEY, makeSnapshot());
		win.webContents.send.mockClear();

		clearSnapshot(KEY);

		expect(win.webContents.send).toHaveBeenCalledWith('providerAuth:changed', {
			key: KEY,
			snapshot: null,
		});
	});

	it('registering twice does not double-broadcast', () => {
		const win = makeWindow();
		mockWindows.push(win);
		registerProviderAuthHandlers(makeDeps());
		registerProviderAuthHandlers(makeDeps());

		setSnapshot(KEY, makeSnapshot());

		expect(win.webContents.send).toHaveBeenCalledTimes(1);
	});
});
