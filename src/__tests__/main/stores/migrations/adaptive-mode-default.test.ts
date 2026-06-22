import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the sessions-store getter and logger the migration depends on.
vi.mock('../../../../main/stores/getters', () => ({
	getSessionsStore: vi.fn(),
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// The product default for Adaptive Mode is currently OFF for every agent
// (`isAdaptiveModeDefaultOn` returns false - new Claude Code agents default to the
// API token source). This migration exists to backfill existing agents IF that
// default is on, so we pin the historical "on for Claude Code" behavior here to
// exercise the backfill mechanism itself, decoupled from today's default value.
// Codex stays off so the "other agents are untouched" assertions still hold.
vi.mock('../../../../shared/agentConstants', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../../shared/agentConstants')>();
	return {
		...actual,
		isAdaptiveModeDefaultOn: (agentId: string) => agentId === 'claude-code',
	};
});

import {
	migrateAdaptiveModeDefault,
	ADAPTIVE_MODE_DEFAULT_MIGRATION_MARKER,
} from '../../../../main/stores/migrations/adaptive-mode-default';
import { getSessionsStore } from '../../../../main/stores/getters';

const mockedGetSessionsStore = vi.mocked(getSessionsStore);

/** Minimal in-memory electron-store double backed by a plain record. */
function makeStore(initial: Record<string, any> = {}) {
	const data: Record<string, any> = { ...initial };
	return {
		data,
		get: vi.fn((key: string, fallback?: any) => (key in data ? data[key] : fallback)),
		set: vi.fn((key: string, value: any) => {
			data[key] = value;
		}),
	};
}

describe('migrateAdaptiveModeDefault', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('backfills only never-configured Claude Code agents, preserving explicit choices and other agents', () => {
		const sessionsStore = makeStore({
			sessions: [
				{ id: 'a', toolType: 'claude-code', name: 'Claude' },
				{ id: 'b', toolType: 'codex', name: 'Codex' },
				{ id: 'c', toolType: 'claude-code', name: 'Already on', enableMaestroP: true },
				// Explicit API choice (false) must survive the backfill - flipping it
				// on would silently revert the user's token source to Dynamic.
				{ id: 'd', toolType: 'claude-code', name: 'Picked API', enableMaestroP: false },
			],
		});
		mockedGetSessionsStore.mockReturnValue(sessionsStore as any);
		const settingsStore = makeStore();

		migrateAdaptiveModeDefault(settingsStore as any);

		const written = sessionsStore.set.mock.calls[0][1];
		expect(written).toEqual([
			{ id: 'a', toolType: 'claude-code', name: 'Claude', enableMaestroP: true },
			{ id: 'b', toolType: 'codex', name: 'Codex' },
			{ id: 'c', toolType: 'claude-code', name: 'Already on', enableMaestroP: true },
			{ id: 'd', toolType: 'claude-code', name: 'Picked API', enableMaestroP: false },
		]);
		expect(settingsStore.data[ADAPTIVE_MODE_DEFAULT_MIGRATION_MARKER]).toBe(true);
	});

	it('sets the marker without writing sessions when every agent already has an explicit choice', () => {
		const sessionsStore = makeStore({
			sessions: [
				{ id: 'c', toolType: 'claude-code', name: 'On', enableMaestroP: true },
				{ id: 'd', toolType: 'claude-code', name: 'API', enableMaestroP: false },
			],
		});
		mockedGetSessionsStore.mockReturnValue(sessionsStore as any);
		const settingsStore = makeStore();

		migrateAdaptiveModeDefault(settingsStore as any);

		expect(sessionsStore.set).not.toHaveBeenCalled();
		expect(settingsStore.data[ADAPTIVE_MODE_DEFAULT_MIGRATION_MARKER]).toBe(true);
	});

	it('sets the marker without writing sessions when nothing needs updating', () => {
		const sessionsStore = makeStore({
			sessions: [{ id: 'b', toolType: 'codex', name: 'Codex' }],
		});
		mockedGetSessionsStore.mockReturnValue(sessionsStore as any);
		const settingsStore = makeStore();

		migrateAdaptiveModeDefault(settingsStore as any);

		expect(sessionsStore.set).not.toHaveBeenCalled();
		expect(settingsStore.data[ADAPTIVE_MODE_DEFAULT_MIGRATION_MARKER]).toBe(true);
	});

	it('is idempotent — does nothing once the marker is set', () => {
		const sessionsStore = makeStore({
			sessions: [{ id: 'a', toolType: 'claude-code', name: 'Claude' }],
		});
		mockedGetSessionsStore.mockReturnValue(sessionsStore as any);
		const settingsStore = makeStore({ [ADAPTIVE_MODE_DEFAULT_MIGRATION_MARKER]: true });

		migrateAdaptiveModeDefault(settingsStore as any);

		expect(mockedGetSessionsStore).not.toHaveBeenCalled();
		expect(sessionsStore.set).not.toHaveBeenCalled();
	});
});
