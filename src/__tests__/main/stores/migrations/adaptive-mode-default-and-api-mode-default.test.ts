// Source: src/__tests__/main/stores/migrations/adaptive-mode-default.test.ts
// Source: src/__tests__/main/stores/migrations/api-mode-default.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { migrateAdaptiveModeDefault } from '../../../../main/stores/migrations/adaptive-mode-default';
import { ADAPTIVE_MODE_DEFAULT_MIGRATION_MARKER } from '../../../../main/stores/migrations/adaptive-mode-default';
import { getSessionsStore } from '../../../../main/stores/getters';
import { migrateApiModeDefault } from '../../../../main/stores/migrations/api-mode-default';
import { API_MODE_DEFAULT_MIGRATION_MARKER } from '../../../../main/stores/migrations/api-mode-default';
vi.mock('../../../../main/stores/getters', () => ({
	getSessionsStore: vi.fn(),
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
describeSourceSuite('adaptive-mode-default', () => {
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

		// rc keeps Adaptive Mode default OFF for every agent type
		// (`isAdaptiveModeDefaultOn` returns false - the maestro-p TUI path has been a
		// recurring source of trouble, so we never flip anyone onto it automatically).
		// With the default off the migration backfills nobody: it leaves every
		// agent's explicit/undefined choice untouched and only stamps the marker.
		it('does not backfill any agent while the Adaptive Mode default is off, but still sets the marker', () => {
			const sessionsStore = makeStore({
				sessions: [
					{ id: 'a', toolType: 'claude-code', name: 'Claude' },
					{ id: 'b', toolType: 'codex', name: 'Codex' },
					{ id: 'c', toolType: 'claude-code', name: 'Already on', enableMaestroP: true },
					// Explicit API choice (false) must survive untouched - flipping it on
					// would silently revert the user's token source to Dynamic.
					{ id: 'd', toolType: 'claude-code', name: 'Picked API', enableMaestroP: false },
				],
			});
			mockedGetSessionsStore.mockReturnValue(sessionsStore as any);
			const settingsStore = makeStore();

			migrateAdaptiveModeDefault(settingsStore as any);

			expect(sessionsStore.set).not.toHaveBeenCalled();
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

		it('is idempotent - does nothing once the marker is set', () => {
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
});
describeSourceSuite('api-mode-default', () => {
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
});
