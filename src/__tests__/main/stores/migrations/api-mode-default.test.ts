import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the sessions-store getter and logger the migration depends on.
vi.mock('../../../../main/stores/getters', () => ({
	getSessionsStore: vi.fn(),
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	migrateApiModeDefault,
	API_MODE_DEFAULT_MIGRATION_MARKER,
} from '../../../../main/stores/migrations/api-mode-default';
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

describe('migrateApiModeDefault', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('forces every Claude Code agent back to API, including TUI/Dynamic, and leaves other agents alone', () => {
		const sessionsStore = makeStore({
			sessions: [
				// Never configured (auto-flipped onto Adaptive by the prior migration).
				{ id: 'a', toolType: 'claude-code', name: 'Unset' },
				// Other agent types are untouched - enableMaestroP is Claude-only.
				{ id: 'b', toolType: 'codex', name: 'Codex' },
				// Hand-picked Dynamic - reset to API per the blanket cutover.
				{
					id: 'c',
					toolType: 'claude-code',
					name: 'Dynamic',
					enableMaestroP: true,
					maestroPMode: 'dynamic',
				},
				// Hand-picked TUI - also reset; maestroPMode is preserved (ignored while off).
				{
					id: 'd',
					toolType: 'claude-code',
					name: 'TUI',
					enableMaestroP: true,
					maestroPMode: 'interactive',
				},
				// Already API - left exactly as-is, not counted as an update.
				{ id: 'e', toolType: 'claude-code', name: 'API', enableMaestroP: false },
			],
		});
		mockedGetSessionsStore.mockReturnValue(sessionsStore as any);
		const settingsStore = makeStore();

		migrateApiModeDefault(settingsStore as any);

		const written = sessionsStore.set.mock.calls[0][1];
		expect(written).toEqual([
			{ id: 'a', toolType: 'claude-code', name: 'Unset', enableMaestroP: false },
			{ id: 'b', toolType: 'codex', name: 'Codex' },
			{
				id: 'c',
				toolType: 'claude-code',
				name: 'Dynamic',
				enableMaestroP: false,
				maestroPMode: 'dynamic',
			},
			{
				id: 'd',
				toolType: 'claude-code',
				name: 'TUI',
				enableMaestroP: false,
				maestroPMode: 'interactive',
			},
			{ id: 'e', toolType: 'claude-code', name: 'API', enableMaestroP: false },
		]);
		expect(settingsStore.data[API_MODE_DEFAULT_MIGRATION_MARKER]).toBe(true);
	});

	it('sets the marker without writing sessions when every Claude Code agent is already API', () => {
		const sessionsStore = makeStore({
			sessions: [
				{ id: 'e', toolType: 'claude-code', name: 'API', enableMaestroP: false },
				{ id: 'b', toolType: 'codex', name: 'Codex' },
			],
		});
		mockedGetSessionsStore.mockReturnValue(sessionsStore as any);
		const settingsStore = makeStore();

		migrateApiModeDefault(settingsStore as any);

		expect(sessionsStore.set).not.toHaveBeenCalled();
		expect(settingsStore.data[API_MODE_DEFAULT_MIGRATION_MARKER]).toBe(true);
	});

	it('is idempotent - does nothing once the marker is set', () => {
		const sessionsStore = makeStore({
			sessions: [{ id: 'a', toolType: 'claude-code', name: 'Claude', enableMaestroP: true }],
		});
		mockedGetSessionsStore.mockReturnValue(sessionsStore as any);
		const settingsStore = makeStore({ [API_MODE_DEFAULT_MIGRATION_MARKER]: true });

		migrateApiModeDefault(settingsStore as any);

		expect(mockedGetSessionsStore).not.toHaveBeenCalled();
		expect(sessionsStore.set).not.toHaveBeenCalled();
	});
});
