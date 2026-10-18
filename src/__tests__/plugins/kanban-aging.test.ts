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

/** What one card carries to the panel for Phase 05's Done decay, per
 * `agingRenderState()`. Numbers only: the sentence a person reads is the
 * panel's copy (see `kanban-panel.test.ts`), and `opacity` is the RENDER
 * opacity, floored at AGING_RENDER_OPACITY_FLOOR rather than at the model's
 * AGING_OPACITY_FLOOR. */
interface CardAgingPayload {
	opacity: number;
	elapsedDays: number;
	horizonDays: number;
	daysRemaining: number;
	expiringSoon: boolean;
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

/** The archive view's snapshot payload, per `buildArchiveView()`. */
interface ArchiveView {
	open: true;
	filter: string;
	boardName: string;
	boardCount: number;
	records: {
		key: string;
		boardId: string | null;
		title: string;
		projectName: string | null;
		agentName: string | null;
		retiredAt: number;
		reason: string;
		description: string;
		commentCount: number;
		comments: { id: string; body: string; createdAt: number }[];
		hasLiveTab: boolean | null;
	}[];
	total: number;
	hidden: number;
	archivedTotal: number;
	errors: { path: string; message: string }[];
	tabsUnknown: boolean;
}

/** The Phase 05 board settings payload, per `boardSettingsSnapshot()`. It
 * rides EVERY snapshot, unlike the archive view's: answering it is a Map
 * lookup rather than a file read, so there is nothing to gate behind an
 * "open" post. */
interface BoardSettingsPayload {
	boardId: string | null;
	boardName: string;
	agingEnabled: boolean;
	horizonDays: number;
	closeTabsOnRetire: boolean;
	inherited: boolean;
	inheritedFrom: string | null;
	minHorizonDays: number;
	maxHorizonDays: number;
}

interface KanbanAging {
	agingState: (card: AgingCard, settings: unknown, now: number) => AgingState;
	normalizeAgingSettings: (raw: unknown) => AgingSettings;
	DEFAULT_AGING_SETTINGS: AgingSettings;
	AGING_OPACITY_FLOOR: number;
	AGING_RENDER_OPACITY_FLOOR: number;
	AGING_SOON_DAYS: number;
	agingRenderState: (state: AgingState) => CardAgingPayload | null;
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
	removeFromArchive: (boardId: string, keys: string[]) => Promise<ArchiveRecord[]>;
	ARCHIVE_VIEW_LIMIT: number;
	archiveRecordMatches: (record: ArchiveRecord, needle: string) => boolean;
	buildArchiveView: () => Promise<ArchiveView | null>;
	setArchiveView: (args: unknown) => Promise<{ ok: boolean; open: boolean; filter: string }>;
	restoreArchivedCard: (
		cardKey: unknown,
		boardId?: unknown
	) => Promise<{ ok: boolean; reason?: string; readOnly?: boolean; columnId?: string | null }>;
	MIN_HORIZON_DAYS: number;
	MAX_HORIZON_DAYS: number;
	boardSettingsPatchFrom: (source: Record<string, unknown>) => Partial<AgingSettings>;
	boardSettingsSnapshot: () => BoardSettingsPayload;
	applyBoardSettings: (
		args: unknown
	) => Promise<{ ok: boolean; reason?: string; settings?: AgingSettings }>;
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
			// Phase 04's one-time grant, stubbed as already-willing: the only
			// thing aging wants out of `send-message` is the timestamp it
			// stamps on the card, not the consent flow around it (that is
			// kanban-messaging.test.ts's subject).
			requestAccess: vi.fn(() => Promise.resolve({ granted: true })),
		},
		agents: {
			dispatch: vi.fn(() => Promise.resolve({ ok: true })),
			list: vi.fn(() => Promise.resolve([])),
		},
		tabs: {
			list: vi.fn(options.tabsList ?? (() => Promise.resolve([]))),
			// Retirement itself must never reach this; only the opt-in close
			// layer may, and only for a card whose board turned it on.
			close: vi.fn(() => Promise.resolve({ ok: true })),
		},
		ui: {
			panelPost: vi.fn((_panelId: string, _message: unknown) => Promise.resolve({ ok: true })),
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

	// The three below share one shape: a card ten days into Done under a
	// 14-day horizon, swept ten days later. The control retires; the two
	// after it are touched in between and must not. `agingState()`'s reset
	// rule is unit-tested above, but only these reach the wiring that feeds
	// it - `agingStateForCard()` reading the card's note and its newest sent
	// message - so a reset that never arrived at the sweep would pass every
	// pure-function case and still retire a card someone just commented on.

	it('retires a card the clock caught up with while nothing touched it', async () => {
		const plugin = loadMain();
		const boardPath = plugin.boardFilePath(projectPath);
		const { maestro, files, storageStore } = retirementStub(plugin, 10);

		await plugin.activate(maestro);
		// Ten days in under a 14-day horizon, so activate's own sweep passed
		// over it.
		expect(files.size).toBe(0);

		const result = await plugin.runRetirementSweep(Date.now() + 10 * DAY);

		expect(result.retired).toEqual([key]);
		expect(readPlacements(storageStore, boardPath)[key]).toBeUndefined();
	});

	it('spares that same card when a comment restarted its clock', async () => {
		const plugin = loadMain();
		const boardPath = plugin.boardFilePath(projectPath);
		const { maestro, files, storageStore, commandHandlers } = retirementStub(plugin, 10);

		await plugin.activate(maestro);
		const cardNote = commandHandlers.get('card-note')!;
		expect(await cardNote({ cardKey: key, action: 'comment', body: 'one more thing' })).toEqual({
			ok: true,
		});

		// The comment restored full strength immediately, not only at the
		// next sweep.
		expect(
			plugin.agingStateForCard({ key, projectPath, columnId: 'done' }, 'done', Date.now()).opacity
		).toBe(1);

		const result = await plugin.runRetirementSweep(Date.now() + 10 * DAY);

		expect(result.retired).toEqual([]);
		expect(files.size).toBe(0);
		expect(readPlacements(storageStore, boardPath)[key]!.columnId).toBe('done');
	});

	it('spares it for a message sent through the composer too', async () => {
		const plugin = loadMain();
		const boardPath = plugin.boardFilePath(projectPath);
		const { maestro, files, storageStore, commandHandlers } = retirementStub(plugin, 10);

		await plugin.activate(maestro);
		const sendMessage = commandHandlers.get('send-message')!;
		expect(
			await sendMessage({
				cardKey: key,
				sessionId: 'session-1',
				tabId: 'tab-1',
				prompt: 'any update?',
			})
		).toEqual({ ok: true, error: null });

		const result = await plugin.runRetirementSweep(Date.now() + 10 * DAY);

		expect(result.retired).toEqual([]);
		expect(files.size).toBe(0);
		expect(readPlacements(storageStore, boardPath)[key]!.columnId).toBe('done');
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

// ---------------------------------------------------------------------------
// Phase 05 archive view: the half of "aging is never destructive" a person
// can see. These tests are about what the view REPORTS (newest first, which
// records still have a tab behind them, what the filter covers, what an
// unreadable file does) and about Restore being the exact inverse of
// retirement - back on the board when its tab is still there, refused and
// left read-only when it is not.
// ---------------------------------------------------------------------------

/** The `archive` payload off the last panel push, or null when none rode. */
function lastArchive(panelPost: { mock: { calls: unknown[][] } }) {
	const calls = panelPost.mock.calls;
	if (calls.length === 0) return null;
	return (calls[calls.length - 1]![1] as { archive?: ArchiveView | null }).archive ?? null;
}

describe('maestro-kanban archive view', () => {
	const projectPath = '/Users/dev/projects/widgets';
	const otherProject = '/Users/dev/projects/gadgets';
	const key = 'session-1::tab-1';
	const goneKey = 'session-1::tab-2';

	/** A board with two records already archived: one whose tab is still
	 * open (so it can come back) and one whose tab is long closed (so it is
	 * read-only). Aging is off, so nothing retires during the test and the
	 * archive is exactly what the test wrote. */
	function archiveViewStub(plugin: KanbanAging, extra: StubOptions = {}) {
		return createStubMaestro({
			storage: {
				'selected-board': projectPath,
				...(extra.storage ?? {}),
			},
			files: {
				[plugin.archiveFilePath(projectPath)]: JSON.stringify({
					version: 1,
					records: [
						archiveRecord({
							key: key,
							title: 'Ship the thing',
							retiredAt: NOW - DAY,
							reason: plugin.RETIREMENT_REASON_AGED,
							comments: [{ id: 'c1', body: 'shipped on Friday', createdAt: NOW - 2 * DAY }],
						}),
						archiveRecord({
							key: goneKey,
							tabId: 'tab-2',
							title: 'Old experiment',
							retiredAt: NOW - 30 * DAY,
							reason: plugin.RETIREMENT_REASON_CLEARED,
							comments: [],
						}),
					],
				}),
				...(extra.files ?? {}),
			},
			sessionsList:
				extra.sessionsList ??
				(() =>
					Promise.resolve([
						{ id: 'session-1', title: 'Widget Agent', agentId: 'claude-code', projectPath },
					])),
			// Only tab-1 still exists; tab-2's record has no tab behind it.
			tabsList:
				extra.tabsList ??
				(() => Promise.resolve([aiTab({ id: 'tab-1', projectPath, title: 'Ship the thing' })])),
		});
	}

	it('sends no archive payload at all until the panel opens the view', async () => {
		const plugin = loadMain();
		const { maestro } = archiveViewStub(plugin);

		await plugin.activate(maestro);

		expect(lastArchive(maestro.ui.panelPost)).toBeNull();
		// The two archived cards are off the board, which is the state the
		// view exists to explain.
		expect(snapshotKeys(maestro.ui.panelPost)).toEqual([]);
	});

	it("lists a board's records newest first and says which still have a live tab", async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = archiveViewStub(plugin);
		await plugin.activate(maestro);

		await commandHandlers.get('archive-view')!({ open: true });

		const archive = lastArchive(maestro.ui.panelPost);
		expect(archive).not.toBeNull();
		expect(archive!.records.map((record) => record.key)).toEqual([key, goneKey]);
		expect(archive!.records[0]).toMatchObject({
			title: 'Ship the thing',
			boardId: projectPath,
			projectName: 'widgets',
			agentName: 'claude-code',
			reason: plugin.RETIREMENT_REASON_AGED,
			commentCount: 1,
			// Its tab is still open, so this one can be restored.
			hasLiveTab: true,
		});
		// Its tab was closed, so it is a read-only record from here on.
		expect(archive!.records[1]!.hasLiveTab).toBe(false);
		expect(archive!.total).toBe(2);
		expect(archive!.hidden).toBe(0);
		expect(archive!.errors).toEqual([]);
		expect(archive!.tabsUnknown).toBe(false);

		// Closing it takes the payload back off the snapshot.
		await commandHandlers.get('archive-view')!({ open: false });
		expect(lastArchive(maestro.ui.panelPost)).toBeNull();
	});

	it('filters over titles and comments, case-insensitively, across the whole archive', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = archiveViewStub(plugin);
		await plugin.activate(maestro);
		const view = commandHandlers.get('archive-view')!;

		await view({ open: true, filter: 'SHIP THE' });
		expect(lastArchive(maestro.ui.panelPost)!.records.map((record) => record.key)).toEqual([key]);

		// A word that appears only in a comment, never in a title.
		await view({ open: true, filter: 'friday' });
		const byComment = lastArchive(maestro.ui.panelPost)!;
		expect(byComment.records.map((record) => record.key)).toEqual([key]);
		expect(byComment.filter).toBe('friday');
		expect(byComment.total).toBe(1);
		// The whole archive is still counted, so the view can say what the
		// filter is hiding rather than looking like the archive shrank.
		expect(byComment.archivedTotal).toBe(2);

		await view({ open: true, filter: 'nothing matches this' });
		expect(lastArchive(maestro.ui.panelPost)!.records).toEqual([]);

		// Pure, and the same answer the payload was built from.
		expect(plugin.archiveRecordMatches(archiveRecord({ title: 'Ship' }), 'ship')).toBe(true);
		expect(plugin.archiveRecordMatches(archiveRecord({ title: 'Ship' }), 'barge')).toBe(false);
		expect(plugin.archiveRecordMatches(archiveRecord({ comments: [] }), '')).toBe(true);
	});

	it('merges every board it knows about on the Global board, including a project with no open tabs', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = archiveViewStub(plugin, {
			storage: { 'selected-board': plugin.GLOBAL_BOARD_ID },
			// gadgets has no live tab at all, so only the remembered index can
			// make its archive findable.
			files: {
				[plugin.archiveFilePath(otherProject)]: JSON.stringify({
					version: 1,
					records: [
						archiveRecord({
							key: 'session-9::tab-9',
							sessionId: 'session-9',
							tabId: 'tab-9',
							projectPath: otherProject,
							title: 'A gadget card',
							retiredAt: NOW - 5 * DAY,
						}),
					],
				}),
			},
		});
		await plugin.activate(maestro);

		await commandHandlers.get('archive-view')!({ open: true });
		const withoutIndex = lastArchive(maestro.ui.panelPost)!;
		// Nothing has retired in this session and the index was never written,
		// so the only archive the Global board can find is the live project's.
		expect(withoutIndex.records.map((record) => record.key)).toEqual([key, goneKey]);

		// Now with the index that retirement maintains.
		const indexed = loadMain();
		const second = archiveViewStub(indexed, {
			storage: {
				'selected-board': indexed.GLOBAL_BOARD_ID,
				'archive-boards': JSON.stringify([otherProject]),
			},
			files: {
				[indexed.archiveFilePath(otherProject)]: JSON.stringify({
					version: 1,
					records: [
						archiveRecord({
							key: 'session-9::tab-9',
							projectPath: otherProject,
							title: 'A gadget card',
							retiredAt: NOW - 5 * DAY,
						}),
					],
				}),
			},
		});
		await indexed.activate(second.maestro);
		await second.commandHandlers.get('archive-view')!({ open: true });
		const merged = lastArchive(second.maestro.ui.panelPost)!;
		expect(merged.records.map((record) => record.key)).toEqual([key, 'session-9::tab-9', goneKey]);
		expect(merged.records.map((record) => record.projectName)).toEqual([
			'widgets',
			'gadgets',
			'widgets',
		]);
		expect(merged.boardCount).toBe(2);
	});

	it('remembers a board in the archive index when retirement writes its first record', async () => {
		const plugin = loadMain();
		const boardPath = plugin.boardFilePath(projectPath);
		const { maestro, storageStore } = createStubMaestro({
			storage: {
				['placements:' + boardPath]: JSON.stringify({
					[key]: { columnId: 'done', order: 0, enteredDoneAt: Date.now() - 30 * DAY },
				}),
				'board-settings': JSON.stringify({
					[projectPath]: { agingEnabled: true, horizonDays: 14, closeTabsOnRetire: false },
				}),
			},
			tabsList: () => Promise.resolve([aiTab({ projectPath })]),
		});

		await plugin.activate(maestro);

		expect((await plugin.loadArchive(projectPath)).records).toHaveLength(1);
		expect(JSON.parse(storageStore.get('archive-boards') as string)).toEqual([projectPath]);
	});

	it('surfaces an unreadable archive file instead of reporting an empty archive', async () => {
		const plugin = loadMain();
		const { maestro, files, commandHandlers } = archiveViewStub(plugin, {
			files: { [plugin.archiveFilePath(projectPath)]: '{ not json' },
		});
		await plugin.activate(maestro);
		const before = files.get(plugin.archiveFilePath(projectPath));

		await commandHandlers.get('archive-view')!({ open: true });

		const archive = lastArchive(maestro.ui.panelPost)!;
		expect(archive.records).toEqual([]);
		expect(archive.errors).toHaveLength(1);
		expect(archive.errors[0]!.path).toBe(plugin.archiveFilePath(projectPath));
		// And reading it never rewrote it.
		expect(files.get(plugin.archiveFilePath(projectPath))).toBe(before);
	});

	it('reports a tab list the host refused as unknown rather than guessing the tab is gone', async () => {
		const plugin = loadMain();
		let failTabs = false;
		const { maestro, commandHandlers } = archiveViewStub(plugin, {
			tabsList: () =>
				failTabs
					? Promise.reject(new Error('tabs.list denied'))
					: Promise.resolve([aiTab({ id: 'tab-1', projectPath })]),
		});
		await plugin.activate(maestro);
		failTabs = true;

		await commandHandlers.get('archive-view')!({ open: true });

		const archive = lastArchive(maestro.ui.panelPost)!;
		expect(archive.tabsUnknown).toBe(true);
		expect(archive.records.map((record) => record.hasLiveTab)).toEqual([null, null]);
		// And a restore asked for anyway is refused rather than acted on.
		expect(await plugin.restoreArchivedCard(key, projectPath)).toMatchObject({ ok: false });
		expect((await plugin.loadArchive(projectPath)).records).toHaveLength(2);
	});

	it('caps the payload at ARCHIVE_VIEW_LIMIT records and says how many it is not showing', async () => {
		const plugin = loadMain();
		const many: ArchiveRecord[] = [];
		for (let i = 0; i < plugin.ARCHIVE_VIEW_LIMIT + 7; i++) {
			many.push(
				archiveRecord({
					key: 'session-1::tab-' + i,
					tabId: 'tab-' + i,
					title: 'Card ' + i,
					retiredAt: NOW - i * 1000,
				})
			);
		}
		const { maestro, commandHandlers } = archiveViewStub(plugin, {
			files: {
				[plugin.archiveFilePath(projectPath)]: JSON.stringify({ version: 1, records: many }),
			},
		});
		await plugin.activate(maestro);

		await commandHandlers.get('archive-view')!({ open: true });

		const archive = lastArchive(maestro.ui.panelPost)!;
		expect(archive.records).toHaveLength(plugin.ARCHIVE_VIEW_LIMIT);
		// Newest first, so what rides out is what a person is looking for.
		expect(archive.records[0]!.title).toBe('Card 0');
		expect(archive.total).toBe(plugin.ARCHIVE_VIEW_LIMIT + 7);
		expect(archive.hidden).toBe(7);
	});

	it('restores a card whose tab is still open, record out of the archive and card back on the board', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = archiveViewStub(plugin);
		await plugin.activate(maestro);
		expect(snapshotKeys(maestro.ui.panelPost)).toEqual([]);

		const result = await commandHandlers.get('restore-card')!({
			cardKey: key,
			boardId: projectPath,
		});

		expect(result).toEqual({ ok: true, columnId: 'backlog' });
		// The record is gone from the archive, and only that record.
		const archive = await plugin.loadArchive(projectPath);
		expect(archive.records.map((record) => record.key)).toEqual([goneKey]);
		// And the card is drawn again, with its stored note still on it: the
		// thread was never deleted, so Restore gets the live one back.
		const snapshot = lastSnapshot(maestro.ui.panelPost)!;
		expect(snapshotKeys(maestro.ui.panelPost)).toEqual([key]);
		const restored = (
			snapshot.columns.flatMap((column) => column.cards) as { key: string; title?: string }[]
		).find((card) => card.key === key);
		expect(restored!.title).toBe('Ship the thing');
		// Restoring is bookkeeping too: no tab is touched by it either.
		expect(maestro.tabs.close).not.toHaveBeenCalled();
	});

	it('refuses to restore a record whose tab is gone, and leaves it in the archive read-only', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = archiveViewStub(plugin);
		await plugin.activate(maestro);

		const result = await commandHandlers.get('restore-card')!({
			cardKey: goneKey,
			boardId: projectPath,
		});

		expect(result).toMatchObject({ ok: false, readOnly: true });
		expect((result as { reason: string }).reason).toContain('its tab is gone');
		// Still archived, still both records, nothing on the board.
		expect((await plugin.loadArchive(projectPath)).records.map((record) => record.key)).toEqual([
			key,
			goneKey,
		]);
		expect(snapshotKeys(maestro.ui.panelPost)).toEqual([]);
		// The user is told, rather than left with a button that did nothing.
		expect(maestro.notifications.toast).toHaveBeenCalledWith(
			expect.stringContaining('cannot come back')
		);
	});

	it('refuses a restore for a record that is no longer in the archive', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = archiveViewStub(plugin);
		await plugin.activate(maestro);

		const result = await commandHandlers.get('restore-card')!({
			cardKey: 'session-7::tab-7',
			boardId: projectPath,
		});

		expect(result).toMatchObject({ ok: false });
		expect((result as { reason: string }).reason).toContain('no longer in the archive');
	});

	it('never rewrites an unreadable archive on a restore either', async () => {
		const plugin = loadMain();
		const path = plugin.archiveFilePath(projectPath);
		const { maestro, files } = archiveViewStub(plugin);
		await plugin.activate(maestro);
		// Hand-edited into nonsense between the view opening and the click.
		files.set(path, '{ not json');

		const result = await plugin.restoreArchivedCard(key, projectPath);

		// No record can be found in a file that does not parse, so the restore
		// is refused - naming the file rather than claiming the record is gone -
		// and the file is left exactly as it was.
		expect(result).toMatchObject({ ok: false });
		expect((result as { reason: string }).reason).toContain('could not be read');
		expect((result as { reason: string }).reason).toContain(path);
		expect(files.get(path)).toBe('{ not json');
	});

	it('keeps a restored card on the board across a restart', async () => {
		const plugin = loadMain();
		const first = archiveViewStub(plugin);
		await plugin.activate(first.maestro);
		await first.commandHandlers.get('restore-card')!({ cardKey: key, boardId: projectPath });

		// Same files and storage, fresh module state: the archive no longer
		// holds the card, so nothing hides it on the way back in.
		const next = loadMain();
		const second = createStubMaestro({
			storage: Object.fromEntries(first.storageStore),
			files: Object.fromEntries(first.files),
			sessionsList: () =>
				Promise.resolve([
					{ id: 'session-1', title: 'Widget Agent', agentId: 'claude-code', projectPath },
				]),
			tabsList: () =>
				Promise.resolve([aiTab({ id: 'tab-1', projectPath, title: 'Ship the thing' })]),
		});
		await next.activate(second.maestro);

		expect(snapshotKeys(second.maestro.ui.panelPost)).toEqual([key]);
	});
});

// ---------------------------------------------------------------------------
// The board settings surface: what the panel draws the three aging controls
// from, and what its `board-settings` posts actually write.
// ---------------------------------------------------------------------------

/** The settings payload of the last panel push. */
function lastSettings(panelPost: { mock: { calls: unknown[][] } }) {
	const calls = panelPost.mock.calls;
	if (calls.length === 0) return null;
	return (calls[calls.length - 1]![1] as { settings?: BoardSettingsPayload }).settings ?? null;
}

describe('maestro-kanban board settings surface', () => {
	const projectPath = '/Users/dev/projects/widgets';
	const key = 'session-1::tab-1';

	/** One Done card on a named project board, so `currentBoardId()` has an
	 * answer and the settings surface has something to configure. */
	function settingsStub(plugin: KanbanAging, extra: StubOptions = {}) {
		const boardPath = plugin.boardFilePath(projectPath);
		return createStubMaestro({
			storage: {
				'selected-board': projectPath,
				['placements:' + boardPath]: JSON.stringify({
					[key]: { columnId: 'done', order: 0, enteredDoneAt: Date.now() - 2 * DAY },
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
				(() => Promise.resolve([aiTab({ projectPath, title: 'Ship the thing' })])),
		});
	}

	describe('boardSettingsPatchFrom', () => {
		it('keeps an absent field absent, so one control never restates the other two', () => {
			const plugin = loadMain();
			expect(plugin.boardSettingsPatchFrom({ agingEnabled: true })).toEqual({ agingEnabled: true });
			expect(plugin.boardSettingsPatchFrom({})).toEqual({});
		});

		it('takes a horizon as a number or as the string a number input hands over', () => {
			const plugin = loadMain();
			expect(plugin.boardSettingsPatchFrom({ horizonDays: 10 })).toEqual({ horizonDays: 10 });
			expect(plugin.boardSettingsPatchFrom({ horizonDays: '10' })).toEqual({ horizonDays: 10 });
			// Not a number anyone meant: dropped rather than guessed. Clamping a
			// number that IS meant is normalizeAgingSettings()'s job, not this
			// one's, so an out-of-range value still rides through.
			expect(plugin.boardSettingsPatchFrom({ horizonDays: '' })).toEqual({});
			expect(plugin.boardSettingsPatchFrom({ horizonDays: 'soon' })).toEqual({});
			expect(plugin.boardSettingsPatchFrom({ horizonDays: 0 })).toEqual({ horizonDays: 0 });
		});

		it('treats anything but a literal true as off for both toggles', () => {
			const plugin = loadMain();
			expect(plugin.boardSettingsPatchFrom({ agingEnabled: 'yes', closeTabsOnRetire: 1 })).toEqual({
				agingEnabled: false,
				closeTabsOnRetire: false,
			});
		});
	});

	it('rides the settings payload on every snapshot, with the bounds the panel clamps to', async () => {
		const plugin = loadMain();
		const { maestro } = settingsStub(plugin);

		await plugin.activate(maestro);

		expect(lastSettings(maestro.ui.panelPost)).toEqual({
			boardId: projectPath,
			boardName: 'widgets',
			agingEnabled: false,
			horizonDays: 14,
			closeTabsOnRetire: false,
			// Nothing stored for this board and nothing stored for Global, so
			// these are the shipped defaults and there is no board to name.
			inherited: true,
			inheritedFrom: null,
			minHorizonDays: plugin.MIN_HORIZON_DAYS,
			maxHorizonDays: plugin.MAX_HORIZON_DAYS,
		});
	});

	it('names the Global board when a project board is running on its settings, and stops once it has its own', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = settingsStub(plugin, {
			storage: {
				'board-settings': JSON.stringify({
					[plugin.GLOBAL_BOARD_ID]: {
						agingEnabled: true,
						horizonDays: 21,
						closeTabsOnRetire: false,
					},
				}),
			},
		});

		await plugin.activate(maestro);

		const inherited = lastSettings(maestro.ui.panelPost)!;
		expect(inherited.inherited).toBe(true);
		expect(inherited.inheritedFrom).toBe('Global');
		// The VALUES are Global's, which is exactly why the surface has to say
		// where they came from rather than presenting them as this board's own.
		expect(inherited.agingEnabled).toBe(true);
		expect(inherited.horizonDays).toBe(21);

		await commandHandlers.get('board-settings')!({ boardId: projectPath, horizonDays: 7 });

		const own = lastSettings(maestro.ui.panelPost)!;
		expect(own.inherited).toBe(false);
		expect(own.inheritedFrom).toBeNull();
		// The first change writes all three: a board stops inheriting the
		// moment it is configured, so the other two are saved as they stood.
		expect(own).toMatchObject({ agingEnabled: true, horizonDays: 7, closeTabsOnRetire: false });
	});

	it('persists each setting, clamps the horizon, and repaints the board in the same push', async () => {
		const plugin = loadMain();
		const { maestro, storageStore, commandHandlers } = settingsStub(plugin);
		await plugin.activate(maestro);
		const pushesBefore = maestro.ui.panelPost.mock.calls.length;

		const result = (await commandHandlers.get('board-settings')!({
			boardId: projectPath,
			agingEnabled: true,
		})) as { ok: boolean; settings: AgingSettings };
		expect(result.ok).toBe(true);
		expect(result.settings.agingEnabled).toBe(true);

		await commandHandlers.get('board-settings')!({ boardId: projectPath, horizonDays: 10_000 });

		const stored = JSON.parse(storageStore.get('board-settings') as string) as Record<
			string,
			AgingSettings
		>;
		expect(stored[projectPath]).toEqual({
			agingEnabled: true,
			// Clamped rather than refused, so a hand-typed 10000 cannot wedge
			// the board.
			horizonDays: 365,
			closeTabsOnRetire: false,
		});
		// Every accepted change pushes: the point of changing a horizon is
		// seeing the Done cards shift along it right away.
		expect(maestro.ui.panelPost.mock.calls.length).toBe(pushesBefore + 2);
		expect(lastSettings(maestro.ui.panelPost)!.horizonDays).toBe(365);
		// A settings write is bookkeeping: nothing here touches a tab.
		expect(maestro.tabs.close).not.toHaveBeenCalled();
	});

	it('refuses a post aimed at a board the user has switched away from', async () => {
		const plugin = loadMain();
		const { maestro, storageStore, commandHandlers } = settingsStub(plugin);
		await plugin.activate(maestro);

		const result = (await commandHandlers.get('board-settings')!({
			boardId: '/Users/dev/projects/other',
			closeTabsOnRetire: true,
		})) as { ok: boolean; reason: string };

		expect(result.ok).toBe(false);
		expect(result.reason).toContain('the board changed');
		expect(maestro.notifications.toast).toHaveBeenCalled();
		// Nothing was written, least of all the setting that closes tabs.
		expect(storageStore.get('board-settings')).toBeUndefined();
	});

	it('refuses a post with no board and one that names no setting it understands', async () => {
		const plugin = loadMain();
		const { maestro, storageStore, commandHandlers } = settingsStub(plugin);
		await plugin.activate(maestro);
		const boardSettings = commandHandlers.get('board-settings')!;

		const noBoard = (await boardSettings({ agingEnabled: true })) as {
			ok: boolean;
			reason: string;
		};
		expect(noBoard.ok).toBe(false);
		expect(noBoard.reason).toContain('no board on screen');

		const nothing = (await boardSettings({ boardId: projectPath, horizonDays: 'soon' })) as {
			ok: boolean;
			reason: string;
		};
		expect(nothing.ok).toBe(false);
		expect(nothing.reason).toContain('no setting');
		expect(storageStore.get('board-settings')).toBeUndefined();
	});

	it('does not retire anything on the click that turns aging on', async () => {
		const plugin = loadMain();
		const { maestro, files, commandHandlers } = settingsStub(plugin, {
			storage: {
				['placements:' + plugin.boardFilePath(projectPath)]: JSON.stringify({
					// Long past any horizon anyone would pick.
					[key]: { columnId: 'done', order: 0, enteredDoneAt: Date.now() - 400 * DAY },
				}),
			},
		});
		await plugin.activate(maestro);

		await commandHandlers.get('board-settings')!({ boardId: projectPath, agingEnabled: true });

		// One checkbox must not empty a Done column: nothing was archived and
		// the card is still on the board. Clear Done is the control that
		// retires on demand, and it asks first; the retirement tick is what
		// eventually acts on the clock.
		expect(files.size).toBe(0);
		expect(snapshotKeys(maestro.ui.panelPost)).toEqual([key]);
		expect(maestro.tabs.close).not.toHaveBeenCalled();
	});

	it('keeps a board settings change across a restart', async () => {
		const first = loadMain();
		const { maestro, storageStore, commandHandlers } = settingsStub(first);
		await first.activate(maestro);
		await commandHandlers.get('board-settings')!({
			boardId: projectPath,
			agingEnabled: true,
			horizonDays: 10,
			closeTabsOnRetire: true,
		});

		const second = loadMain();
		const next = settingsStub(second, {
			storage: Object.fromEntries(storageStore),
			// The card is gone by now, so the restart cannot retire it and the
			// stored settings are the only thing under test.
			tabsList: () => Promise.resolve([]),
		});
		await second.activate(next.maestro);

		expect(second.agingSettingsForBoard(projectPath)).toEqual({
			agingEnabled: true,
			horizonDays: 10,
			closeTabsOnRetire: true,
		});
		expect(lastSettings(next.maestro.ui.panelPost)).toMatchObject({
			boardId: projectPath,
			agingEnabled: true,
			horizonDays: 10,
			closeTabsOnRetire: true,
			inherited: false,
		});
	});
});

// ---------------------------------------------------------------------------
// The Done decay as the panel receives it. agingState() above answers "how
// far along is this card"; agingRenderState() answers "what does the board
// draw", and the `aging` field on every card of a snapshot is how that answer
// travels. The two floors are deliberately different numbers and the reason
// is the whole point of this layer: the model's floor describes a card that
// has run its horizon, the render floor is the faintest a still-clickable
// card may be drawn.
// ---------------------------------------------------------------------------

/** Every card of the last pushed snapshot, keyed by card key, so a test can
 * assert on the `aging` field one card arrived with. */
function lastCardsByKey(panelPost: { mock: { calls: unknown[][] } }) {
	const snapshot = lastSnapshot(panelPost) as {
		columns: { cards: { key: string; aging?: CardAgingPayload }[] }[];
	} | null;
	const byKey = new Map<string, { key: string; aging?: CardAgingPayload }>();
	if (!snapshot) return byKey;
	for (const column of snapshot.columns) {
		for (const card of column.cards) byKey.set(card.key, card);
	}
	return byKey;
}

describe('maestro-kanban Done decay rendering', () => {
	const projectPath = '/Users/dev/projects/widgets';
	const key = 'session-1::tab-1';

	describe('agingRenderState', () => {
		const enabled = { agingEnabled: true, horizonDays: 10 };
		const stateAt = (plugin: KanbanAging, daysAgo: number, settings: unknown = enabled) =>
			plugin.agingState(doneCard({ enteredDoneAt: NOW - daysAgo * DAY }), settings, NOW);

		it('has nothing to draw for a card aging does not apply to', () => {
			const plugin = loadMain();
			// Aging off for this board.
			expect(plugin.agingRenderState(stateAt(plugin, 5, { agingEnabled: false }))).toBeNull();
			// In a column that is not Done, with aging on.
			expect(
				plugin.agingRenderState(
					plugin.agingState(
						{ columnId: 'review', terminalColumnId: 'done', enteredDoneAt: NOW - 5 * DAY },
						enabled,
						NOW
					)
				)
			).toBeNull();
		});

		it('re-maps the same linear decay onto the readable range', () => {
			const plugin = loadMain();
			const floor = plugin.AGING_RENDER_OPACITY_FLOOR;

			expect(plugin.agingRenderState(stateAt(plugin, 0))!.opacity).toBe(1);
			// Half the horizon is half the ramp, exactly as it is in the model -
			// the curve is re-scaled, never re-shaped.
			expect(plugin.agingRenderState(stateAt(plugin, 5))!.opacity).toBe(
				Math.round((1 - 0.5 * (1 - floor)) * 1000) / 1000
			);
			expect(plugin.agingRenderState(stateAt(plugin, 10))!.opacity).toBe(floor);
			// Well past the horizon is still the floor, never below it: the card
			// is still on this board and still a hit target.
			expect(plugin.agingRenderState(stateAt(plugin, 90))!.opacity).toBe(floor);
		});

		it('keeps the render floor well above the model floor, so a live card stays readable', () => {
			const plugin = loadMain();
			expect(plugin.AGING_RENDER_OPACITY_FLOOR).toBeGreaterThan(plugin.AGING_OPACITY_FLOOR);
			// The model is free to say "as good as gone"; the renderer is not.
			expect(plugin.agingRenderState(stateAt(plugin, 10))!.opacity).toBeGreaterThanOrEqual(0.3);
		});

		it('counts down the days remaining and flags the last one', () => {
			const plugin = loadMain();
			const mid = plugin.agingRenderState(stateAt(plugin, 3))!;
			expect(mid.daysRemaining).toBe(7);
			expect(mid.horizonDays).toBe(10);
			expect(mid.expiringSoon).toBe(false);
			expect(mid.expired).toBe(false);

			// Exactly AGING_SOON_DAYS left: the marker arms on the boundary
			// rather than a tick after it.
			const edge = plugin.agingRenderState(stateAt(plugin, 10 - plugin.AGING_SOON_DAYS))!;
			expect(edge.daysRemaining).toBe(plugin.AGING_SOON_DAYS);
			expect(edge.expiringSoon).toBe(true);
			expect(edge.expired).toBe(false);
		});

		it('keeps warning about a card the sweep has not reached yet', () => {
			const plugin = loadMain();
			// The sweep runs on hours, so a card can be past its horizon and
			// still on screen. That is the most urgent version of "about to go",
			// so the countdown bottoms out at zero and the flag stays up.
			const over = plugin.agingRenderState(stateAt(plugin, 40))!;
			expect(over.daysRemaining).toBe(0);
			expect(over.expiringSoon).toBe(true);
			expect(over.expired).toBe(true);
		});

		it('restores a full-strength card when a comment restarts the clock', () => {
			const plugin = loadMain();
			const render = plugin.agingRenderState(
				plugin.agingState(
					doneCard({ enteredDoneAt: NOW - 9 * DAY, lastCommentAt: NOW }),
					enabled,
					NOW
				)
			)!;
			expect(render.opacity).toBe(1);
			expect(render.daysRemaining).toBe(10);
			expect(render.expiringSoon).toBe(false);
		});
	});

	/** A board with one card that has been in Done for `daysInDone` days and a
	 * second card parked in Backlog, so a test can assert that only the Done
	 * one carries a decay. */
	function decayStub(plugin: KanbanAging, daysInDone: number, settings: Partial<AgingSettings>) {
		const boardPath = plugin.boardFilePath(projectPath);
		return createStubMaestro({
			storage: {
				'selected-board': projectPath,
				['placements:' + boardPath]: JSON.stringify({
					[key]: { columnId: 'done', order: 0, enteredDoneAt: Date.now() - daysInDone * DAY },
					'session-1::tab-2': { columnId: 'backlog', order: 0 },
				}),
				'board-settings': JSON.stringify({ [projectPath]: settings }),
			},
			sessionsList: () =>
				Promise.resolve([
					{ id: 'session-1', title: 'Widget Agent', agentId: 'claude-code', projectPath },
				]),
			tabsList: () =>
				Promise.resolve([
					aiTab({ projectPath, title: 'Ship the thing' }),
					aiTab({ id: 'tab-2', projectPath, title: 'Still Working' }),
				]),
		});
	}

	it('stamps the decay onto the Done card of a snapshot and onto no other card', async () => {
		const plugin = loadMain();
		const { maestro } = decayStub(plugin, 7, { agingEnabled: true, horizonDays: 14 });

		await plugin.activate(maestro);

		const cards = lastCardsByKey(maestro.ui.panelPost);
		const done = cards.get(key)!.aging!;
		expect(done.horizonDays).toBe(14);
		expect(done.daysRemaining).toBeCloseTo(7, 1);
		expect(done.opacity).toBeGreaterThan(plugin.AGING_RENDER_OPACITY_FLOOR);
		expect(done.opacity).toBeLessThan(1);
		// The Backlog card has no clock, so it has no field - which is what the
		// panel reads as "draw this one at full strength".
		expect(cards.get('session-1::tab-2')!.aging).toBeUndefined();
	});

	it('sends no decay at all while aging is off, however old the card is', async () => {
		const plugin = loadMain();
		const { maestro } = decayStub(plugin, 400, { agingEnabled: false, horizonDays: 14 });

		await plugin.activate(maestro);

		const cards = lastCardsByKey(maestro.ui.panelPost);
		// Still on the board (aging off never retires), and still drawn exactly
		// as Phase 04 drew it.
		expect(cards.get(key)!.aging).toBeUndefined();
	});

	it('repaints the opacities in the same push that saves a new horizon', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = decayStub(plugin, 7, {
			agingEnabled: true,
			horizonDays: 28,
		});
		await plugin.activate(maestro);
		const before = lastCardsByKey(maestro.ui.panelPost).get(key)!.aging!;

		await commandHandlers.get('board-settings')!({ boardId: projectPath, horizonDays: 14 });

		// Same card, same age, half the horizon: twice as far along the ramp, so
		// visibly fainter in the very push that stored the number. This is what
		// "re-render immediately when the horizon changes" means on screen.
		const after = lastCardsByKey(maestro.ui.panelPost).get(key)!.aging!;
		expect(after.horizonDays).toBe(14);
		expect(after.opacity).toBeLessThan(before.opacity);
		expect(after.daysRemaining).toBeLessThan(before.daysRemaining);
	});

	it('marks a card the next sweep will retire as expired rather than hiding it', async () => {
		const plugin = loadMain();
		// Aging on, 14-day horizon, 20 days in Done - and the sweep cannot
		// retire it (its archive file does not parse, see below), so it is still
		// on the board with its horizon behind it. A card in that state with
		// nothing on screen about it is exactly what the fade alone cannot say.
		const boardPath = plugin.boardFilePath(projectPath);
		const { maestro } = createStubMaestro({
			storage: {
				'selected-board': projectPath,
				['placements:' + boardPath]: JSON.stringify({
					[key]: { columnId: 'done', order: 0, enteredDoneAt: Date.now() - 20 * DAY },
				}),
				'board-settings': JSON.stringify({
					[projectPath]: { agingEnabled: true, horizonDays: 14, closeTabsOnRetire: false },
				}),
			},
			sessionsList: () =>
				Promise.resolve([
					{ id: 'session-1', title: 'Widget Agent', agentId: 'claude-code', projectPath },
				]),
			tabsList: () => Promise.resolve([aiTab({ projectPath, title: 'Ship the thing' })]),
			files: {
				// An unparseable archive file, which retirement refuses to
				// overwrite (see saveArchive). So the sweep cannot retire this
				// card and it stays on the board with its clock already run out -
				// the state the decay has to be able to express.
				[plugin.archiveFilePath(projectPath)]: '{ not json',
			},
		});

		await plugin.activate(maestro);

		const card = lastCardsByKey(maestro.ui.panelPost).get(key);
		expect(card).toBeDefined();
		const aging = card!.aging!;
		expect(aging.expired).toBe(true);
		expect(aging.expiringSoon).toBe(true);
		expect(aging.daysRemaining).toBe(0);
		expect(aging.opacity).toBe(plugin.AGING_RENDER_OPACITY_FLOOR);
	});
});
