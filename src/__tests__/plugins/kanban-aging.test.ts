/**
 * @file kanban-aging.test.ts
 * @description Tests for Phase 05's Done-column aging model inside
 * `examples/plugins/maestro-kanban/main.js`.
 *
 * Two halves, matching the two halves of the model itself:
 *
 *   - `agingState()` and `normalizeAgingSettings()` are pure exports with no
 *     host calls, so they are called straight through with a fixed clock,
 *     the same way `kanban-board-model.test.ts` calls the Phase 02 column
 *     model.
 *   - The clock stamp itself (`enteredDoneAt` on a card's stored placement)
 *     is runtime state with no export of its own - per the same reasoning
 *     `kanban-persistence.test.ts` gives for the placement store, it is only
 *     observable end to end, through `activate()` plus the `move` command
 *     and the stub `maestro.storage` they write to.
 *
 *   - The archive file underneath retirement (`archiveFilePath()`,
 *     `loadArchive()`, `saveArchive()`, `appendToArchive()`) is exercised
 *     through the same stub `maestro.fs` the Phase 02 board files use, so a
 *     test can read back exactly what landed on disk.
 *
 * Retirement itself and the opt-in tab close are later tasks in this phase
 * and are not covered here yet.
 */

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mainPath = require.resolve('../../../examples/plugins/maestro-kanban/main.js');

interface AgingSettings {
	agingEnabled: boolean;
	horizonDays: number;
	closeTabsOnRetire: boolean;
}

interface AgingState {
	enabled: boolean;
	enteredDoneAt: number | null;
	resetAt: number | null;
	elapsedDays: number;
	horizonDays: number;
	opacity: number;
	expired: boolean;
}

interface AgingCard {
	columnId?: string;
	terminalColumnId?: string;
	enteredDoneAt?: number | null;
	lastCommentAt?: number | null;
	lastMessageAt?: number | null;
}

interface ArchiveRecord {
	key: string;
	retiredAt: number;
	reason: string;
	title: string;
	sessionId: string | null;
	tabId: string | null;
	agentName: string | null;
	projectPath: string | null;
	columnHistory: string[];
	description: string;
	comments: { id: string; body: string; createdAt: number }[];
}

interface ArchiveRead {
	records: ArchiveRecord[];
	error: { message: string; path: string } | null;
	exists: boolean;
}

interface KanbanAging {
	agingState: (card: AgingCard, settings: unknown, now: number) => AgingState;
	normalizeAgingSettings: (raw: unknown) => AgingSettings;
	DEFAULT_AGING_SETTINGS: AgingSettings;
	AGING_OPACITY_FLOOR: number;
	boardFilePath: (projectPath: string | null | undefined) => string;
	setBoardAgingSettings: (boardId: string, patch: unknown) => Promise<AgingSettings>;
	agingSettingsForBoard: (boardId: string | null) => AgingSettings;
	agingStateForCard: (
		card: { key: string; projectPath?: string; columnId?: string },
		terminalColumnId: string | null,
		now?: number
	) => AgingState;
	ARCHIVE_RECORD_CAP: number;
	archiveFilePath: (boardId: string | null | undefined) => string;
	readStoredArchiveRecord: (value: unknown) => ArchiveRecord | null;
	pruneArchiveRecords: (records: ArchiveRecord[], path: string) => ArchiveRecord[];
	loadArchive: (boardId: string) => Promise<ArchiveRead>;
	saveArchive: (boardId: string, records: ArchiveRecord[]) => Promise<ArchiveRecord[]>;
	appendToArchive: (boardId: string, additions: ArchiveRecord[]) => Promise<ArchiveRecord[]>;
	GLOBAL_BOARD_ID: string;
	activate: (maestro: unknown) => Promise<void>;
}

/** Fresh module state per test: main.js keeps its card and placement caches
 * in module-level variables, so the require cache entry must be dropped
 * before every require(). Mirrors kanban-persistence.test.ts's loadMain(). */
function loadMain(): KanbanAging {
	delete require.cache[mainPath];
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require(mainPath) as KanbanAging;
}

/** A fixed clock, so "five days in" is a subtraction and never a timer. */
const NOW = Date.UTC(2026, 2, 14, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function doneCard(overrides: AgingCard = {}): AgingCard {
	return {
		columnId: 'done',
		terminalColumnId: 'done',
		enteredDoneAt: NOW,
		...overrides,
	};
}

describe('maestro-kanban aging model', () => {
	describe('normalizeAgingSettings', () => {
		it('defaults to aging off, a 14-day horizon, and tabs left alone', () => {
			const plugin = loadMain();
			expect(plugin.normalizeAgingSettings(undefined)).toEqual({
				agingEnabled: false,
				horizonDays: 14,
				closeTabsOnRetire: false,
			});
			expect(plugin.DEFAULT_AGING_SETTINGS).toEqual({
				agingEnabled: false,
				horizonDays: 14,
				closeTabsOnRetire: false,
			});
		});

		it('falls back per field, so a partial patch keeps the other defaults', () => {
			const plugin = loadMain();
			expect(plugin.normalizeAgingSettings({ agingEnabled: true })).toEqual({
				agingEnabled: true,
				horizonDays: 14,
				closeTabsOnRetire: false,
			});
		});

		it('rounds and clamps a horizon instead of refusing it', () => {
			const plugin = loadMain();
			expect(plugin.normalizeAgingSettings({ horizonDays: 0 }).horizonDays).toBe(1);
			expect(plugin.normalizeAgingSettings({ horizonDays: -40 }).horizonDays).toBe(1);
			expect(plugin.normalizeAgingSettings({ horizonDays: 10.4 }).horizonDays).toBe(10);
			expect(plugin.normalizeAgingSettings({ horizonDays: 10_000 }).horizonDays).toBe(365);
			expect(plugin.normalizeAgingSettings({ horizonDays: Number.NaN }).horizonDays).toBe(14);
			expect(plugin.normalizeAgingSettings({ horizonDays: '7' }).horizonDays).toBe(14);
		});

		it('treats anything but a literal true as off for both toggles', () => {
			const plugin = loadMain();
			const settings = plugin.normalizeAgingSettings({
				agingEnabled: 'yes',
				closeTabsOnRetire: 1,
			});
			expect(settings.agingEnabled).toBe(false);
			expect(settings.closeTabsOnRetire).toBe(false);
		});
	});

	describe('agingState', () => {
		it('renders at full opacity and never expires while aging is off', () => {
			const plugin = loadMain();
			const state = plugin.agingState(
				doneCard({ enteredDoneAt: NOW - 400 * DAY }),
				{ agingEnabled: false, horizonDays: 10 },
				NOW
			);
			expect(state.enabled).toBe(false);
			expect(state.opacity).toBe(1);
			expect(state.expired).toBe(false);
			// The clock is still reported, so the settings surface can say how
			// old the Done cards already are before anyone opts in.
			expect(state.enteredDoneAt).toBe(NOW - 400 * DAY);
			expect(state.elapsedDays).toBeCloseTo(400, 6);
		});

		it('decays linearly from 1 to the floor across a 10-day horizon', () => {
			const plugin = loadMain();
			const settings = { agingEnabled: true, horizonDays: 10 };
			const at = (daysAgo: number) =>
				plugin.agingState(doneCard({ enteredDoneAt: NOW - daysAgo * DAY }), settings, NOW);

			expect(at(0).opacity).toBe(1);
			expect(at(5).opacity).toBe(0.55);
			expect(at(10).opacity).toBe(plugin.AGING_OPACITY_FLOOR);
			expect(plugin.AGING_OPACITY_FLOOR).toBeGreaterThan(0);
		});

		it('clamps outside the horizon at both ends', () => {
			const plugin = loadMain();
			const settings = { agingEnabled: true, horizonDays: 10 };
			// Well past the horizon: still the floor, never negative or invisible.
			const past = plugin.agingState(doneCard({ enteredDoneAt: NOW - 90 * DAY }), settings, NOW);
			expect(past.opacity).toBe(plugin.AGING_OPACITY_FLOOR);
			expect(past.expired).toBe(true);
			// A stamp in the future (clock skew) reads as "just now", not as
			// negative age and an opacity above 1.
			const future = plugin.agingState(doneCard({ enteredDoneAt: NOW + 5 * DAY }), settings, NOW);
			expect(future.opacity).toBe(1);
			expect(future.elapsedDays).toBe(0);
			expect(future.expired).toBe(false);
		});

		it('expires exactly at the horizon, not a day later', () => {
			const plugin = loadMain();
			const settings = { agingEnabled: true, horizonDays: 10 };
			expect(
				plugin.agingState(doneCard({ enteredDoneAt: NOW - 10 * DAY }), settings, NOW).expired
			).toBe(true);
			expect(
				plugin.agingState(doneCard({ enteredDoneAt: NOW - 9.5 * DAY }), settings, NOW).expired
			).toBe(false);
		});

		it('restarts the clock on a new comment and restores full opacity', () => {
			const plugin = loadMain();
			const state = plugin.agingState(
				doneCard({ enteredDoneAt: NOW - 9 * DAY, lastCommentAt: NOW }),
				{ agingEnabled: true, horizonDays: 10 },
				NOW
			);
			expect(state.resetAt).toBe(NOW);
			expect(state.elapsedDays).toBe(0);
			expect(state.opacity).toBe(1);
			expect(state.expired).toBe(false);
			// The card is still reported as having entered Done when it did.
			expect(state.enteredDoneAt).toBe(NOW - 9 * DAY);
		});

		it('restarts the clock on a new message too, and the later of the two wins', () => {
			const plugin = loadMain();
			const settings = { agingEnabled: true, horizonDays: 10 };
			const messageOnly = plugin.agingState(
				doneCard({ enteredDoneAt: NOW - 9 * DAY, lastMessageAt: NOW - 1 * DAY }),
				settings,
				NOW
			);
			expect(messageOnly.resetAt).toBe(NOW - 1 * DAY);
			expect(messageOnly.elapsedDays).toBeCloseTo(1, 6);

			const both = plugin.agingState(
				doneCard({
					enteredDoneAt: NOW - 9 * DAY,
					lastCommentAt: NOW - 6 * DAY,
					lastMessageAt: NOW - 2 * DAY,
				}),
				settings,
				NOW
			);
			expect(both.resetAt).toBe(NOW - 2 * DAY);
			expect(both.elapsedDays).toBeCloseTo(2, 6);
		});

		it('ignores a comment older than the moment the card entered Done', () => {
			const plugin = loadMain();
			const state = plugin.agingState(
				doneCard({ enteredDoneAt: NOW - 3 * DAY, lastCommentAt: NOW - 30 * DAY }),
				{ agingEnabled: true, horizonDays: 10 },
				NOW
			);
			expect(state.resetAt).toBeNull();
			expect(state.elapsedDays).toBeCloseTo(3, 6);
		});

		it('does not age a card sitting anywhere but the terminal column', () => {
			const plugin = loadMain();
			const state = plugin.agingState(
				{
					columnId: 'in-progress',
					terminalColumnId: 'done',
					// A stamp that survived somewhere it should not have: the
					// column, not the stamp, decides whether a card ages.
					enteredDoneAt: NOW - 90 * DAY,
				},
				{ agingEnabled: true, horizonDays: 10 },
				NOW
			);
			expect(state.enabled).toBe(false);
			expect(state.enteredDoneAt).toBeNull();
			expect(state.opacity).toBe(1);
			expect(state.expired).toBe(false);
		});

		it('does not age a Done card whose clock has not been stamped yet', () => {
			const plugin = loadMain();
			const state = plugin.agingState(
				doneCard({ enteredDoneAt: null }),
				{ agingEnabled: true, horizonDays: 10 },
				NOW
			);
			expect(state.enabled).toBe(false);
			expect(state.opacity).toBe(1);
			expect(state.expired).toBe(false);
		});

		it('reports the effective horizon, clamped, whatever the card is doing', () => {
			const plugin = loadMain();
			expect(plugin.agingState(doneCard(), { horizonDays: 0 }, NOW).horizonDays).toBe(1);
			expect(plugin.agingState(doneCard(), undefined, NOW).horizonDays).toBe(14);
		});
	});
});

// ---------------------------------------------------------------------------
// The clock stamp itself, end to end through activate() and `move`.
// ---------------------------------------------------------------------------

interface StubOptions {
	storage?: Record<string, string>;
	files?: Record<string, string>;
	tabsList?: () => Promise<unknown>;
}

/** An in-memory `maestro.fs`/`maestro.storage` backed by plain Maps, so a
 * test can inspect what main.js ultimately persisted. Mirrors
 * kanban-persistence.test.ts's stub, trimmed to what aging reads. */
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
			list: vi.fn(() => Promise.resolve([])),
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

function readPlacements(storageStore: Map<string, string>, boardPath: string) {
	return JSON.parse(storageStore.get('placements:' + boardPath) as string) as Record<
		string,
		{ columnId: string; order?: number; enteredDoneAt?: number }
	>;
}

describe('maestro-kanban Done clock', () => {
	const projectPath = '/Users/dev/projects/widgets';
	const key = 'session-1::tab-1';

	it('stamps a card that starts life in Done and leaves every other column unstamped', async () => {
		const plugin = loadMain();
		const boardPath = plugin.boardFilePath(projectPath);
		const { maestro, storageStore } = createStubMaestro({
			storage: {
				['placements:' + boardPath]: JSON.stringify({
					[key]: { columnId: 'done' },
					'session-1::tab-2': { columnId: 'backlog' },
				}),
			},
			tabsList: () =>
				Promise.resolve([
					aiTab({ projectPath }),
					aiTab({ id: 'tab-2', projectPath, title: 'Other' }),
				]),
		});

		await plugin.activate(maestro);

		const persisted = readPlacements(storageStore, boardPath);
		expect(persisted[key]!.enteredDoneAt).toEqual(expect.any(Number));
		expect(persisted['session-1::tab-2']!.enteredDoneAt).toBeUndefined();
	});

	it('leaves an existing stamp alone rather than restarting it on every refresh', async () => {
		const plugin = loadMain();
		const boardPath = plugin.boardFilePath(projectPath);
		const stamped = Date.now() - 3 * DAY;
		const { maestro, storageStore, commandHandlers } = createStubMaestro({
			storage: {
				['placements:' + boardPath]: JSON.stringify({
					[key]: { columnId: 'done', enteredDoneAt: stamped },
				}),
			},
			tabsList: () => Promise.resolve([aiTab({ projectPath })]),
		});

		await plugin.activate(maestro);
		await commandHandlers.get('refresh')!();

		expect(readPlacements(storageStore, boardPath)[key]!.enteredDoneAt).toBe(stamped);
	});

	it('clears the stamp when a card is dragged out of Done and starts a fresh one on the way back', async () => {
		const plugin = loadMain();
		const boardPath = plugin.boardFilePath(projectPath);
		const stamped = Date.now() - 30 * DAY;
		const { maestro, storageStore, commandHandlers } = createStubMaestro({
			storage: {
				['placements:' + boardPath]: JSON.stringify({
					[key]: { columnId: 'done', enteredDoneAt: stamped },
				}),
			},
			tabsList: () => Promise.resolve([aiTab({ projectPath })]),
		});

		await plugin.activate(maestro);
		const move = commandHandlers.get('move')!;

		await move({ cardKey: key, toColumnId: 'in-progress' });
		const out = readPlacements(storageStore, boardPath)[key]!;
		expect(out.columnId).toBe('in-progress');
		expect(out.enteredDoneAt).toBeUndefined();

		await move({ cardKey: key, toColumnId: 'done' });
		const back = readPlacements(storageStore, boardPath)[key]!;
		expect(back.columnId).toBe('done');
		// A fresh clock, not the 30-day-old one it carried before the trip out.
		expect(back.enteredDoneAt).toEqual(expect.any(Number));
		expect(back.enteredDoneAt!).toBeGreaterThan(stamped);
	});

	it('reads a live card at the opacity its stored clock and its board settings imply', async () => {
		const plugin = loadMain();
		const boardPath = plugin.boardFilePath(projectPath);
		const now = Date.now();
		const { maestro } = createStubMaestro({
			storage: {
				['placements:' + boardPath]: JSON.stringify({
					[key]: { columnId: 'done', enteredDoneAt: now - 5 * DAY },
				}),
				'board-settings': JSON.stringify({
					[projectPath]: { agingEnabled: true, horizonDays: 10, closeTabsOnRetire: false },
				}),
			},
			tabsList: () => Promise.resolve([aiTab({ projectPath })]),
		});

		await plugin.activate(maestro);

		const state = plugin.agingStateForCard({ key, projectPath, columnId: 'done' }, 'done', now);
		expect(state.enabled).toBe(true);
		expect(state.opacity).toBe(0.55);
		expect(state.expired).toBe(false);
	});

	it('drops a stamp stored against a column that is not the terminal one', async () => {
		const plugin = loadMain();
		const boardPath = plugin.boardFilePath(projectPath);
		const { maestro, storageStore } = createStubMaestro({
			storage: {
				['placements:' + boardPath]: JSON.stringify({
					[key]: { columnId: 'review', enteredDoneAt: Date.now() - 2 * DAY },
				}),
			},
			tabsList: () => Promise.resolve([aiTab({ projectPath })]),
		});

		await plugin.activate(maestro);

		expect(readPlacements(storageStore, boardPath)[key]!.enteredDoneAt).toBeUndefined();
	});
});

describe('maestro-kanban board aging settings', () => {
	const projectPath = '/Users/dev/projects/widgets';

	it("persists a board's settings and merges a later partial patch over them", async () => {
		const plugin = loadMain();
		const { maestro, storageStore } = createStubMaestro();
		await plugin.activate(maestro);

		await plugin.setBoardAgingSettings(projectPath, { agingEnabled: true, horizonDays: 10 });
		expect(JSON.parse(storageStore.get('board-settings') as string)).toEqual({
			[projectPath]: { agingEnabled: true, horizonDays: 10, closeTabsOnRetire: false },
		});

		// A single toggle posted on its own keeps the horizon already stored.
		const merged = await plugin.setBoardAgingSettings(projectPath, { closeTabsOnRetire: true });
		expect(merged).toEqual({ agingEnabled: true, horizonDays: 10, closeTabsOnRetire: true });
	});

	it('restores stored settings on the next activate', async () => {
		const first = loadMain();
		const { maestro, storageStore } = createStubMaestro();
		await first.activate(maestro);
		await first.setBoardAgingSettings(projectPath, { agingEnabled: true, horizonDays: 21 });

		const second = loadMain();
		const { maestro: secondMaestro } = createStubMaestro({
			storage: Object.fromEntries(storageStore),
		});
		await second.activate(secondMaestro);

		expect(second.agingSettingsForBoard(projectPath)).toEqual({
			agingEnabled: true,
			horizonDays: 21,
			closeTabsOnRetire: false,
		});
	});

	it("falls back to the Global board's settings, then to aging off", async () => {
		const plugin = loadMain();
		const { maestro } = createStubMaestro();
		await plugin.activate(maestro);

		// Nothing configured anywhere: aging is off, which is the whole point
		// of the default.
		expect(plugin.agingSettingsForBoard(projectPath)).toEqual(plugin.DEFAULT_AGING_SETTINGS);

		await plugin.setBoardAgingSettings('__global__', { agingEnabled: true, horizonDays: 30 });
		expect(plugin.agingSettingsForBoard(projectPath)).toEqual({
			agingEnabled: true,
			horizonDays: 30,
			closeTabsOnRetire: false,
		});

		// A project board that has its own settings is not overridden by the
		// Global board's.
		await plugin.setBoardAgingSettings(projectPath, { agingEnabled: false, horizonDays: 7 });
		expect(plugin.agingSettingsForBoard(projectPath)).toEqual({
			agingEnabled: false,
			horizonDays: 7,
			closeTabsOnRetire: false,
		});
	});
});

// ---------------------------------------------------------------------------
// Archive storage: ~/.maestro/kanban-archive/<board>.json. Retirement itself
// is a later task in this phase; what is covered here is the file underneath
// it - the one path helper, the missing/unparseable cases, and the cap.
// ---------------------------------------------------------------------------

function archiveRecord(overrides: Partial<ArchiveRecord> = {}): ArchiveRecord {
	return {
		key: 'session-1::tab-1',
		retiredAt: NOW,
		reason: 'aged out of Done',
		title: 'Ship the thing',
		sessionId: 'session-1',
		tabId: 'tab-1',
		agentName: 'claude-code',
		projectPath: '/Users/dev/projects/widgets',
		columnHistory: ['backlog', 'in-progress', 'done'],
		description: 'A card that reached its horizon.',
		comments: [{ id: 'c1', body: 'nice', createdAt: NOW - DAY }],
		...overrides,
	};
}

describe('maestro-kanban archive storage', () => {
	const projectPath = '/Users/dev/projects/widgets';

	describe('archiveFilePath', () => {
		it("names a project's archive beside the slug its board YAML already uses", () => {
			const plugin = loadMain();
			const path = plugin.archiveFilePath(projectPath);
			expect(path).toBe(
				'~/.maestro/kanban-archive/' +
					plugin
						.boardFilePath(projectPath)
						.replace('~/.maestro/kanban-boards/', '')
						.replace('.yaml', '') +
					'.json'
			);
			expect(path.startsWith('~/.maestro/kanban-archive/')).toBe(true);
		});

		it('gives the Global board its own reserved basename', () => {
			const plugin = loadMain();
			expect(plugin.archiveFilePath(plugin.GLOBAL_BOARD_ID)).toBe(
				'~/.maestro/kanban-archive/global.json'
			);
		});

		it('refuses anything that is not a board id, so no caller can smuggle a path through it', () => {
			const plugin = loadMain();
			expect(() => plugin.archiveFilePath('')).toThrow(/board id/);
			expect(() => plugin.archiveFilePath(null)).toThrow(/board id/);
			expect(() => plugin.archiveFilePath(undefined)).toThrow(/board id/);
		});
	});

	describe('readStoredArchiveRecord', () => {
		it('keeps a record with a key and a date even when the rest is missing', () => {
			const plugin = loadMain();
			const record = plugin.readStoredArchiveRecord({ key: 'a::b', retiredAt: NOW });
			expect(record).toEqual({
				key: 'a::b',
				retiredAt: NOW,
				reason: '',
				title: '',
				sessionId: null,
				tabId: null,
				agentName: null,
				projectPath: null,
				columnHistory: [],
				description: '',
				comments: [],
			});
		});

		it('drops an entry with no key or no retirement date', () => {
			const plugin = loadMain();
			expect(plugin.readStoredArchiveRecord({ retiredAt: NOW })).toBeNull();
			expect(plugin.readStoredArchiveRecord({ key: 'a::b' })).toBeNull();
			expect(plugin.readStoredArchiveRecord({ key: 'a::b', retiredAt: 'yesterday' })).toBeNull();
			expect(plugin.readStoredArchiveRecord(null)).toBeNull();
			expect(plugin.readStoredArchiveRecord([])).toBeNull();
		});
	});

	it('reads a board that has never retired anything as an empty archive, not an error', async () => {
		const plugin = loadMain();
		const { maestro } = createStubMaestro();
		await plugin.activate(maestro);

		const archive = await plugin.loadArchive(projectPath);
		expect(archive).toEqual({ records: [], error: null, exists: false });
	});

	it('round-trips records through the file and lists them newest first', async () => {
		const plugin = loadMain();
		const { maestro, files } = createStubMaestro();
		await plugin.activate(maestro);

		await plugin.saveArchive(projectPath, [
			archiveRecord({ key: 'older', retiredAt: NOW - 3 * DAY }),
			archiveRecord({ key: 'newer', retiredAt: NOW }),
		]);

		expect(files.has(plugin.archiveFilePath(projectPath))).toBe(true);
		const archive = await plugin.loadArchive(projectPath);
		expect(archive.error).toBeNull();
		expect(archive.exists).toBe(true);
		expect(archive.records.map((record) => record.key)).toEqual(['newer', 'older']);
		expect(archive.records[0]).toEqual(archiveRecord({ key: 'newer' }));
	});

	it('surfaces an unparseable archive and never writes over it', async () => {
		const plugin = loadMain();
		const { maestro, files } = createStubMaestro();
		await plugin.activate(maestro);
		const path = plugin.archiveFilePath(projectPath);
		const handEdited = '{ this is not JSON';
		files.set(path, handEdited);

		const archive = await plugin.loadArchive(projectPath);
		expect(archive.exists).toBe(true);
		expect(archive.records).toEqual([]);
		expect(archive.error?.path).toBe(path);
		expect(archive.error?.message).toBeTruthy();

		await expect(plugin.saveArchive(projectPath, [archiveRecord()])).rejects.toThrow(
			/Refusing to overwrite an unreadable archive/
		);
		await expect(plugin.appendToArchive(projectPath, [archiveRecord()])).rejects.toThrow(
			/Refusing to overwrite an unreadable archive/
		);
		expect(files.get(path)).toBe(handEdited);
	});

	it('treats a JSON file that is not a record array as unreadable rather than empty', async () => {
		const plugin = loadMain();
		const { maestro, files } = createStubMaestro();
		await plugin.activate(maestro);
		files.set(plugin.archiveFilePath(projectPath), JSON.stringify({ version: 1 }));

		const archive = await plugin.loadArchive(projectPath);
		expect(archive.error?.message).toMatch(/not a record array/);
	});

	it('appends without doubling a key that is already archived', async () => {
		const plugin = loadMain();
		const { maestro } = createStubMaestro();
		await plugin.activate(maestro);

		await plugin.appendToArchive(projectPath, [archiveRecord({ key: 'a::b', retiredAt: NOW })]);
		await plugin.appendToArchive(projectPath, [
			archiveRecord({ key: 'c::d', retiredAt: NOW + DAY }),
			archiveRecord({ key: 'a::b', retiredAt: NOW + 2 * DAY, reason: 'archived by hand' }),
		]);

		const archive = await plugin.loadArchive(projectPath);
		expect(archive.records.map((record) => record.key)).toEqual(['a::b', 'c::d']);
		expect(archive.records[0]!.reason).toBe('archived by hand');
	});

	it('prunes the oldest records past the cap and logs every one it drops', () => {
		const plugin = loadMain();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const overflow = 3;
			const records = Array.from({ length: plugin.ARCHIVE_RECORD_CAP + overflow }, (_, index) =>
				archiveRecord({ key: 'card-' + index, retiredAt: NOW - index * 1000 })
			);

			const kept = plugin.pruneArchiveRecords(records, '~/.maestro/kanban-archive/x.json');

			expect(kept).toHaveLength(plugin.ARCHIVE_RECORD_CAP);
			// Newest survive; the `overflow` oldest are the ones dropped.
			expect(kept[0]!.key).toBe('card-0');
			expect(kept[kept.length - 1]!.key).toBe('card-' + (plugin.ARCHIVE_RECORD_CAP - 1));
			expect(warn).toHaveBeenCalledTimes(overflow);
			// One line per dropped record, naming it, so the one destructive
			// act in this phase is never silent.
			const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
			for (let index = 0; index < overflow; index++) {
				expect(logged).toContain('card-' + (plugin.ARCHIVE_RECORD_CAP + index));
			}
		} finally {
			warn.mockRestore();
		}
	});

	it('applies the cap on the way to disk, so the file never grows past it', async () => {
		const plugin = loadMain();
		const { maestro } = createStubMaestro();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			await plugin.activate(maestro);
			await plugin.saveArchive(
				projectPath,
				Array.from({ length: plugin.ARCHIVE_RECORD_CAP + 2 }, (_, index) =>
					archiveRecord({ key: 'card-' + index, retiredAt: NOW - index * 1000 })
				)
			);

			const archive = await plugin.loadArchive(projectPath);
			expect(archive.records).toHaveLength(plugin.ARCHIVE_RECORD_CAP);
			expect(archive.records.some((record) => record.key === 'card-500')).toBe(false);
		} finally {
			warn.mockRestore();
		}
	});

	it('keeps each board in its own file', async () => {
		const plugin = loadMain();
		const other = '/Users/dev/projects/gadgets';
		const { maestro } = createStubMaestro();
		await plugin.activate(maestro);

		await plugin.saveArchive(projectPath, [archiveRecord({ key: 'widgets::1' })]);
		await plugin.saveArchive(other, [archiveRecord({ key: 'gadgets::1', projectPath: other })]);

		expect((await plugin.loadArchive(projectPath)).records.map((r) => r.key)).toEqual([
			'widgets::1',
		]);
		expect((await plugin.loadArchive(other)).records.map((r) => r.key)).toEqual(['gadgets::1']);
	});
});
