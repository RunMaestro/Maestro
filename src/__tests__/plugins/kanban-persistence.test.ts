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
	columns: {
		id: string;
		title: string;
		readOnly?: boolean;
		cards: { key: string; legalColumnIds?: string[] }[];
	}[];
	boardId?: string | null;
	boardName?: string;
	boards?: { id: string; kind: string; name: string; cardCount: number }[];
	boardsHidden?: number;
	globalBoardMissing?: boolean;
	activeProjectPath?: string | null;
	moveRejection?: { cardKey: string; reason: string } | null;
}

interface KanbanPlugin {
	GLOBAL_BOARD_ID: string;
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
			// Typed args, so `panelPost.mock.calls[n][1]` is the snapshot a test can
			// cast rather than an element of a zero-length tuple.
			panelPost: vi.fn((_panelId: string, _message: unknown) => Promise.resolve({ ok: true })),
			togglePanel: vi.fn(() => Promise.resolve({ ok: true })),
			closePanel: vi.fn(() => Promise.resolve({ ok: true })),
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

/** The placement map main.js persisted for one board. A placement main.js
 * wrote is `{ columnId, order? }` - `order` is only written once a move has
 * positioned the card, so its absence is meaningful and asserted on
 * directly. A bare string is the pre-ordering format, which only a test that
 * seeded one and has not triggered a rewrite yet will see. */
function readPlacements(storageStore: Map<string, string>, boardPath: string) {
	return JSON.parse(storageStore.get('placements:' + boardPath) as string) as Record<
		string,
		{ columnId: string; order?: number } | string
	>;
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
		const persisted = readPlacements(storageStore, boardPath);
		// The repaired column is persisted, and the order the card carried in
		// the column that no longer exists is dropped rather than reused as a
		// position in a different column.
		expect(persisted[key]).toEqual({ columnId: plugin.DEFAULT_COLUMNS[0]!.id });
	});

	it("clears a repaired card's stale order instead of reusing it in the column it landed in", async () => {
		const plugin = loadMain();
		const projectPath = '/Users/dev/projects/widgets';
		const boardPath = plugin.boardFilePath(projectPath);
		const key = 'session-1::tab-1';
		const { maestro, storageStore } = createStubMaestro({
			storage: {
				['placements:' + boardPath]: JSON.stringify({ [key]: { columnId: 'archived', order: 3 } }),
			},
			tabsList: () => Promise.resolve([aiTab({ projectPath })]),
		});

		await plugin.activate(maestro);

		expect(readPlacements(storageStore, boardPath)[key]).toEqual({
			columnId: plugin.DEFAULT_COLUMNS[0]!.id,
		});
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

		const persisted = readPlacements(storageStore, boardPath);
		expect(persisted).toEqual({ [liveKey]: { columnId: 'backlog' } });
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
		// The move records both halves of the placement: the column and the
		// explicit position within it.
		expect(readPlacements(storageStore, boardPath)[key]).toEqual({
			columnId: 'review',
			order: 0,
		});
	});

	it('honours toIndex, placing a moved card above a card already in the column', async () => {
		const first = 'session-1::tab-1';
		const second = 'session-1::tab-2';
		const { move, maestro } = await activateWithTabs([
			aiTab({ id: 'tab-1', projectPath, createdAt: 1 }),
			aiTab({ id: 'tab-2', projectPath, createdAt: 2 }),
		]);
		// Neither card has been positioned yet, so both sort by last activity,
		// newest first - the newer tab is on top.
		const before = lastSnapshot(maestro).columns.find((c) => c.id === 'backlog');
		expect(before?.cards.map((c) => c.key)).toEqual([second, first]);

		await move({ cardKey: first, toColumnId: 'backlog', toIndex: 0, boardId: null });

		const after = lastSnapshot(maestro).columns.find((c) => c.id === 'backlog');
		expect(after?.cards.map((c) => c.key)).toEqual([first, second]);
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
		expect(readPlacements(storageStore, boardPath)[key]).toEqual({ columnId: 'backlog' });
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
		const { move } = await activateWithTabs([aiTab({})]);

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

describe('maestro-kanban card ordering', () => {
	const projectPath = '/Users/dev/projects/widgets';

	/** Activates the plugin with `tabs` in `projectPath` and `placements`
	 * already in storage, which is what a restart looks like from main.js's
	 * point of view: nothing in memory, everything in the placement store. */
	async function activateWithPlacements(
		tabs: Record<string, unknown>[],
		placements: Record<string, unknown> = {}
	) {
		const plugin = loadMain();
		const boardPath = plugin.boardFilePath(projectPath);
		const stub = createStubMaestro({
			storage: { ['placements:' + boardPath]: JSON.stringify(placements) },
			tabsList: () => Promise.resolve(tabs),
		});
		await plugin.activate(stub.maestro);
		return { plugin, boardPath, move: stub.commandHandlers.get('move'), ...stub };
	}

	function columnKeys(
		maestro: { ui: { panelPost: { mock: { calls: unknown[][] } } } },
		id: string
	) {
		const calls = maestro.ui.panelPost.mock.calls;
		const snapshot = calls[calls.length - 1]![1] as KanbanSnapshot;
		return snapshot.columns.find((column) => column.id === id)?.cards.map((card) => card.key);
	}

	it('restores a hand-arranged column from stored orders rather than re-deriving one', async () => {
		const first = 'session-1::tab-1';
		const second = 'session-1::tab-2';
		const { maestro } = await activateWithPlacements(
			[
				// tab-1 is the newer tab, so last-activity order alone would put it
				// on top. The stored order says otherwise and must win.
				aiTab({ id: 'tab-1', projectPath, createdAt: 2 }),
				aiTab({ id: 'tab-2', projectPath, createdAt: 1 }),
			],
			{
				[first]: { columnId: 'backlog', order: 1 },
				[second]: { columnId: 'backlog', order: 0 },
			}
		);

		expect(columnKeys(maestro, 'backlog')).toEqual([second, first]);
	});

	it('sorts a card with no recorded order by last activity, newest at the top', async () => {
		const oldest = 'session-1::tab-1';
		const newest = 'session-1::tab-2';
		const middle = 'session-1::tab-3';
		const { maestro } = await activateWithPlacements([
			aiTab({ id: 'tab-1', projectPath, createdAt: 1 }),
			aiTab({ id: 'tab-2', projectPath, createdAt: 5 }),
			aiTab({ id: 'tab-3', projectPath, createdAt: 3 }),
		]);

		expect(columnKeys(maestro, 'backlog')).toEqual([newest, middle, oldest]);
	});

	it('puts a brand new tab above the cards the user positioned by hand', async () => {
		const pinnedTop = 'session-1::tab-1';
		const pinnedBottom = 'session-1::tab-2';
		const fresh = 'session-1::tab-3';
		const { maestro } = await activateWithPlacements(
			[
				aiTab({ id: 'tab-1', projectPath, createdAt: 1 }),
				aiTab({ id: 'tab-2', projectPath, createdAt: 2 }),
				// Appeared after the user arranged the column, and has no order.
				aiTab({ id: 'tab-3', projectPath, createdAt: 9 }),
			],
			{
				[pinnedTop]: { columnId: 'backlog', order: 0 },
				[pinnedBottom]: { columnId: 'backlog', order: 1 },
			}
		);

		expect(columnKeys(maestro, 'backlog')).toEqual([fresh, pinnedTop, pinnedBottom]);
	});

	it('reads a pre-ordering placement stored as a bare column id and rewrites it on the next move', async () => {
		const key = 'session-1::tab-1';
		const { boardPath, move, maestro, storageStore } = await activateWithPlacements(
			[aiTab({ projectPath, status: 'busy' })],
			// The format this plugin wrote before placements carried an order.
			{ [key]: 'review' }
		);
		// The legacy column survives the upgrade (deriveColumn would have said
		// 'in-progress' for a busy card).
		expect(columnKeys(maestro, 'review')).toEqual([key]);
		expect(readPlacements(storageStore, boardPath)[key]).toEqual('review');

		await move!({ cardKey: key, toColumnId: 'review', toIndex: 0, boardId: null });

		expect(readPlacements(storageStore, boardPath)[key]).toEqual({
			columnId: 'review',
			order: 0,
		});
	});

	it('renumbers the column a card left so the survivors keep dense, persisted orders', async () => {
		const moved = 'session-1::tab-1';
		const stayed = 'session-1::tab-2';
		const { boardPath, move, storageStore } = await activateWithPlacements(
			[
				aiTab({ id: 'tab-1', projectPath, createdAt: 1 }),
				aiTab({ id: 'tab-2', projectPath, createdAt: 2 }),
			],
			{
				[moved]: { columnId: 'backlog', order: 0 },
				[stayed]: { columnId: 'backlog', order: 1 },
			}
		);

		await move!({ cardKey: moved, toColumnId: 'review', toIndex: 0, boardId: null });

		const persisted = readPlacements(storageStore, boardPath);
		expect(persisted[moved]).toEqual({ columnId: 'review', order: 0 });
		// The hole the moved card left is closed rather than leaving the last
		// survivor stranded on order 1.
		expect(persisted[stayed]).toEqual({ columnId: 'backlog', order: 0 });
	});
});

describe('maestro-kanban board switcher', () => {
	const widgets = '/Users/dev/projects/widgets';
	const gadgets = '/Users/dev/projects/gadgets';
	const GLOBAL_PATH = '~/.maestro/kanban.yaml';
	/** A module instance used only for main.js's PURE helpers, so a test can
	 * name a project's board file before activating. loadMain() purges the
	 * require cache, so every activateWith() below still gets fresh runtime
	 * state of its own. */
	const pure = loadMain();
	const GLOBAL_BOARD_ID = pure.GLOBAL_BOARD_ID;

	/** A global board file: two columns, no `project` key (the parser refuses
	 * one there). */
	const globalYaml =
		'version: 1\ncolumns:\n  - id: now\n    title: Now\n  - id: later\n    title: Later\n';

	/** A project board file whose columns point at the global board's. */
	function projectYaml(
		projectPath: string,
		columns: { id: string; title: string; maps_to?: string }[]
	) {
		return (
			'version: 1\nproject: ' +
			projectPath +
			'\ncolumns:\n' +
			columns
				.map(
					(column) =>
						'  - id: ' +
						column.id +
						'\n    title: ' +
						column.title +
						(column.maps_to ? '\n    maps_to: ' + column.maps_to : '') +
						'\n'
				)
				.join('')
		);
	}

	function lastSnapshot(maestro: { ui: { panelPost: { mock: { calls: unknown[][] } } } }) {
		const calls = maestro.ui.panelPost.mock.calls;
		return calls[calls.length - 1]![1] as KanbanSnapshot;
	}

	/** Activates with `tabs` and whatever board files / stored state a test
	 * needs, then hands back the registered command handlers. */
	async function activateWith(options: {
		tabs: Record<string, unknown>[];
		files?: Record<string, string>;
		storage?: Record<string, string>;
	}) {
		const plugin = loadMain();
		const stub = createStubMaestro({
			tabsList: () => Promise.resolve(options.tabs),
			files: options.files,
			storage: options.storage,
		});
		await plugin.activate(stub.maestro);
		const selectBoard = stub.commandHandlers.get('select-board');
		const move = stub.commandHandlers.get('move');
		if (!selectBoard || !move) throw new Error('main.js did not register select-board and move');
		return { plugin, selectBoard, move, ...stub };
	}

	it('offers the Global board plus every project that has cards, each with its card count', async () => {
		const { maestro } = await activateWith({
			tabs: [
				aiTab({ id: 'tab-1', sessionId: 'session-1', projectPath: widgets }),
				aiTab({ id: 'tab-2', sessionId: 'session-1', projectPath: widgets }),
				aiTab({ id: 'tab-3', sessionId: 'session-2', projectPath: gadgets }),
			],
		});

		expect(lastSnapshot(maestro).boards).toEqual([
			{ id: '__global__', kind: 'global', name: 'Global', projectPath: null, cardCount: 3 },
			{
				id: gadgets,
				kind: 'project',
				name: 'gadgets',
				projectPath: gadgets,
				cardCount: 1,
			},
			{
				id: widgets,
				kind: 'project',
				name: 'widgets',
				projectPath: widgets,
				cardCount: 2,
			},
		]);
	});

	it('remembers the selected board in plugin storage', async () => {
		const { selectBoard, storageStore } = await activateWith({
			tabs: [aiTab({ projectPath: widgets })],
		});

		await selectBoard({ boardId: widgets });

		expect(storageStore.get('selected-board')).toBe(widgets);
	});

	it('restores the remembered board before the first snapshot, so the panel never flashes another one', async () => {
		const { maestro } = await activateWith({
			tabs: [aiTab({ projectPath: widgets })],
			storage: { 'selected-board': '__global__' },
		});

		const first = maestro.ui.panelPost.mock.calls[0]![1] as KanbanSnapshot;
		expect(first.boardId).toBe('__global__');
		expect(first.boardName).toBe('Global');
	});

	it("shows only the selected project's own cards on its board", async () => {
		const { selectBoard, maestro } = await activateWith({
			tabs: [
				aiTab({ id: 'tab-1', sessionId: 'session-1', projectPath: widgets }),
				aiTab({ id: 'tab-2', sessionId: 'session-2', projectPath: gadgets }),
			],
		});

		await selectBoard({ boardId: widgets });

		const snapshot = lastSnapshot(maestro);
		expect(snapshot.boardName).toBe('widgets');
		const keys = snapshot.columns.flatMap((column) => column.cards.map((card) => card.key));
		expect(keys).toEqual(['session-1::tab-1']);
	});

	it('keeps an emptied project selectable, with a zero count, rather than dropping it out of its own control', async () => {
		const { selectBoard, maestro } = await activateWith({ tabs: [] });

		await selectBoard({ boardId: widgets });

		const snapshot = lastSnapshot(maestro);
		expect(snapshot.boardId).toBe(widgets);
		expect(snapshot.boards).toEqual([
			{ id: '__global__', kind: 'global', name: 'Global', projectPath: null, cardCount: 0 },
			{ id: widgets, kind: 'project', name: 'widgets', projectPath: widgets, cardCount: 0 },
		]);
	});

	it("projects every project's cards onto the global board's columns", async () => {
		const { selectBoard, maestro } = await activateWith({
			tabs: [
				aiTab({ id: 'tab-1', sessionId: 'session-1', projectPath: widgets }),
				aiTab({ id: 'tab-2', sessionId: 'session-2', projectPath: gadgets }),
			],
			files: {
				[GLOBAL_PATH]: globalYaml,
				[pure.boardFilePath(widgets)]: projectYaml(widgets, [
					{ id: 'backlog', title: 'Backlog', maps_to: 'now' },
				]),
				[pure.boardFilePath(gadgets)]: projectYaml(gadgets, [
					{ id: 'backlog', title: 'Inbox', maps_to: 'later' },
				]),
			},
		});

		await selectBoard({ boardId: GLOBAL_BOARD_ID });

		const snapshot = lastSnapshot(maestro);
		expect(snapshot.columns.map((column) => column.id)).toEqual(['now', 'later']);
		expect(snapshot.columns[0]!.cards.map((card) => card.key)).toEqual(['session-1::tab-1']);
		expect(snapshot.columns[1]!.cards.map((card) => card.key)).toEqual(['session-2::tab-2']);
		expect(snapshot.globalBoardMissing).toBe(false);
	});

	it("tells the panel which global columns a card's project can reach, so it can dim the rest", async () => {
		const { selectBoard, maestro } = await activateWith({
			tabs: [aiTab({ projectPath: widgets })],
			files: {
				[GLOBAL_PATH]: globalYaml,
				[pure.boardFilePath(widgets)]: projectYaml(widgets, [
					{ id: 'backlog', title: 'Backlog', maps_to: 'now' },
				]),
			},
		});

		await selectBoard({ boardId: GLOBAL_BOARD_ID });

		const card = lastSnapshot(maestro).columns[0]!.cards[0]!;
		// 'later' is a global column no widgets column maps to.
		expect(card.legalColumnIds).toEqual(['now']);
	});

	it('collects a card whose project has no board file in a read-only Unmapped lane it can leave nowhere', async () => {
		const { selectBoard, maestro } = await activateWith({
			tabs: [aiTab({ projectPath: widgets })],
			files: { [GLOBAL_PATH]: globalYaml },
		});

		await selectBoard({ boardId: GLOBAL_BOARD_ID });

		const snapshot = lastSnapshot(maestro);
		const lane = snapshot.columns[snapshot.columns.length - 1]!;
		expect(lane.id).toBe('__unmapped__');
		expect(lane.title).toBe('Unmapped');
		expect(lane.readOnly).toBe(true);
		expect(lane.cards[0]!.legalColumnIds).toEqual([]);
	});

	it('reports a missing global board file, since every card then lands in Unmapped', async () => {
		const { selectBoard, maestro } = await activateWith({
			tabs: [aiTab({ projectPath: widgets })],
		});

		await selectBoard({ boardId: GLOBAL_BOARD_ID });

		const snapshot = lastSnapshot(maestro);
		expect(snapshot.globalBoardMissing).toBe(true);
		expect(snapshot.columns.map((column) => column.id)).toEqual(['__unmapped__']);
	});

	it('writes a global move back to the project column that maps to the target global column', async () => {
		const boardPath = pure.boardFilePath(widgets);
		const { selectBoard, move, maestro, storageStore } = await activateWith({
			tabs: [aiTab({ projectPath: widgets })],
			files: {
				[GLOBAL_PATH]: globalYaml,
				[boardPath]: projectYaml(widgets, [
					{ id: 'backlog', title: 'Backlog', maps_to: 'now' },
					{ id: 'shipped', title: 'Shipped', maps_to: 'later' },
				]),
			},
		});
		await selectBoard({ boardId: GLOBAL_BOARD_ID });

		const result = await move({
			cardKey: 'session-1::tab-1',
			toColumnId: 'later',
			toIndex: 0,
			boardId: GLOBAL_BOARD_ID,
		});

		expect(result).toEqual({
			ok: true,
			columnId: 'shipped',
			globalColumnId: 'later',
			index: 0,
		});
		expect(readPlacements(storageStore, boardPath)['session-1::tab-1']).toEqual({
			columnId: 'shipped',
			order: 0,
		});
		const snapshot = lastSnapshot(maestro);
		expect(snapshot.columns[1]!.cards.map((card) => card.key)).toEqual(['session-1::tab-1']);
	});

	it("refuses a global move onto a column the card's project cannot reach", async () => {
		const { selectBoard, move, maestro } = await activateWith({
			tabs: [aiTab({ projectPath: widgets })],
			files: {
				[GLOBAL_PATH]: globalYaml,
				[pure.boardFilePath(widgets)]: projectYaml(widgets, [
					{ id: 'backlog', title: 'Backlog', maps_to: 'now' },
				]),
			},
		});
		await selectBoard({ boardId: GLOBAL_BOARD_ID });

		const result = await move({
			cardKey: 'session-1::tab-1',
			toColumnId: 'later',
			toIndex: 0,
			boardId: GLOBAL_BOARD_ID,
		});

		expect(result).toEqual({
			ok: false,
			reason: '"later" is not a column that card\'s project can reach',
		});
		expect(lastSnapshot(maestro).moveRejection).toEqual({
			cardKey: 'session-1::tab-1',
			reason: '"later" is not a column that card\'s project can reach',
		});
	});

	it('keeps the card on the column it is already projected into when two project columns map there', async () => {
		const boardPath = pure.boardFilePath(widgets);
		const { selectBoard, move, storageStore } = await activateWith({
			tabs: [aiTab({ projectPath: widgets })],
			files: {
				[GLOBAL_PATH]: globalYaml,
				[boardPath]: projectYaml(widgets, [
					{ id: 'backlog', title: 'Backlog', maps_to: 'now' },
					{ id: 'triage', title: 'Triage', maps_to: 'now' },
				]),
			},
		});
		await selectBoard({ boardId: GLOBAL_BOARD_ID });

		// A drop on the global column the card is already in is a reorder; it
		// must not relocate the card inside its own project.
		await move({
			cardKey: 'session-1::tab-1',
			toColumnId: 'now',
			toIndex: 0,
			boardId: GLOBAL_BOARD_ID,
		});

		expect(readPlacements(storageStore, boardPath)['session-1::tab-1']).toEqual({
			columnId: 'backlog',
			order: 0,
		});
	});

	it("positions a global drop against the card's own project siblings, which are the only order it can store", async () => {
		const boardPath = pure.boardFilePath(widgets);
		const { selectBoard, move, maestro, storageStore } = await activateWith({
			tabs: [
				aiTab({ id: 'tab-1', sessionId: 'session-1', projectPath: widgets, createdAt: 1 }),
				aiTab({ id: 'tab-2', sessionId: 'session-1', projectPath: widgets, createdAt: 2 }),
				aiTab({ id: 'tab-3', sessionId: 'session-2', projectPath: gadgets, createdAt: 3 }),
			],
			files: {
				[GLOBAL_PATH]: globalYaml,
				[pure.boardFilePath(widgets)]: projectYaml(widgets, [
					{ id: 'backlog', title: 'Backlog', maps_to: 'now' },
				]),
				[pure.boardFilePath(gadgets)]: projectYaml(gadgets, [
					{ id: 'backlog', title: 'Backlog', maps_to: 'now' },
				]),
			},
		});
		await selectBoard({ boardId: GLOBAL_BOARD_ID });
		// All three project onto 'now' and none is positioned yet, so they sort
		// by last activity, newest first.
		expect(lastSnapshot(maestro).columns[0]!.cards.map((card) => card.key)).toEqual([
			'session-2::tab-3',
			'session-1::tab-2',
			'session-1::tab-1',
		]);

		await move({
			cardKey: 'session-1::tab-1',
			toColumnId: 'now',
			toIndex: 0,
			boardId: GLOBAL_BOARD_ID,
		});

		// An `order` is a position inside a home-project column, so dropping on
		// a global column can only record where the card sits among its OWN
		// project's cards: tab-1 is now above tab-2, which is what the drop
		// asked for. Where gadgets' card falls between them is decided by
		// compareCardsByOrder's tiebreaks, not by the drop - it is deterministic
		// (the same cards always read the same way) but it is not the global
		// index the panel reported, which no store this plugin has can hold.
		expect(readPlacements(storageStore, boardPath)).toEqual({
			'session-1::tab-1': { columnId: 'backlog', order: 0 },
			'session-1::tab-2': { columnId: 'backlog', order: 1 },
		});
		const after = lastSnapshot(maestro).columns[0]!.cards.map((card) => card.key);
		expect(after.indexOf('session-1::tab-1')).toBeLessThan(after.indexOf('session-1::tab-2'));
	});

	it('refuses a move whose boardId is no longer the board on screen', async () => {
		const { selectBoard, move } = await activateWith({
			tabs: [aiTab({ projectPath: widgets })],
		});
		await selectBoard({ boardId: widgets });

		const result = await move({
			cardKey: 'session-1::tab-1',
			toColumnId: 'review',
			toIndex: 0,
			boardId: gadgets,
		});

		expect(result).toEqual({
			ok: false,
			reason: 'the board changed while the card was moving; try again',
		});
	});

	it('refuses a move of a card that belongs to a project other than the board on screen', async () => {
		const { selectBoard, move } = await activateWith({
			tabs: [
				aiTab({ id: 'tab-1', sessionId: 'session-1', projectPath: widgets }),
				aiTab({ id: 'tab-2', sessionId: 'session-2', projectPath: gadgets }),
			],
		});
		await selectBoard({ boardId: widgets });

		const result = await move({
			cardKey: 'session-2::tab-2',
			toColumnId: 'review',
			toIndex: 0,
			boardId: widgets,
		});

		expect(result).toEqual({
			ok: false,
			reason: 'that card belongs to another project, not the board on screen',
		});
	});
});

describe('maestro-kanban close-panel command', () => {
	it("dismisses the board panel on the panel's Escape, which cannot close itself", async () => {
		const plugin = loadMain();
		const stub = createStubMaestro({ tabsList: () => Promise.resolve([aiTab()]) });
		await plugin.activate(stub.maestro);

		const closePanel = stub.commandHandlers.get('close-panel');
		if (!closePanel) throw new Error('main.js did not register close-panel');
		await expect(closePanel({})).resolves.toEqual({ ok: true });

		// The board panel's own id, not a panel id the panel sent: a close
		// command that took one would let any post dismiss another surface.
		expect(stub.maestro.ui.closePanel).toHaveBeenCalledWith('board');
	});

	it('reports a failed close rather than throwing out of the command', async () => {
		const plugin = loadMain();
		const stub = createStubMaestro({ tabsList: () => Promise.resolve([aiTab()]) });
		stub.maestro.ui.closePanel.mockRejectedValueOnce(new Error('panel is not open'));
		await plugin.activate(stub.maestro);

		const closePanel = stub.commandHandlers.get('close-panel');
		if (!closePanel) throw new Error('main.js did not register close-panel');
		await expect(closePanel({})).resolves.toEqual({ ok: false });
	});
});
