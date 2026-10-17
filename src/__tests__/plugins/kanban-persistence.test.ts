/**
 * @file kanban-persistence.test.ts
 * @description Tests for the Phase 02 filesystem plumbing (`boardFilePath`,
 * `loadProjectBoard`, `loadGlobalBoard`, `saveProjectBoard`) and placement
 * persistence inside `examples/plugins/maestro-kanban/main.js`. Placement
 * persistence (`resolveCardColumnId`, `prunePlacements`, ...) is not exported
 * - per that task's own completion notes, its behavior is only observable
 * end-to-end through `activate()`'s resulting panel snapshot and the stub
 * `maestro.storage`/`maestro.fs`, the same style `kanban-main.test.ts` uses
 * for the rest of this plugin.
 *
 * Phase 03's `move` command handler is tested here too, for the same reason:
 * it is reached through `maestro.commands.register('move', ...)` and the only
 * thing it is observable through is the placement store plus the snapshot it
 * pushes afterwards.
 */

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mainPath = require.resolve('../../../examples/plugins/maestro-kanban/main.js');

interface KanbanSnapshot {
	columns: { id: string; title: string; cards: { key: string }[] }[];
	boardId?: string | null;
	moveRejection?: { cardKey: string; reason: string } | null;
}

interface KanbanPlugin {
	boardFilePath: (projectPath: string | null | undefined) => string;
	loadProjectBoard: (
		projectPath: string
	) => Promise<{ board: unknown; error: { message: string; path: string } | null }>;
	loadGlobalBoard: () => Promise<{
		board: unknown;
		error: { message: string; path: string } | null;
	}>;
	saveProjectBoard: (projectPath: string, board: unknown) => Promise<unknown>;
	projectBoardSlug: (projectPath: string) => string;
	DEFAULT_COLUMNS: { id: string; title: string }[];
	activate: (maestro: unknown) => Promise<void>;
}

/** Fresh module state per test: main.js keeps its board/placement caches in
 * module-level variables, so the require cache entry must be dropped before
 * every require(). Mirrors kanban-main.test.ts's loadMain(). */
function loadMain(): KanbanPlugin {
	delete require.cache[mainPath];
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require(mainPath) as KanbanPlugin;
}

interface StubOptions {
	files?: Record<string, string>;
	storage?: Record<string, string>;
	sessionsList?: () => Promise<unknown>;
	tabsList?: () => Promise<unknown>;
}

/** An in-memory `maestro.fs`/`maestro.storage` backed by plain Maps, so a
 * test can both seed starting state and inspect what main.js ultimately
 * persisted, rather than only asserting on individual mock call arguments. */
function createStubMaestro(options: StubOptions = {}) {
	const files = new Map<string, string>(Object.entries(options.files ?? {}));
	const storageStore = new Map<string, string>(Object.entries(options.storage ?? {}));
	const commandHandlers = new Map<string, (args?: unknown) => unknown>();

	const maestro = {
		events: {
			on: vi.fn(),
			subscribe: vi.fn(() => Promise.resolve({ ok: true })),
			unsubscribe: vi.fn(() => Promise.resolve({ ok: true })),
		},
		commands: {
			register: vi.fn((commandId: string, handler: (args?: unknown) => unknown) => {
				commandHandlers.set(commandId, handler);
			}),
		},
		sessions: {
			list: vi.fn(options.sessionsList ?? (() => Promise.resolve([]))),
			focus: vi.fn(() => Promise.resolve({ ok: true })),
		},
		tabs: {
			list: vi.fn(options.tabsList ?? (() => Promise.resolve([]))),
		},
		ui: {
			panelPost: vi.fn(() => Promise.resolve({ ok: true })),
			togglePanel: vi.fn(() => Promise.resolve({ ok: true })),
		},
		notifications: {
			toast: vi.fn(() => Promise.resolve({ ok: true })),
		},
		fs: {
			read: vi.fn((path: string) => {
				if (files.has(path)) return Promise.resolve(files.get(path));
				return Promise.reject(new Error("ENOENT: no such file or directory, open '" + path + "'"));
			}),
			write: vi.fn((path: string, contents: string) => {
				files.set(path, contents);
				return Promise.resolve({ ok: true });
			}),
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

	return { maestro, files, storageStore, commandHandlers };
}

function aiTab(overrides: Record<string, unknown> = {}) {
	return {
		id: 'tab-1',
		sessionId: 'session-1',
		type: 'ai',
		title: 'My Tab',
		status: 'idle',
		createdAt: 1,
		...overrides,
	};
}

function findCard(snapshot: KanbanSnapshot, key: string) {
	for (const column of snapshot.columns) {
		const card = column.cards.find((c) => c.key === key);
		if (card) return { card, columnId: column.id };
	}
	return undefined;
}

describe('maestro-kanban filesystem plumbing and placement persistence', () => {
	it('lets a stored placement win over what deriveColumn would pick for a now-busy card', async () => {
		const plugin = loadMain();
		const projectPath = '/Users/dev/projects/widgets';
		const boardPath = plugin.boardFilePath(projectPath);
		const key = 'session-1::tab-1';
		const { maestro } = createStubMaestro({
			storage: { ['placements:' + boardPath]: JSON.stringify({ [key]: 'backlog' }) },
			tabsList: () => Promise.resolve([aiTab({ projectPath, status: 'busy' })]),
		});

		await plugin.activate(maestro);

		const snapshot = maestro.ui.panelPost.mock.calls[0]![1] as KanbanSnapshot;
		// deriveColumn would land a 'busy' card on 'in-progress'; the stored
		// placement of 'backlog' must win instead.
		expect(findCard(snapshot, key)?.columnId).toBe('backlog');
	});

	it('repairs a placement naming a column the board no longer has to the first legal column', async () => {
		const plugin = loadMain();
		const projectPath = '/Users/dev/projects/widgets';
		const boardPath = plugin.boardFilePath(projectPath);
		const key = 'session-1::tab-1';
		const { maestro, storageStore } = createStubMaestro({
			storage: { ['placements:' + boardPath]: JSON.stringify({ [key]: 'archived' }) },
			tabsList: () => Promise.resolve([aiTab({ projectPath, status: 'idle' })]),
		});

		await plugin.activate(maestro);

		const snapshot = maestro.ui.panelPost.mock.calls[0]![1] as KanbanSnapshot;
		expect(findCard(snapshot, key)?.columnId).toBe(plugin.DEFAULT_COLUMNS[0]!.id);
		const persisted = JSON.parse(storageStore.get('placements:' + boardPath) as string) as Record<
			string,
			string
		>;
		expect(persisted[key]).toBe(plugin.DEFAULT_COLUMNS[0]!.id);
	});

	it('prunes placements for card keys whose tab no longer exists, once, on activate', async () => {
		const plugin = loadMain();
		const projectPath = '/Users/dev/projects/widgets';
		const boardPath = plugin.boardFilePath(projectPath);
		const liveKey = 'session-1::tab-1';
		const vanishedKey = 'session-9::tab-9';
		const { maestro, storageStore } = createStubMaestro({
			storage: {
				['placements:' + boardPath]: JSON.stringify({
					[liveKey]: 'backlog',
					[vanishedKey]: 'done',
				}),
			},
			tabsList: () =>
				Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1', projectPath })]),
		});

		await plugin.activate(maestro);

		const persisted = JSON.parse(storageStore.get('placements:' + boardPath) as string);
		expect(persisted).toEqual({ [liveKey]: 'backlog' });
		// The live card's placement was already legal and unchanged, so the
		// only write should be the one prunePlacements() made for the vanished
		// key - prunePlacements() runs exactly once, right after activate()'s
		// first seed(), never on every event.
		expect(maestro.storage.set).toHaveBeenCalledTimes(1);
	});

	it("saveProjectBoard refuses to overwrite a project board file the parser can't read", async () => {
		const plugin = loadMain();
		const projectPath = '/Users/dev/projects/widgets';
		const boardPath = plugin.boardFilePath(projectPath);
		// Missing the required `version` key - parseBoardYaml rejects it.
		const brokenYaml = 'project: ' + projectPath + '\ncolumns:\n  - id: x\n    title: X\n';
		const { maestro } = createStubMaestro({ files: { [boardPath]: brokenYaml } });

		await plugin.activate(maestro);
		maestro.fs.write.mockClear();

		await expect(
			plugin.saveProjectBoard(projectPath, {
				version: 1,
				project: projectPath,
				columns: plugin.DEFAULT_COLUMNS,
			})
		).rejects.toThrow('version is required');
		expect(maestro.fs.write).not.toHaveBeenCalled();
	});

	it('treats a missing board file as "use defaults" rather than an error', async () => {
		const plugin = loadMain();
		const projectPath = '/Users/dev/projects/widgets';
		const { maestro } = createStubMaestro();

		await plugin.activate(maestro);

		await expect(plugin.loadProjectBoard(projectPath)).resolves.toEqual({
			board: null,
			error: null,
		});
		await expect(plugin.loadGlobalBoard()).resolves.toEqual({ board: null, error: null });
	});

	it('reads the global board from the literal path ~/.maestro/kanban.yaml', async () => {
		const plugin = loadMain();
		const globalYaml = 'version: 1\ncolumns:\n  - id: backlog\n    title: Backlog\n';
		const { maestro } = createStubMaestro({ files: { '~/.maestro/kanban.yaml': globalYaml } });

		await plugin.activate(maestro);

		expect(plugin.boardFilePath(null)).toBe('~/.maestro/kanban.yaml');
		const result = await plugin.loadGlobalBoard();
		expect(result.error).toBeNull();
		expect(result.board).toEqual({
			version: 1,
			columns: [{ id: 'backlog', title: 'Backlog' }],
		});
		expect(maestro.fs.read).toHaveBeenCalledWith('~/.maestro/kanban.yaml');
	});

	it('reads a project board from ~/.maestro/kanban-boards/<slug>.yaml', async () => {
		const plugin = loadMain();
		const projectPath = '/Users/dev/projects/widgets';
		const slug = plugin.projectBoardSlug(projectPath);
		const boardPath = '~/.maestro/kanban-boards/' + slug + '.yaml';
		const boardYaml =
			'version: 1\nproject: ' + projectPath + '\ncolumns:\n  - id: backlog\n    title: Backlog\n';
		const { maestro } = createStubMaestro({ files: { [boardPath]: boardYaml } });

		await plugin.activate(maestro);

		expect(plugin.boardFilePath(projectPath)).toBe(boardPath);
		const result = await plugin.loadProjectBoard(projectPath);
		expect(result.error).toBeNull();
		expect(result.board).toEqual({
			version: 1,
			project: projectPath,
			columns: [{ id: 'backlog', title: 'Backlog' }],
		});
	});

	it('rejects a project board file whose project key does not match the path it was loaded for', async () => {
		const plugin = loadMain();
		const projectPath = '/Users/dev/projects/widgets';
		const otherPath = '/Users/dev/projects/other';
		const boardPath = plugin.boardFilePath(projectPath);
		const boardYaml =
			'version: 1\nproject: ' + otherPath + '\ncolumns:\n  - id: backlog\n    title: Backlog\n';
		const { maestro } = createStubMaestro({ files: { [boardPath]: boardYaml } });

		await plugin.activate(maestro);

		const result = await plugin.loadProjectBoard(projectPath);
		expect(result.board).toBeNull();
		expect(result.error).toEqual({
			message:
				"board's project (" +
				otherPath +
				') does not match the file it was read from (' +
				projectPath +
				')',
			path: boardPath,
		});
	});

	it('boardFilePath refuses every path other than null/undefined (global) or a non-empty string', () => {
		const plugin = loadMain();
		const message = 'boardFilePath requires a non-empty project path, or null for the global board';

		expect(plugin.boardFilePath(null)).toBe('~/.maestro/kanban.yaml');
		expect(plugin.boardFilePath(undefined)).toBe('~/.maestro/kanban.yaml');
		expect(() => plugin.boardFilePath('')).toThrow(message);
		expect(() => plugin.boardFilePath(42 as unknown as string)).toThrow(message);
		expect(() => plugin.boardFilePath({} as unknown as string)).toThrow(message);
		expect(() => plugin.boardFilePath([] as unknown as string)).toThrow(message);
	});
});

describe('maestro-kanban move command', () => {
	const projectPath = '/Users/dev/projects/widgets';

	/** Activates the plugin with `tabs` in `projectPath`, then hands back the
	 * registered `move` handler plus the stubs to assert against. */
	async function activateWithTabs(tabs: Record<string, unknown>[]) {
		const plugin = loadMain();
		const boardPath = plugin.boardFilePath(projectPath);
		const stub = createStubMaestro({ tabsList: () => Promise.resolve(tabs) });
		await plugin.activate(stub.maestro);
		const move = stub.commandHandlers.get('move');
		if (!move) throw new Error('main.js never registered a "move" command');
		return { plugin, boardPath, move, ...stub };
	}

	function lastSnapshot(maestro: { ui: { panelPost: { mock: { calls: unknown[][] } } } }) {
		const calls = maestro.ui.panelPost.mock.calls;
		return calls[calls.length - 1]![1] as KanbanSnapshot;
	}

	it('applies a legal move, persists the placement, and pushes a fresh snapshot', async () => {
		const key = 'session-1::tab-1';
		const { boardPath, move, maestro, storageStore } = await activateWithTabs([
			aiTab({ projectPath }),
		]);

		const result = await move({ cardKey: key, toColumnId: 'review', toIndex: 0, boardId: null });

		expect(result).toEqual({ ok: true, columnId: 'review', index: 0 });
		expect(findCard(lastSnapshot(maestro), key)?.columnId).toBe('review');
		const persisted = JSON.parse(storageStore.get('placements:' + boardPath) as string);
		expect(persisted[key]).toBe('review');
	});

	it('honours toIndex, placing a moved card above a card already in the column', async () => {
		const first = 'session-1::tab-1';
		const second = 'session-1::tab-2';
		const { move, maestro } = await activateWithTabs([
			aiTab({ id: 'tab-1', projectPath, createdAt: 1 }),
			aiTab({ id: 'tab-2', projectPath, createdAt: 2 }),
		]);
		// Both land on 'backlog' in createdAt order to start with.
		const before = lastSnapshot(maestro).columns.find((c) => c.id === 'backlog');
		expect(before?.cards.map((c) => c.key)).toEqual([first, second]);

		await move({ cardKey: second, toColumnId: 'backlog', toIndex: 0, boardId: null });

		const after = lastSnapshot(maestro).columns.find((c) => c.id === 'backlog');
		expect(after?.cards.map((c) => c.key)).toEqual([second, first]);
	});

	it('re-checks legality itself and refuses a column the card cannot reach', async () => {
		const key = 'session-1::tab-1';
		const { move, maestro, storageStore, boardPath } = await activateWithTabs([
			aiTab({ projectPath }),
		]);
		maestro.storage.set.mockClear();

		const result = (await move({
			cardKey: key,
			toColumnId: 'archived',
			toIndex: 0,
			boardId: null,
		})) as { ok: boolean; reason: string };

		expect(result.ok).toBe(false);
		expect(result.reason).toBe('"archived" is not a column that card can move to');
		// The refusal rides the next snapshot, since the panel bridge is one-way.
		expect(lastSnapshot(maestro).moveRejection).toEqual({
			cardKey: key,
			reason: '"archived" is not a column that card can move to',
		});
		// The card stayed where it was and nothing was written.
		expect(findCard(lastSnapshot(maestro), key)?.columnId).toBe('backlog');
		expect(maestro.storage.set).not.toHaveBeenCalled();
		const persisted = JSON.parse(storageStore.get('placements:' + boardPath) as string);
		expect(persisted[key]).toBe('backlog');
	});

	it('refuses a move naming a card that is no longer on the board', async () => {
		const { move, maestro } = await activateWithTabs([aiTab({ projectPath })]);

		const result = (await move({
			cardKey: 'session-9::tab-9',
			toColumnId: 'review',
			toIndex: 0,
			boardId: null,
		})) as { ok: boolean; reason: string };

		expect(result.ok).toBe(false);
		expect(result.reason).toBe('that card is no longer on the board');
		expect(lastSnapshot(maestro).moveRejection?.cardKey).toBe('session-9::tab-9');
	});

	it('refuses a move whose boardId names a board the panel is no longer on', async () => {
		const key = 'session-1::tab-1';
		const { move, maestro } = await activateWithTabs([aiTab({ projectPath })]);

		const result = (await move({
			cardKey: key,
			toColumnId: 'review',
			toIndex: 0,
			boardId: 'some-other-board',
		})) as { ok: boolean; reason: string };

		expect(result.ok).toBe(false);
		expect(result.reason).toBe('the board changed while the card was moving; try again');
		expect(findCard(lastSnapshot(maestro), key)?.columnId).toBe('backlog');
	});

	it('refuses a move for a card whose agent has no project folder to remember it under', async () => {
		const key = 'session-1::tab-1';
		const { move, maestro } = await activateWithTabs([aiTab({})]);

		const result = (await move({
			cardKey: key,
			toColumnId: 'review',
			toIndex: 0,
			boardId: null,
		})) as { ok: boolean; reason: string };

		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'that agent has no project folder, so the board cannot remember a move'
		);
	});

	it('drains a rejection after one snapshot rather than repeating it forever', async () => {
		const key = 'session-1::tab-1';
		const { move, maestro } = await activateWithTabs([aiTab({ projectPath })]);

		await move({ cardKey: key, toColumnId: 'archived', toIndex: 0, boardId: null });
		expect(lastSnapshot(maestro).moveRejection).not.toBeNull();

		// A later, unrelated push must not carry the same refusal again.
		await move({ cardKey: key, toColumnId: 'review', toIndex: 0, boardId: null });
		expect(lastSnapshot(maestro).moveRejection).toBeNull();
		expect(findCard(lastSnapshot(maestro), key)?.columnId).toBe('review');
	});
});
