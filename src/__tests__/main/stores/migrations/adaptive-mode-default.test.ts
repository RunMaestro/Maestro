import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the sessions-store getter and logger the migration depends on.
vi.mock('../../../../main/stores/getters', () => ({
	getSessionsStore: vi.fn(),
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

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

	it('enables Adaptive Mode on existing Claude Code agents and leaves others untouched', () => {
		const sessionsStore = makeStore({
			sessions: [
				{ id: 'a', toolType: 'claude-code', name: 'Claude' },
				{ id: 'b', toolType: 'codex', name: 'Codex' },
				{ id: 'c', toolType: 'claude-code', name: 'Already on', enableMaestroP: true },
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
		]);
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
