/**
 * @file kanban-global-board.test.ts
 * @description Tests for the Phase 03 pure global board aggregation inside
 * `examples/plugins/maestro-kanban/main.js`: `buildGlobalBoard`,
 * `globalColumnForCard`, `legalGlobalColumnsFor`,
 * `projectColumnForGlobalColumn`, and the shared `compareCardsByOrder`
 * ordering rule. Like `kanban-board-model.test.ts`, these are plain exports
 * with no host calls, so this suite loads `main.js` directly via
 * `createRequire` and calls them without a stub `maestro` SDK.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mainPath = require.resolve('../../../examples/plugins/maestro-kanban/main.js');

interface BoardColumn {
	id: string;
	title: string;
	maps_to?: string;
	terminal?: boolean;
	wip_limit?: number;
}

interface Board {
	version: number;
	project?: string;
	columns: BoardColumn[];
}

interface TestCard {
	key: string;
	projectPath?: string;
	columnId?: string;
	order?: number | null;
	createdAt: number;
	lastActivityAt: number;
}

interface GlobalColumn {
	id: string;
	title: string;
	terminal: boolean;
	wip_limit?: number;
	readOnly: boolean;
	cards: TestCard[];
}

interface KanbanGlobalBoardModel {
	parseBoardYaml: (text: string, options?: { expectProject?: boolean }) => Board;
	serializeBoardYaml: (board: Board) => string;
	UNMAPPED_COLUMN_ID: string;
	UNMAPPED_COLUMN_TITLE: string;
	buildGlobalBoard: (
		globalBoard: Board | null | undefined,
		projectBoards: Map<string, Board | null> | Record<string, unknown> | null | undefined,
		cards: Iterable<TestCard>,
		options?: { orderOf?: (card: TestCard) => number | null }
	) => { columns: GlobalColumn[]; unmappedColumnId: string };
	globalColumnForCard: (
		card: { columnId?: string } | null | undefined,
		projectBoard: Board | null | undefined,
		globalBoard: Board | null | undefined
	) => string | null;
	legalColumnsFor: (
		card: { columnId?: string } | null | undefined,
		projectBoard: Board | null | undefined,
		globalBoard: Board | null | undefined,
		options?: { global?: boolean }
	) => string[];
	legalGlobalColumnsFor: (
		card: { columnId?: string } | null | undefined,
		projectBoard: Board | null | undefined,
		globalBoard: Board | null | undefined
	) => string[];
	projectColumnForGlobalColumn: (
		card: { columnId?: string } | null | undefined,
		projectBoard: Board | null | undefined,
		globalBoard: Board | null | undefined,
		globalColumnId: unknown
	) => { columnId: string; ambiguous: boolean; candidates: string[] } | null;
	compareCardsByOrder: (
		a: TestCard,
		b: TestCard,
		orderOf: (card: TestCard) => number | null
	) => number;
	declaredCardOrder: (card: { order?: unknown }) => number | null;
}

/** Fresh module state per test, mirroring `kanban-board-model.test.ts`. */
function loadMain(): KanbanGlobalBoardModel {
	delete require.cache[mainPath];
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require(mainPath) as KanbanGlobalBoardModel;
}

const GLOBAL_BOARD: Board = {
	version: 1,
	columns: [
		{ id: 'backlog', title: 'Backlog' },
		{ id: 'in-progress', title: 'In Progress', wip_limit: 3 },
		{ id: 'done', title: 'Done', terminal: true },
	],
};

/** Every column mapped, one global column reached by two project columns. */
const APP_BOARD: Board = {
	version: 1,
	project: '/code/app',
	columns: [
		{ id: 'todo', title: 'Todo', maps_to: 'backlog' },
		{ id: 'spiking', title: 'Spiking', maps_to: 'in-progress' },
		{ id: 'building', title: 'Building', maps_to: 'in-progress' },
		{ id: 'shipped', title: 'Shipped', maps_to: 'done', terminal: true },
	],
};

/** One mapped column and one deliberately unmapped one. */
const SITE_BOARD: Board = {
	version: 1,
	project: '/code/site',
	columns: [
		{ id: 'queue', title: 'Queue', maps_to: 'backlog' },
		{ id: 'notes', title: 'Notes' },
		{ id: 'orphan', title: 'Orphan', maps_to: 'nowhere' },
	],
};

function card(overrides: Partial<TestCard> & { key: string }): TestCard {
	return {
		projectPath: '/code/app',
		columnId: 'todo',
		createdAt: 1_000,
		lastActivityAt: 1_000,
		...overrides,
	};
}

function idsIn(result: { columns: GlobalColumn[] }, columnId: string): string[] {
	const column = result.columns.find((c) => c.id === columnId);
	return (column ? column.cards : []).map((c) => c.key);
}

describe('maestro-kanban main.js: Phase 03 global board aggregation', () => {
	describe('buildGlobalBoard placement', () => {
		it('places each card in the global column its home project column maps to', () => {
			const { buildGlobalBoard } = loadMain();
			const result = buildGlobalBoard(
				GLOBAL_BOARD,
				new Map([
					['/code/app', APP_BOARD],
					['/code/site', SITE_BOARD],
				]),
				[
					card({ key: 'a', columnId: 'todo' }),
					card({ key: 'b', columnId: 'building' }),
					card({ key: 'c', columnId: 'shipped' }),
					card({ key: 'd', projectPath: '/code/site', columnId: 'queue' }),
				]
			);
			expect(result.columns.map((c) => c.id)).toEqual(['backlog', 'in-progress', 'done']);
			expect(idsIn(result, 'backlog')).toEqual(['a', 'd']);
			expect(idsIn(result, 'in-progress')).toEqual(['b']);
			expect(idsIn(result, 'done')).toEqual(['c']);
		});

		it('carries each global column title, terminal flag, and wip_limit through', () => {
			const { buildGlobalBoard } = loadMain();
			const result = buildGlobalBoard(GLOBAL_BOARD, new Map([['/code/app', APP_BOARD]]), []);
			expect(result.columns).toEqual([
				{
					id: 'backlog',
					title: 'Backlog',
					terminal: false,
					wip_limit: undefined,
					readOnly: false,
					cards: [],
				},
				{
					id: 'in-progress',
					title: 'In Progress',
					terminal: false,
					wip_limit: 3,
					readOnly: false,
					cards: [],
				},
				{
					id: 'done',
					title: 'Done',
					terminal: true,
					wip_limit: undefined,
					readOnly: false,
					cards: [],
				},
			]);
		});

		it('collects unmapped, orphaned, and project-less cards in a read-only Unmapped lane', () => {
			const { buildGlobalBoard, UNMAPPED_COLUMN_ID, UNMAPPED_COLUMN_TITLE } = loadMain();
			const result = buildGlobalBoard(
				GLOBAL_BOARD,
				new Map([
					['/code/app', APP_BOARD],
					['/code/site', SITE_BOARD],
				]),
				[
					card({ key: 'mapped', columnId: 'todo' }),
					// No maps_to at all.
					card({ key: 'unmapped', projectPath: '/code/site', columnId: 'notes' }),
					// maps_to names a column the global board does not have.
					card({ key: 'orphan', projectPath: '/code/site', columnId: 'orphan' }),
					// Project has no board file at all.
					card({ key: 'boardless', projectPath: '/code/other', columnId: 'backlog' }),
					// Agent has no project folder at all.
					card({ key: 'homeless', projectPath: undefined, columnId: 'backlog' }),
				]
			);
			const lane = result.columns[result.columns.length - 1];
			expect(lane.id).toBe(UNMAPPED_COLUMN_ID);
			expect(lane.title).toBe(UNMAPPED_COLUMN_TITLE);
			expect(lane.readOnly).toBe(true);
			expect(lane.cards.map((c) => c.key).sort()).toEqual([
				'boardless',
				'homeless',
				'orphan',
				'unmapped',
			]);
			expect(idsIn(result, 'backlog')).toEqual(['mapped']);
			expect(result.unmappedColumnId).toBe(UNMAPPED_COLUMN_ID);
		});

		it('omits the Unmapped lane entirely when every card is placed', () => {
			const { buildGlobalBoard, UNMAPPED_COLUMN_ID } = loadMain();
			const result = buildGlobalBoard(GLOBAL_BOARD, new Map([['/code/app', APP_BOARD]]), [
				card({ key: 'a', columnId: 'todo' }),
			]);
			expect(result.columns.map((c) => c.id)).not.toContain(UNMAPPED_COLUMN_ID);
		});

		it('sends a card whose stored column its project no longer declares to the lane', () => {
			const { buildGlobalBoard, UNMAPPED_COLUMN_ID } = loadMain();
			const result = buildGlobalBoard(GLOBAL_BOARD, new Map([['/code/app', APP_BOARD]]), [
				card({ key: 'stale', columnId: 'deleted-column' }),
			]);
			expect(idsIn(result, UNMAPPED_COLUMN_ID)).toEqual(['stale']);
		});

		it('does not map a project column by id alone when it has no maps_to', () => {
			const { buildGlobalBoard, UNMAPPED_COLUMN_ID } = loadMain();
			const sameIds: Board = {
				version: 1,
				project: '/code/plain',
				columns: [{ id: 'backlog', title: 'Backlog' }],
			};
			const result = buildGlobalBoard(GLOBAL_BOARD, new Map([['/code/plain', sameIds]]), [
				card({ key: 'a', projectPath: '/code/plain', columnId: 'backlog' }),
			]);
			expect(idsIn(result, 'backlog')).toEqual([]);
			expect(idsIn(result, UNMAPPED_COLUMN_ID)).toEqual(['a']);
		});

		it('yields the reserved lane id to a global column that declares it', () => {
			const { buildGlobalBoard, UNMAPPED_COLUMN_ID } = loadMain();
			const collidingGlobal: Board = {
				version: 1,
				columns: [
					{ id: UNMAPPED_COLUMN_ID, title: 'Mine' },
					{ id: 'backlog', title: 'Backlog' },
				],
			};
			const result = buildGlobalBoard(collidingGlobal, new Map([['/code/app', APP_BOARD]]), [
				card({ key: 'unplaceable', projectPath: '/code/nowhere', columnId: 'x' }),
			]);
			const ids = result.columns.map((c) => c.id);
			expect(ids).toEqual([UNMAPPED_COLUMN_ID, 'backlog']);
			expect(idsIn(result, UNMAPPED_COLUMN_ID)).toEqual(['unplaceable']);
			expect(result.columns[0].readOnly).toBe(false);
		});

		it('accepts loadProjectBoard-shaped { board, error } entries and plain objects', () => {
			const { buildGlobalBoard } = loadMain();
			const result = buildGlobalBoard(
				GLOBAL_BOARD,
				{
					'/code/app': { board: APP_BOARD, error: null },
					'/code/site': { board: null, error: { message: 'broken', path: 'x' } },
				},
				[
					card({ key: 'a', columnId: 'todo' }),
					card({ key: 'b', projectPath: '/code/site', columnId: 'queue' }),
				]
			);
			expect(idsIn(result, 'backlog')).toEqual(['a']);
			expect(idsIn(result, '__unmapped__')).toEqual(['b']);
		});

		it('puts every card in the lane when there is no global board at all', () => {
			const { buildGlobalBoard, UNMAPPED_COLUMN_ID } = loadMain();
			const result = buildGlobalBoard(null, new Map([['/code/app', APP_BOARD]]), [
				card({ key: 'a', columnId: 'todo' }),
			]);
			expect(result.columns.map((c) => c.id)).toEqual([UNMAPPED_COLUMN_ID]);
			expect(idsIn(result, UNMAPPED_COLUMN_ID)).toEqual(['a']);
		});
	});

	describe('globalColumnForCard', () => {
		it('returns the mapped global column id', () => {
			const { globalColumnForCard } = loadMain();
			expect(globalColumnForCard({ columnId: 'spiking' }, APP_BOARD, GLOBAL_BOARD)).toBe(
				'in-progress'
			);
		});

		it('returns null for an unmapped column, a missing board, and a missing column', () => {
			const { globalColumnForCard } = loadMain();
			expect(globalColumnForCard({ columnId: 'notes' }, SITE_BOARD, GLOBAL_BOARD)).toBeNull();
			expect(globalColumnForCard({ columnId: 'todo' }, null, GLOBAL_BOARD)).toBeNull();
			expect(globalColumnForCard({}, APP_BOARD, GLOBAL_BOARD)).toBeNull();
		});
	});

	describe('legalColumnsFor on the global board', () => {
		it('returns only the global columns the home project can reach', () => {
			const { legalColumnsFor } = loadMain();
			expect(
				legalColumnsFor({ columnId: 'queue' }, SITE_BOARD, GLOBAL_BOARD, { global: true })
			).toEqual(['backlog']);
			expect(
				legalColumnsFor({ columnId: 'todo' }, APP_BOARD, GLOBAL_BOARD, { global: true })
			).toEqual(['backlog', 'in-progress', 'done']);
		});

		it('dedupes two project columns pointing at one global column', () => {
			const { legalGlobalColumnsFor } = loadMain();
			const ids = legalGlobalColumnsFor({ columnId: 'spiking' }, APP_BOARD, GLOBAL_BOARD);
			expect(ids.filter((id) => id === 'in-progress')).toHaveLength(1);
		});

		it('returns them in the global board order, not the project order', () => {
			const { legalGlobalColumnsFor } = loadMain();
			const reversed: Board = {
				version: 1,
				project: '/code/rev',
				columns: [
					{ id: 'z', title: 'Z', maps_to: 'done' },
					{ id: 'a', title: 'A', maps_to: 'backlog' },
				],
			};
			expect(legalGlobalColumnsFor({ columnId: 'z' }, reversed, GLOBAL_BOARD)).toEqual([
				'backlog',
				'done',
			]);
		});

		it('offers nothing to a card whose project has no board', () => {
			const { legalGlobalColumnsFor } = loadMain();
			expect(legalGlobalColumnsFor({ columnId: 'backlog' }, null, GLOBAL_BOARD)).toEqual([]);
		});

		it('leaves the project-board behavior of legalColumnsFor untouched', () => {
			const { legalColumnsFor } = loadMain();
			expect(legalColumnsFor({ columnId: 'todo' }, APP_BOARD, GLOBAL_BOARD)).toEqual([
				'todo',
				'spiking',
				'building',
				'shipped',
			]);
		});
	});

	describe('projectColumnForGlobalColumn write-back', () => {
		it('picks the single project column that maps to the target', () => {
			const { projectColumnForGlobalColumn } = loadMain();
			expect(
				projectColumnForGlobalColumn({ columnId: 'todo' }, APP_BOARD, GLOBAL_BOARD, 'done')
			).toEqual({ columnId: 'shipped', ambiguous: false, candidates: ['shipped'] });
		});

		it("keeps the card's current column when it already maps to the target", () => {
			const { projectColumnForGlobalColumn } = loadMain();
			expect(
				projectColumnForGlobalColumn(
					{ columnId: 'building' },
					APP_BOARD,
					GLOBAL_BOARD,
					'in-progress'
				)
			).toEqual({
				columnId: 'building',
				ambiguous: true,
				candidates: ['spiking', 'building'],
			});
		});

		it('takes the first mapping and flags the ambiguity when the card is elsewhere', () => {
			const { projectColumnForGlobalColumn } = loadMain();
			expect(
				projectColumnForGlobalColumn({ columnId: 'todo' }, APP_BOARD, GLOBAL_BOARD, 'in-progress')
			).toEqual({
				columnId: 'spiking',
				ambiguous: true,
				candidates: ['spiking', 'building'],
			});
		});

		it('returns null when the project cannot reach the target at all', () => {
			const { projectColumnForGlobalColumn } = loadMain();
			expect(
				projectColumnForGlobalColumn({ columnId: 'queue' }, SITE_BOARD, GLOBAL_BOARD, 'done')
			).toBeNull();
			expect(
				projectColumnForGlobalColumn({ columnId: 'todo' }, null, GLOBAL_BOARD, 'done')
			).toBeNull();
			expect(
				projectColumnForGlobalColumn({ columnId: 'todo' }, APP_BOARD, GLOBAL_BOARD, '')
			).toBeNull();
		});
	});

	describe('ordering within a global column', () => {
		it('sorts never-positioned cards by last activity, newest first', () => {
			const { buildGlobalBoard } = loadMain();
			const result = buildGlobalBoard(GLOBAL_BOARD, new Map([['/code/app', APP_BOARD]]), [
				card({ key: 'old', columnId: 'todo', lastActivityAt: 10 }),
				card({ key: 'new', columnId: 'todo', lastActivityAt: 90 }),
				card({ key: 'mid', columnId: 'todo', lastActivityAt: 50 }),
			]);
			expect(idsIn(result, 'backlog')).toEqual(['new', 'mid', 'old']);
		});

		it('puts positioned cards below the unpositioned block, in their order', () => {
			const { buildGlobalBoard } = loadMain();
			const result = buildGlobalBoard(GLOBAL_BOARD, new Map([['/code/app', APP_BOARD]]), [
				card({ key: 'second', columnId: 'todo', order: 1, lastActivityAt: 99 }),
				card({ key: 'fresh', columnId: 'todo', lastActivityAt: 5 }),
				card({ key: 'first', columnId: 'todo', order: 0, lastActivityAt: 1 }),
			]);
			expect(idsIn(result, 'backlog')).toEqual(['fresh', 'first', 'second']);
		});

		it('breaks a cross-project order collision deterministically', () => {
			const { buildGlobalBoard } = loadMain();
			const cards = [
				card({ key: 'app-0', columnId: 'todo', order: 0, lastActivityAt: 7 }),
				card({ key: 'site-0', projectPath: '/code/site', columnId: 'queue', order: 0 }),
			];
			const boards = new Map([
				['/code/app', APP_BOARD],
				['/code/site', SITE_BOARD],
			]);
			const forwards = buildGlobalBoard(GLOBAL_BOARD, boards, cards);
			const backwards = buildGlobalBoard(GLOBAL_BOARD, boards, cards.slice().reverse());
			expect(idsIn(forwards, 'backlog')).toEqual(idsIn(backwards, 'backlog'));
		});

		it('survives a serialize and reload of the boards unchanged', () => {
			const { buildGlobalBoard, parseBoardYaml, serializeBoardYaml } = loadMain();
			const cards = [
				card({ key: 'a', columnId: 'todo', order: 1, lastActivityAt: 3 }),
				card({ key: 'b', columnId: 'todo', order: 0, lastActivityAt: 4 }),
				card({ key: 'c', columnId: 'spiking' }),
			];
			const boards = new Map([['/code/app', APP_BOARD]]);
			const before = buildGlobalBoard(GLOBAL_BOARD, boards, cards);
			const reloaded = new Map([
				['/code/app', parseBoardYaml(serializeBoardYaml(APP_BOARD), { expectProject: true })],
			]);
			const after = buildGlobalBoard(
				parseBoardYaml(serializeBoardYaml(GLOBAL_BOARD), { expectProject: false }),
				reloaded,
				cards
			);
			expect(after.columns.map((c) => c.id)).toEqual(before.columns.map((c) => c.id));
			expect(idsIn(after, 'backlog')).toEqual(['b', 'a']);
			expect(idsIn(after, 'in-progress')).toEqual(['c']);
		});

		it('honors an injected orderOf over the card-declared order', () => {
			const { buildGlobalBoard } = loadMain();
			const result = buildGlobalBoard(
				GLOBAL_BOARD,
				new Map([['/code/app', APP_BOARD]]),
				[
					card({ key: 'a', columnId: 'todo', order: 0 }),
					card({ key: 'b', columnId: 'todo', order: 1 }),
				],
				{ orderOf: (c) => (c.key === 'a' ? 1 : 0) }
			);
			expect(idsIn(result, 'backlog')).toEqual(['b', 'a']);
		});

		it('declaredCardOrder drops a non-finite order rather than trusting it', () => {
			const { declaredCardOrder } = loadMain();
			expect(declaredCardOrder({ order: 2 })).toBe(2);
			expect(declaredCardOrder({ order: Number.NaN })).toBeNull();
			expect(declaredCardOrder({ order: '3' })).toBeNull();
			expect(declaredCardOrder({})).toBeNull();
		});
	});
});
