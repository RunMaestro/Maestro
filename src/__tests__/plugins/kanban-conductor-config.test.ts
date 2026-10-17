/**
 * @file kanban-conductor-config.test.ts
 * @description Tests for Phase 06's conductor configuration model inside
 * `examples/plugins/maestro-kanban/main.js`: the per-board stored choice of
 * provider agent id, custom model, and custom effort, before anything is
 * turned into a running conductor session. That session plumbing (creating
 * it, keeping its reach in sync) is covered separately once it exists, by
 * `kanban-conductor.test.ts`.
 *
 * `normalizeConductorConfig()` is a pure export, called straight through the
 * same way `kanban-aging.test.ts` calls `normalizeAgingSettings()`. The
 * stored map itself is only observable through `activate()` plus
 * `setConductorConfig()`/`conductorConfigForBoard()` and the stub
 * `maestro.storage` they read and write, mirroring that file's board
 * settings tests.
 */

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mainPath = require.resolve('../../../examples/plugins/maestro-kanban/main.js');

interface ConductorConfig {
	agentId: string | null;
	customModel: string | null;
	customEffort: string | null;
}

interface KanbanConductorConfig {
	DEFAULT_CONDUCTOR_CONFIG: ConductorConfig;
	normalizeConductorConfig: (raw: unknown) => ConductorConfig;
	conductorConfigForBoard: (boardId: string | null) => ConductorConfig;
	setConductorConfig: (boardId: string, patch: unknown) => Promise<ConductorConfig>;
	GLOBAL_BOARD_ID: string;
	activate: (maestro: unknown) => Promise<void>;
}

/** Fresh module state per test: main.js keeps its stored maps in
 * module-level variables, so the require cache entry must be dropped before
 * every require(). Mirrors kanban-aging.test.ts's loadMain(). */
function loadMain(): KanbanConductorConfig {
	delete require.cache[mainPath];
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require(mainPath) as KanbanConductorConfig;
}

/** An in-memory `maestro.storage` backed by a plain Map, trimmed to what the
 * conductor configuration model reads. Mirrors kanban-aging.test.ts's
 * createStubMaestro(), trimmed further since this model never touches
 * `fs`, `tabs`, or `sessions`. */
function createStubMaestro(storage: Record<string, string> = {}) {
	const storageStore = new Map<string, string>(Object.entries(storage));

	const maestro = {
		events: {
			on: vi.fn(),
			subscribe: vi.fn(() => Promise.resolve({ ok: true })),
			unsubscribe: vi.fn(() => Promise.resolve({ ok: true })),
		},
		commands: { register: vi.fn() },
		sessions: {
			list: vi.fn(() => Promise.resolve([])),
			focus: vi.fn(() => Promise.resolve({ ok: true })),
			requestAccess: vi.fn(() => Promise.resolve({ granted: true })),
		},
		agents: { dispatch: vi.fn(() => Promise.resolve({ ok: true })) },
		tabs: {
			list: vi.fn(() => Promise.resolve([])),
			close: vi.fn(() => Promise.resolve({ ok: true })),
		},
		ui: {
			panelPost: vi.fn(() => Promise.resolve({ ok: true })),
			togglePanel: vi.fn(() => Promise.resolve({ ok: true })),
		},
		notifications: { toast: vi.fn(() => Promise.resolve({ ok: true })) },
		fs: {
			read: vi.fn(() => Promise.reject(new Error('ENOENT'))),
			write: vi.fn(() => Promise.resolve({ ok: true })),
		},
		storage: {
			get: vi.fn((key: string) =>
				Promise.resolve(storageStore.has(key) ? storageStore.get(key) : null)
			),
			set: vi.fn((key: string, value: string) => {
				storageStore.set(key, value);
				return Promise.resolve({ ok: true });
			}),
			delete: vi.fn((key: string) => {
				storageStore.delete(key);
				return Promise.resolve({ ok: true });
			}),
			keys: vi.fn(() => Promise.resolve(Array.from(storageStore.keys()))),
		},
	};

	return { maestro, storageStore };
}

describe('maestro-kanban normalizeConductorConfig', () => {
	it('defaults every field to unset', () => {
		const plugin = loadMain();
		expect(plugin.normalizeConductorConfig(undefined)).toEqual({
			agentId: null,
			customModel: null,
			customEffort: null,
		});
		expect(plugin.DEFAULT_CONDUCTOR_CONFIG).toEqual({
			agentId: null,
			customModel: null,
			customEffort: null,
		});
	});

	it('keeps a well-formed configuration as given', () => {
		const plugin = loadMain();
		expect(
			plugin.normalizeConductorConfig({
				agentId: 'claude-code',
				customModel: 'opus',
				customEffort: 'high',
			})
		).toEqual({ agentId: 'claude-code', customModel: 'opus', customEffort: 'high' });
	});

	it('collapses blank, non-string, and missing fields to unset independently', () => {
		const plugin = loadMain();
		expect(
			plugin.normalizeConductorConfig({ agentId: '   ', customModel: 42, customEffort: null })
		).toEqual({ agentId: null, customModel: null, customEffort: null });
		expect(plugin.normalizeConductorConfig({ agentId: 'codex' })).toEqual({
			agentId: 'codex',
			customModel: null,
			customEffort: null,
		});
	});

	it('trims surrounding whitespace on an otherwise valid value', () => {
		const plugin = loadMain();
		expect(plugin.normalizeConductorConfig({ agentId: '  codex  ' }).agentId).toBe('codex');
	});

	it('treats a non-object or an array as fully unset', () => {
		const plugin = loadMain();
		expect(plugin.normalizeConductorConfig('claude-code')).toEqual(plugin.DEFAULT_CONDUCTOR_CONFIG);
		expect(plugin.normalizeConductorConfig(['claude-code'])).toEqual(
			plugin.DEFAULT_CONDUCTOR_CONFIG
		);
		expect(plugin.normalizeConductorConfig(null)).toEqual(plugin.DEFAULT_CONDUCTOR_CONFIG);
	});
});

describe('maestro-kanban conductor configuration storage', () => {
	const boardId = '/Users/dev/projects/widgets';

	it('reports no conductor for a board that has never been configured', async () => {
		const plugin = loadMain();
		const { maestro } = createStubMaestro();
		await plugin.activate(maestro);

		expect(plugin.conductorConfigForBoard(boardId)).toEqual(plugin.DEFAULT_CONDUCTOR_CONFIG);
		expect(plugin.conductorConfigForBoard(null)).toEqual(plugin.DEFAULT_CONDUCTOR_CONFIG);
	});

	it("persists a board's conductor configuration and merges a later partial patch over it", async () => {
		const plugin = loadMain();
		const { maestro, storageStore } = createStubMaestro();
		await plugin.activate(maestro);

		await plugin.setConductorConfig(boardId, { agentId: 'claude-code', customModel: 'opus' });
		expect(JSON.parse(storageStore.get('conductor-config') as string)).toEqual({
			[boardId]: { agentId: 'claude-code', customModel: 'opus', customEffort: null },
		});

		// A single field posted on its own keeps the rest already stored.
		const merged = await plugin.setConductorConfig(boardId, { customEffort: 'high' });
		expect(merged).toEqual({ agentId: 'claude-code', customModel: 'opus', customEffort: 'high' });
	});

	it('clears a field by posting it as null explicitly', async () => {
		const plugin = loadMain();
		const { maestro } = createStubMaestro();
		await plugin.activate(maestro);

		await plugin.setConductorConfig(boardId, { agentId: 'codex', customModel: 'o1' });
		const cleared = await plugin.setConductorConfig(boardId, { customModel: null });
		expect(cleared).toEqual({ agentId: 'codex', customModel: null, customEffort: null });
	});

	it('does not write to storage when a patch changes nothing', async () => {
		const plugin = loadMain();
		const { maestro } = createStubMaestro();
		await plugin.activate(maestro);

		await plugin.setConductorConfig(boardId, { agentId: 'codex' });
		const setCalls = (maestro.storage.set as ReturnType<typeof vi.fn>).mock.calls.length;

		const unchanged = await plugin.setConductorConfig(boardId, { agentId: 'codex' });
		expect(unchanged).toEqual({ agentId: 'codex', customModel: null, customEffort: null });
		expect((maestro.storage.set as ReturnType<typeof vi.fn>).mock.calls.length).toBe(setCalls);
	});

	it('restores stored configuration on the next activate', async () => {
		const first = loadMain();
		const { maestro, storageStore } = createStubMaestro();
		await first.activate(maestro);
		await first.setConductorConfig(boardId, { agentId: 'claude-code', customEffort: 'medium' });

		const second = loadMain();
		const { maestro: secondMaestro } = createStubMaestro(Object.fromEntries(storageStore));
		await second.activate(secondMaestro);

		expect(second.conductorConfigForBoard(boardId)).toEqual({
			agentId: 'claude-code',
			customModel: null,
			customEffort: 'medium',
		});
	});

	it('keeps each board independent, with no Global board fallback', async () => {
		const plugin = loadMain();
		const { maestro } = createStubMaestro();
		await plugin.activate(maestro);

		await plugin.setConductorConfig(plugin.GLOBAL_BOARD_ID, { agentId: 'claude-code' });

		// A project board is unaffected by the Global board's configuration -
		// unlike aging settings, a conductor has no implicit default to inherit.
		expect(plugin.conductorConfigForBoard(boardId)).toEqual(plugin.DEFAULT_CONDUCTOR_CONFIG);
		expect(plugin.conductorConfigForBoard(plugin.GLOBAL_BOARD_ID)).toEqual({
			agentId: 'claude-code',
			customModel: null,
			customEffort: null,
		});
	});

	it('degrades to no conductor configured anywhere when stored JSON is unreadable', async () => {
		const plugin = loadMain();
		const { maestro } = createStubMaestro({ 'conductor-config': 'not json' });
		await plugin.activate(maestro);

		expect(plugin.conductorConfigForBoard(boardId)).toEqual(plugin.DEFAULT_CONDUCTOR_CONFIG);
	});
});
