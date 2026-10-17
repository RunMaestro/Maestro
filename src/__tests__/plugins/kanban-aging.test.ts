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
 *   - Retirement and the opt-in tab close are only observable end to end
 *     too: the sweep reads the live card model, so a test drives it through
 *     `activate()` (which sweeps once) or `runRetirementSweep(now)` with a
 *     clock pushed past the horizon, and asserts on the stub's `fs`,
 *     `storage` and `tabs.close` calls.
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
	RETIREMENT_TICK_MS: number;
	RETIREMENT_REASON_AGED: string;
	runRetirementSweep: (
		now?: number
	) => Promise<{ retired: string[]; failed: string[]; closed: string[]; deferred: string[] }>;
	isTabStatusBusy: (status: unknown) => boolean;
	planRetirementTabCloses: (expiredCards: unknown[]) => Promise<{
		retire: { key: string }[];
		closeTabs: { key: string }[];
		deferred: { key: string }[];
	}>;
	retireCards: (
		targets: unknown[],
		reason: string,
		now?: number
	) => Promise<{ retired: string[]; failed: string[] }>;
	RETIREMENT_REASON_CLEARED: string;
	RETIREMENT_REASON_ARCHIVED: string;
	cardsInTerminalColumn: () => Promise<{ key: string }[]>;
	clearDoneColumn: (
		boardId: string | null
	) => Promise<{ ok: boolean; retired: number; failed?: number; reason?: string }>;
	archiveCardNow: (cardKey: string) => Promise<{ ok: boolean; retired?: number; reason?: string }>;
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
	sessionsList?: () => Promise<unknown>;
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
			list: vi.fn(options.sessionsList ?? (() => Promise.resolve([]))),
			focus: vi.fn(() => Promise.resolve({ ok: true })),
		},
		tabs: {
			list: vi.fn(options.tabsList ?? (() => Promise.resolve([]))),
			// Retirement itself must never reach this; only the opt-in close
			// layer may, and only for a card whose board turned it on.
			close: vi.fn(() => Promise.resolve({ ok: true })),
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

// ---------------------------------------------------------------------------
// Retirement: the one path a card leaves the board by. Runs at activate() and
// on the low-frequency tick, writes the archive record first and edits the
// board second, and touches no tab - the opt-in close is a later layer, so
// `tabs.close` staying untouched is asserted here too.
// ---------------------------------------------------------------------------

/** The snapshot of the last panel push, or null when nothing was pushed. */
function lastSnapshot(panelPost: { mock: { calls: unknown[][] } }) {
	const calls = panelPost.mock.calls;
	if (calls.length === 0) return null;
	return calls[calls.length - 1]![1] as {
		columns: { id: string; cards: { key: string }[] }[];
	};
}

function snapshotKeys(panelPost: { mock: { calls: unknown[][] } }) {
	const snapshot = lastSnapshot(panelPost);
	if (!snapshot) return [];
	return snapshot.columns.flatMap((column) => column.cards.map((card) => card.key));
}

describe('maestro-kanban retirement', () => {
	const projectPath = '/Users/dev/projects/widgets';
	const key = 'session-1::tab-1';

	/** A board whose one card has been sitting in Done for `daysInDone` days,
	 * with aging configured however the test needs it. */
	function retirementStub(
		plugin: KanbanAging,
		daysInDone: number,
		settings: Partial<AgingSettings> = { agingEnabled: true, horizonDays: 14 },
		extra: StubOptions = {}
	) {
		const boardPath = plugin.boardFilePath(projectPath);
		return createStubMaestro({
			storage: {
				['placements:' + boardPath]: JSON.stringify({
					[key]: { columnId: 'done', order: 0, enteredDoneAt: Date.now() - daysInDone * DAY },
				}),
				'board-settings': JSON.stringify({
					[projectPath]: { closeTabsOnRetire: false, horizonDays: 14, ...settings },
				}),
				'card-notes': JSON.stringify({
					[key]: {
						description: 'Shipped it.',
						comments: [{ id: 'c1', body: 'reviewed', createdAt: Date.now() - 40 * DAY }],
					},
				}),
				...(extra.storage ?? {}),
			},
			files: extra.files,
			sessionsList:
				extra.sessionsList ??
				(() =>
					Promise.resolve([
						{ id: 'session-1', title: 'Widget Agent', agentId: 'claude-code', projectPath },
					])),
			tabsList:
				extra.tabsList ??
				(() => Promise.resolve([aiTab({ projectPath, title: 'Ship the thing' })])),
		});
	}

	it('retires a card past its horizon on activate, writing a complete archive record', async () => {
		const plugin = loadMain();
		const boardPath = plugin.boardFilePath(projectPath);
		const { maestro, files, storageStore } = retirementStub(plugin, 20);

		await plugin.activate(maestro);

		const archive = await plugin.loadArchive(projectPath);
		expect(archive.records).toHaveLength(1);
		const record = archive.records[0]!;
		expect(record).toEqual({
			key: key,
			retiredAt: expect.any(Number),
			reason: plugin.RETIREMENT_REASON_AGED,
			title: 'Ship the thing',
			sessionId: 'session-1',
			tabId: 'tab-1',
			// The name the user gave the agent, not the bare provider id.
			agentName: 'Widget Agent',
			projectPath: projectPath,
			// At minimum the column it retired FROM, always.
			columnHistory: ['done'],
			description: 'Shipped it.',
			comments: [{ id: 'c1', body: 'reviewed', createdAt: expect.any(Number) }],
		});
		// Written to that board's own archive file and nowhere else.
		expect(Array.from(files.keys())).toEqual([plugin.archiveFilePath(projectPath)]);
		// The placement entry is gone, so nothing remembers a column or a clock
		// for the card any more.
		expect(readPlacements(storageStore, boardPath)[key]).toBeUndefined();
		// And the card is off the board.
		expect(snapshotKeys(maestro.ui.panelPost)).toEqual([]);
	});

	it('never touches a tab, even for the card it just retired', async () => {
		const plugin = loadMain();
		const { maestro } = retirementStub(plugin, 20);

		await plugin.activate(maestro);

		expect((await plugin.loadArchive(projectPath)).records).toHaveLength(1);
		expect(maestro.tabs.close).not.toHaveBeenCalled();
	});

	it('retires nothing while aging is off, however old the clock is', async () => {
		const plugin = loadMain();
		const boardPath = plugin.boardFilePath(projectPath);
		const { maestro, files, storageStore } = retirementStub(plugin, 400, {
			agingEnabled: false,
		});

		await plugin.activate(maestro);

		// No archive file was even created, and the card kept its placement.
		expect(files.size).toBe(0);
		expect(readPlacements(storageStore, boardPath)[key]!.columnId).toBe('done');
		expect(snapshotKeys(maestro.ui.panelPost)).toEqual([key]);
		expect(maestro.tabs.close).not.toHaveBeenCalled();
	});

	it('leaves a card inside its horizon alone', async () => {
		const plugin = loadMain();
		const { maestro, files } = retirementStub(plugin, 13, {
			agingEnabled: true,
			horizonDays: 14,
		});

		await plugin.activate(maestro);

		expect(files.size).toBe(0);
		expect(snapshotKeys(maestro.ui.panelPost)).toEqual([key]);
	});

	it('keeps an already-archived card off the board even though its tab is still open', async () => {
		const plugin = loadMain();
		const first = retirementStub(plugin, 20);
		await plugin.activate(first.maestro);
		expect((await plugin.loadArchive(projectPath)).records).toHaveLength(1);

		// A second session over the same storage and the same still-open tab:
		// retirement did not close the tab, so only the archive keeps the card
		// off the board.
		const second = loadMain();
		const next = retirementStub(
			second,
			20,
			{ agingEnabled: true, horizonDays: 14 },
			{
				storage: Object.fromEntries(first.storageStore),
				files: Object.fromEntries(first.files),
			}
		);
		await second.activate(next.maestro);

		expect(snapshotKeys(next.maestro.ui.panelPost)).toEqual([]);
		// One record, not two: the card was not re-archived on the way through.
		expect((await second.loadArchive(projectPath)).records).toHaveLength(1);
	});

	it('leaves the card on the board when the archive refuses the write', async () => {
		const plugin = loadMain();
		const boardPath = plugin.boardFilePath(projectPath);
		const archivePath = plugin.archiveFilePath(projectPath);
		const broken = '{ this is not json';
		const { maestro, files, storageStore } = retirementStub(
			plugin,
			20,
			{ agingEnabled: true, horizonDays: 14 },
			{ files: { [archivePath]: broken } }
		);
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await plugin.activate(maestro);
		} finally {
			error.mockRestore();
		}

		// The unreadable file is untouched, and the card still has its column
		// and its clock, so the next sweep tries again.
		expect(files.get(archivePath)).toBe(broken);
		expect(readPlacements(storageStore, boardPath)[key]!.columnId).toBe('done');
		expect(snapshotKeys(maestro.ui.panelPost)).toEqual([key]);
	});

	it('records the columns a card actually travelled through before Done', async () => {
		const plugin = loadMain();
		const boardPath = plugin.boardFilePath(projectPath);
		const { maestro, commandHandlers } = createStubMaestro({
			storage: {
				['placements:' + boardPath]: JSON.stringify({ [key]: { columnId: 'backlog' } }),
				'board-settings': JSON.stringify({
					[projectPath]: { agingEnabled: true, horizonDays: 1, closeTabsOnRetire: false },
				}),
			},
			tabsList: () => Promise.resolve([aiTab({ projectPath })]),
		});
		await plugin.activate(maestro);

		await commandHandlers.get('move')!({ cardKey: key, toColumnId: 'in-progress' });
		await commandHandlers.get('move')!({ cardKey: key, toColumnId: 'done' });
		// The clock was stamped on that last move, so push the sweep's idea of
		// "now" past the one-day horizon instead of waiting a day.
		await plugin.runRetirementSweep(Date.now() + 2 * DAY);

		const archive = await plugin.loadArchive(projectPath);
		expect(archive.records[0]!.columnHistory).toEqual(['backlog', 'in-progress', 'done']);
	});

	it('refuses to retire a card with no project folder to archive it under', async () => {
		const plugin = loadMain();
		const { maestro } = createStubMaestro();
		await plugin.activate(maestro);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const result = await plugin.retireCards(
				[{ key: 'session-9::tab-9', title: 'Homeless', columnId: 'done' }],
				'manual'
			);
			expect(result).toEqual({ retired: [], failed: ['session-9::tab-9'] });
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('no project folder'));
		} finally {
			warn.mockRestore();
		}
	});

	it('sweeps on an interval measured in hours, not seconds', () => {
		const plugin = loadMain();
		expect(plugin.RETIREMENT_TICK_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
	});

	// -----------------------------------------------------------------------
	// The opt-in tab close. This is the only thing in the plugin that destroys
	// something a user cannot get back, so each of its four conditions gets a
	// test of its own: the board opted in, it is the card's own tab, the tab
	// is not busy right now, and the card really did retire.
	// -----------------------------------------------------------------------
	describe('opt-in tab close', () => {
		/** The same board, with "close tabs when cards close" turned on. */
		function closingStub(plugin: KanbanAging, daysInDone: number, extra: StubOptions = {}) {
			return retirementStub(
				plugin,
				daysInDone,
				{ agingEnabled: true, horizonDays: 14, closeTabsOnRetire: true },
				extra
			);
		}

		it('treats only a mid-turn status as busy, and an unknown status as not busy', () => {
			const plugin = loadMain();
			expect(plugin.isTabStatusBusy('busy')).toBe(true);
			expect(plugin.isTabStatusBusy('connecting')).toBe(true);
			expect(plugin.isTabStatusBusy('idle')).toBe(false);
			expect(plugin.isTabStatusBusy('error')).toBe(false);
			expect(plugin.isTabStatusBusy('')).toBe(false);
			expect(plugin.isTabStatusBusy(undefined)).toBe(false);
			// An unrecognized status reads as not busy on purpose: treating it as
			// busy would defer that card's retirement forever, not once.
			expect(plugin.isTabStatusBusy('reticulating')).toBe(false);
		});

		it("closes exactly the retiring card's own tab, once, when the board opted in", async () => {
			const plugin = loadMain();
			const { maestro } = closingStub(plugin, 20);
			const log = vi.spyOn(console, 'log').mockImplementation(() => {});
			let lines: string[] = [];
			try {
				await plugin.activate(maestro);
				lines = log.mock.calls.map((call) => String(call[0]));
			} finally {
				log.mockRestore();
			}

			expect(maestro.tabs.close).toHaveBeenCalledTimes(1);
			expect(maestro.tabs.close).toHaveBeenCalledWith('tab-1');
			// And it still retired the ordinary way.
			expect((await plugin.loadArchive(projectPath)).records).toHaveLength(1);
			expect(snapshotKeys(maestro.ui.panelPost)).toEqual([]);
			// Every close is logged with the card key and the retirement reason.
			const closeLog = lines.filter((line) => line.includes('closed tab'));
			expect(closeLog).toHaveLength(1);
			expect(closeLog[0]).toContain(key);
			expect(closeLog[0]).toContain('tab-1');
			expect(closeLog[0]).toContain(plugin.RETIREMENT_REASON_AGED);
		});

		it('leaves every other tab of the same agent alone', async () => {
			const plugin = loadMain();
			const boardPath = plugin.boardFilePath(projectPath);
			const { maestro } = closingStub(plugin, 20, {
				storage: {
					['placements:' + boardPath]: JSON.stringify({
						[key]: { columnId: 'done', order: 0, enteredDoneAt: Date.now() - 20 * DAY },
						'session-1::tab-2': { columnId: 'backlog', order: 0 },
					}),
				},
				tabsList: () =>
					Promise.resolve([
						aiTab({ projectPath, title: 'Ship the thing' }),
						aiTab({ id: 'tab-2', projectPath, title: 'Still working' }),
					]),
			});
			const log = vi.spyOn(console, 'log').mockImplementation(() => {});
			try {
				await plugin.activate(maestro);
			} finally {
				log.mockRestore();
			}

			expect(maestro.tabs.close.mock.calls).toEqual([['tab-1']]);
			expect(snapshotKeys(maestro.ui.panelPost)).toEqual(['session-1::tab-2']);
		});

		it('defers the whole retirement while the tab is busy, and closes nothing', async () => {
			const plugin = loadMain();
			const boardPath = plugin.boardFilePath(projectPath);
			let status = 'busy';
			const { maestro, files, storageStore } = closingStub(plugin, 20, {
				tabsList: () =>
					Promise.resolve([aiTab({ projectPath, title: 'Ship the thing', status: status })]),
			});
			const log = vi.spyOn(console, 'log').mockImplementation(() => {});
			let lines: string[] = [];
			try {
				await plugin.activate(maestro);
				lines = log.mock.calls.map((call) => String(call[0]));
			} finally {
				log.mockRestore();
			}

			expect(maestro.tabs.close).not.toHaveBeenCalled();
			// Deferred, not retired: no archive file, placement and clock intact,
			// card still on the board, and the deferral is on the record.
			expect(files.size).toBe(0);
			expect(readPlacements(storageStore, boardPath)[key]!.enteredDoneAt).toEqual(
				expect.any(Number)
			);
			expect(snapshotKeys(maestro.ui.panelPost)).toEqual([key]);
			expect(lines.filter((line) => line.includes('deferring'))).toHaveLength(1);

			// The next sweep, with the turn finished, retires it and closes it.
			status = 'idle';
			const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
			let sweep;
			try {
				sweep = await plugin.runRetirementSweep();
			} finally {
				quiet.mockRestore();
			}
			expect(sweep.retired).toEqual([key]);
			expect(sweep.closed).toEqual(['tab-1']);
			expect(maestro.tabs.close).toHaveBeenCalledWith('tab-1');
		});

		it('defers rather than closing when the host will not report tab status', async () => {
			const plugin = loadMain();
			let calls = 0;
			const { maestro, files } = closingStub(plugin, 20, {
				tabsList: () => {
					calls += 1;
					// The rebuild's read succeeds; the status check before a close
					// does not, which must never read as "idle".
					return calls === 1
						? Promise.resolve([aiTab({ projectPath, title: 'Ship the thing' })])
						: Promise.reject(new Error('host is gone'));
				},
			});
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				await plugin.activate(maestro);
			} finally {
				error.mockRestore();
			}

			expect(maestro.tabs.close).not.toHaveBeenCalled();
			expect(files.size).toBe(0);
			expect(snapshotKeys(maestro.ui.panelPost)).toEqual([key]);
		});

		it('retires without a close when the tab vanished between the rebuild and the sweep', async () => {
			const plugin = loadMain();
			let calls = 0;
			const { maestro } = closingStub(plugin, 20, {
				tabsList: () => {
					calls += 1;
					return calls === 1
						? Promise.resolve([aiTab({ projectPath, title: 'Ship the thing' })])
						: Promise.resolve([]);
				},
			});
			const log = vi.spyOn(console, 'log').mockImplementation(() => {});
			try {
				await plugin.activate(maestro);
			} finally {
				log.mockRestore();
			}

			// Nothing to close, so nothing is closed - but the card still retires.
			expect(maestro.tabs.close).not.toHaveBeenCalled();
			expect((await plugin.loadArchive(projectPath)).records).toHaveLength(1);
		});

		it('never closes a tab for a card the archive refused to take', async () => {
			const plugin = loadMain();
			const boardPath = plugin.boardFilePath(projectPath);
			const archivePath = plugin.archiveFilePath(projectPath);
			const broken = '{ this is not json';
			const { maestro, files, storageStore } = closingStub(plugin, 20, {
				files: { [archivePath]: broken },
			});
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				await plugin.activate(maestro);
			} finally {
				error.mockRestore();
			}

			// The card is still on the board, so it still has its tab.
			expect(maestro.tabs.close).not.toHaveBeenCalled();
			expect(files.get(archivePath)).toBe(broken);
			expect(readPlacements(storageStore, boardPath)[key]!.columnId).toBe('done');
			expect(snapshotKeys(maestro.ui.panelPost)).toEqual([key]);
		});

		it('leaves the card retired when the host rejects the close', async () => {
			const plugin = loadMain();
			const { maestro } = closingStub(plugin, 20);
			maestro.tabs.close.mockImplementation(() => Promise.reject(new Error('tab is pinned')));
			const log = vi.spyOn(console, 'log').mockImplementation(() => {});
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			let errors: string[] = [];
			try {
				await plugin.activate(maestro);
				errors = error.mock.calls.map((call) => String(call[0]));
			} finally {
				log.mockRestore();
				error.mockRestore();
			}

			// The archive record is the ledger and it is already written, so the
			// card stays retired; the user is left with a tab to close by hand.
			expect((await plugin.loadArchive(projectPath)).records).toHaveLength(1);
			expect(snapshotKeys(maestro.ui.panelPost)).toEqual([]);
			expect(errors.filter((line) => line.includes('could not close tab'))).toHaveLength(1);
		});

		it('does not read tab status at all when no expired card opted in', async () => {
			const plugin = loadMain();
			const { maestro } = retirementStub(plugin, 20, {
				agingEnabled: true,
				horizonDays: 14,
				closeTabsOnRetire: false,
			});

			await plugin.activate(maestro);

			// One read for the rebuild's seed and no second read for a close that
			// was never on the table.
			expect(maestro.tabs.list).toHaveBeenCalledTimes(1);
			expect(maestro.tabs.close).not.toHaveBeenCalled();
		});

		it('plans a close only for the board that opted in', async () => {
			const plugin = loadMain();
			const other = '/Users/dev/projects/gadgets';
			// Two idle tabs on two boards, only one of which turned the close on.
			// `other` has no settings of its own and no Global board settings to
			// inherit, so it runs on the defaults - which leave tabs alone.
			const { maestro } = createStubMaestro({
				storage: {
					'board-settings': JSON.stringify({
						[projectPath]: { agingEnabled: true, horizonDays: 14, closeTabsOnRetire: true },
					}),
				},
				tabsList: () =>
					Promise.resolve([
						aiTab({ id: 'tab-a', sessionId: 'session-a', projectPath }),
						aiTab({ id: 'tab-b', sessionId: 'session-b', projectPath: other }),
					]),
			});
			await plugin.activate(maestro);

			const plan = await plugin.planRetirementTabCloses([
				{ key: 'a', tabId: 'tab-a', projectPath: projectPath, columnId: 'done' },
				{ key: 'b', tabId: 'tab-b', projectPath: other, columnId: 'done' },
			]);
			expect(plan.closeTabs.map((card) => card.key)).toEqual(['a']);
			expect(plan.retire.map((card) => card.key).sort()).toEqual(['a', 'b']);
			expect(plan.deferred).toEqual([]);
		});
	});
});

// ---------------------------------------------------------------------------
// Phase 05 manual Done maintenance: Clear Done and Archive Now. Both are the
// same retireCards() the clock uses, so what these tests are really about is
// everything AROUND that call - which cards each one picks, that neither
// needs aging to be switched on, that a stale board id is refused, and that
// neither can close a tab even on a board that opted into closing them (the
// opt-in close belongs to age-out alone).
// ---------------------------------------------------------------------------

/** The `doneCardCount` the panel's confirm would name, off the last push. */
function lastDoneCount(panelPost: { mock: { calls: unknown[][] } }) {
	const calls = panelPost.mock.calls;
	if (calls.length === 0) return null;
	return (calls[calls.length - 1]![1] as { doneCardCount?: number }).doneCardCount ?? null;
}

describe('maestro-kanban manual Done maintenance', () => {
	const projectPath = '/Users/dev/projects/widgets';
	const firstDone = 'session-1::tab-1';
	const secondDone = 'session-1::tab-2';
	const inProgress = 'session-1::tab-3';

	/** One project board on screen with two cards parked in Done and one still
	 * in progress. Aging is switched OFF and "close tabs when cards close" is
	 * switched ON, which is the combination both manual actions have to be
	 * right about: they work with no aging configured at all, and they still
	 * never touch a tab. */
	function manualStub(plugin: KanbanAging, extra: StubOptions = {}) {
		const boardPath = plugin.boardFilePath(projectPath);
		return createStubMaestro({
			storage: {
				'selected-board': projectPath,
				['placements:' + boardPath]: JSON.stringify({
					[firstDone]: { columnId: 'done', order: 0 },
					[secondDone]: { columnId: 'done', order: 1 },
					[inProgress]: { columnId: 'in-progress', order: 0 },
				}),
				'board-settings': JSON.stringify({
					[projectPath]: { agingEnabled: false, horizonDays: 14, closeTabsOnRetire: true },
				}),
				'card-notes': JSON.stringify({
					[firstDone]: {
						description: 'Shipped it.',
						comments: [{ id: 'c1', body: 'reviewed', createdAt: Date.now() - 2 * DAY }],
					},
				}),
				...(extra.storage ?? {}),
			},
			files: extra.files,
			sessionsList: () =>
				Promise.resolve([
					{ id: 'session-1', title: 'Widget Agent', agentId: 'claude-code', projectPath },
				]),
			tabsList:
				extra.tabsList ??
				(() =>
					Promise.resolve([
						aiTab({ id: 'tab-1', projectPath, title: 'First Done' }),
						aiTab({ id: 'tab-2', projectPath, title: 'Second Done' }),
						aiTab({ id: 'tab-3', projectPath, title: 'Still Going' }),
					])),
		});
	}

	it('reports the count the panel confirm names, and only the cards in Done', async () => {
		const plugin = loadMain();
		const { maestro } = manualStub(plugin);

		await plugin.activate(maestro);

		expect(lastDoneCount(maestro.ui.panelPost)).toBe(2);
		expect((await plugin.cardsInTerminalColumn()).map((card) => card.key).sort()).toEqual([
			firstDone,
			secondDone,
		]);
	});

	it('clears every card in Done, with aging off, and leaves the other columns alone', async () => {
		const plugin = loadMain();
		const boardPath = plugin.boardFilePath(projectPath);
		const { maestro, files, storageStore, commandHandlers } = manualStub(plugin);
		await plugin.activate(maestro);

		const result = await commandHandlers.get('clear-done')!({ boardId: projectPath });

		expect(result).toEqual({ ok: true, retired: 2, failed: 0 });
		const archive = await plugin.loadArchive(projectPath);
		expect(archive.records.map((record) => record.key).sort()).toEqual([firstDone, secondDone]);
		// Stamped as a person's doing, not the horizon's.
		expect(archive.records.map((record) => record.reason)).toEqual([
			plugin.RETIREMENT_REASON_CLEARED,
			plugin.RETIREMENT_REASON_CLEARED,
		]);
		// The same complete record the clock writes, from the same code.
		const cleared = archive.records.find((record) => record.key === firstDone)!;
		expect(cleared.title).toBe('First Done');
		expect(cleared.agentName).toBe('Widget Agent');
		expect(cleared.columnHistory).toEqual(['done']);
		expect(cleared.description).toBe('Shipped it.');
		expect(cleared.comments).toHaveLength(1);
		// One archive file, that board's own.
		expect(Array.from(files.keys())).toEqual([plugin.archiveFilePath(projectPath)]);
		// The in-progress card kept its placement and its place on the board.
		const placements = readPlacements(storageStore, boardPath);
		expect(placements[firstDone]).toBeUndefined();
		expect(placements[secondDone]).toBeUndefined();
		expect(placements[inProgress]!.columnId).toBe('in-progress');
		expect(snapshotKeys(maestro.ui.panelPost)).toEqual([inProgress]);
		expect(lastDoneCount(maestro.ui.panelPost)).toBe(0);
	});

	it('never closes a tab, even on a board with "close tabs when cards close" on', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = manualStub(plugin);
		await plugin.activate(maestro);

		await commandHandlers.get('clear-done')!({ boardId: projectPath });
		await commandHandlers.get('archive-card')!({ cardKey: inProgress });

		// Both cards are retired, and all three tabs are untouched: the opt-in
		// close belongs to age-out alone.
		expect((await plugin.loadArchive(projectPath)).records).toHaveLength(3);
		expect(maestro.tabs.close).not.toHaveBeenCalled();
	});

	it('refuses a clear aimed at a board the user has switched away from', async () => {
		const plugin = loadMain();
		const boardPath = plugin.boardFilePath(projectPath);
		const { maestro, files, storageStore, commandHandlers } = manualStub(plugin);
		await plugin.activate(maestro);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const result = (await commandHandlers.get('clear-done')!({
				boardId: '/Users/dev/projects/other',
			})) as { ok: boolean; retired: number };
			expect(result.ok).toBe(false);
			expect(result.retired).toBe(0);
		} finally {
			warn.mockRestore();
		}

		// Nothing archived, nothing moved, and the user was told.
		expect(files.size).toBe(0);
		expect(readPlacements(storageStore, boardPath)[firstDone]!.columnId).toBe('done');
		expect(maestro.notifications.toast).toHaveBeenCalledWith(
			expect.stringContaining('the board changed')
		);
	});

	it('treats an already-empty Done as nothing to do rather than a failure', async () => {
		const plugin = loadMain();
		const { maestro, files, commandHandlers } = manualStub(plugin, {
			tabsList: () => Promise.resolve([aiTab({ id: 'tab-3', projectPath, title: 'Still Going' })]),
		});
		await plugin.activate(maestro);

		expect(await commandHandlers.get('clear-done')!({ boardId: projectPath })).toEqual({
			ok: true,
			retired: 0,
			failed: 0,
		});
		expect(files.size).toBe(0);
	});

	it('archives one card from the detail pane, wherever it sits, and leaves the rest', async () => {
		const plugin = loadMain();
		const boardPath = plugin.boardFilePath(projectPath);
		const { maestro, storageStore, commandHandlers } = manualStub(plugin);
		await plugin.activate(maestro);

		// Deliberately the card that is NOT in Done: Archive Now is a per-card
		// action on the pane, not a second Clear Done.
		expect(await commandHandlers.get('archive-card')!({ cardKey: inProgress })).toEqual({
			ok: true,
			retired: 1,
		});

		const archive = await plugin.loadArchive(projectPath);
		expect(archive.records).toHaveLength(1);
		expect(archive.records[0]!.key).toBe(inProgress);
		expect(archive.records[0]!.reason).toBe(plugin.RETIREMENT_REASON_ARCHIVED);
		expect(readPlacements(storageStore, boardPath)[inProgress]).toBeUndefined();
		expect(snapshotKeys(maestro.ui.panelPost).sort()).toEqual([firstDone, secondDone]);
		// Still two cards in Done, untouched by a single-card archive.
		expect(lastDoneCount(maestro.ui.panelPost)).toBe(2);
	});

	it('refuses Archive Now for a card that is no longer on the board', async () => {
		const plugin = loadMain();
		const { maestro, files, commandHandlers } = manualStub(plugin);
		await plugin.activate(maestro);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const result = (await commandHandlers.get('archive-card')!({
				cardKey: 'session-9::tab-9',
			})) as { ok: boolean };
			expect(result.ok).toBe(false);
		} finally {
			warn.mockRestore();
		}

		expect(files.size).toBe(0);
		expect(maestro.notifications.toast).toHaveBeenCalledWith(
			expect.stringContaining('no longer on the board')
		);
	});

	it('keeps a manually archived card off the board across a restart', async () => {
		const plugin = loadMain();
		const first = manualStub(plugin);
		await plugin.activate(first.maestro);
		await first.commandHandlers.get('clear-done')!({ boardId: projectPath });

		// The tabs are all still open (nothing closed one), so the archive is
		// the only thing keeping the cleared cards off the rebuilt board.
		const second = loadMain();
		const next = manualStub(second, {
			storage: Object.fromEntries(first.storageStore),
			files: Object.fromEntries(first.files),
		});
		await second.activate(next.maestro);

		expect(snapshotKeys(next.maestro.ui.panelPost)).toEqual([inProgress]);
		expect((await second.loadArchive(projectPath)).records).toHaveLength(2);
	});
});
