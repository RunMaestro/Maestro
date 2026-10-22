/**
 * @file kanban-board-model.test.ts
 * @description Tests for the Phase 02 pure column model inside
 * `examples/plugins/maestro-kanban/main.js`: `parseBoardYaml`,
 * `serializeBoardYaml`, `DEFAULT_COLUMNS`, `projectBoardSlug`,
 * `resolveColumns`, `legalColumnsFor`, and `resolveTerminalColumn`. These are
 * plain exports with no host calls, so this suite loads `main.js` directly
 * via `createRequire`, the same way `kanban-main.test.ts` does, and calls the
 * functions straight through without a stub `maestro` SDK.
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

interface KanbanBoardModel {
	parseBoardYaml: (text: string, options?: { expectProject?: boolean }) => Board;
	serializeBoardYaml: (board: Board) => string;
	DEFAULT_COLUMNS: BoardColumn[];
	projectBoardSlug: (projectPath: string) => string;
	resolveColumns: (
		projectBoard: Board | null | undefined,
		globalBoard: Board | null | undefined
	) => Array<{
		id: string;
		title: string;
		terminal: boolean;
		wip_limit?: number;
		maps_to?: string;
		globalColumn: BoardColumn | null;
	}>;
	legalColumnsFor: (
		card: { columnId?: string } | null | undefined,
		projectBoard: Board | null | undefined,
		globalBoard: Board | null | undefined
	) => string[];
	resolveTerminalColumn: (columns: BoardColumn[]) => BoardColumn | null;
}

/** Fresh module state per test: mirrors `kanban-main.test.ts`'s `loadMain()`.
 * These functions are pure, but reloading keeps this suite independent of
 * load order relative to other suites that require the same path. */
function loadMain(): KanbanBoardModel {
	delete require.cache[mainPath];
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require(mainPath) as KanbanBoardModel;
}

const PROJECT_BOARD_TEXT =
	'version: 1\n' +
	'project: /Users/example/code/my-app\n' +
	'columns:\n' +
	'  - id: backlog\n' +
	'    title: Backlog\n' +
	'    maps_to: backlog\n' +
	'  - id: spiking\n' +
	'    title: Spiking\n' +
	'    maps_to: in-progress\n' +
	'  - id: done\n' +
	'    title: Done\n' +
	'    terminal: true\n';

const GLOBAL_BOARD_TEXT =
	'version: 1\n' +
	'columns:\n' +
	'  - id: backlog\n' +
	'    title: Backlog\n' +
	'  - id: in-progress\n' +
	'    title: In Progress\n' +
	'  - id: done\n' +
	'    title: Done\n' +
	'    terminal: true\n' +
	'    wip_limit: 5\n';

describe('maestro-kanban main.js: Phase 02 column model', () => {
	describe('parseBoardYaml / serializeBoardYaml round trips', () => {
		it('round-trips a representative project board', () => {
			const { parseBoardYaml, serializeBoardYaml } = loadMain();
			const board = parseBoardYaml(PROJECT_BOARD_TEXT, { expectProject: true });
			expect(board).toEqual({
				version: 1,
				project: '/Users/example/code/my-app',
				columns: [
					{ id: 'backlog', title: 'Backlog', maps_to: 'backlog' },
					{ id: 'spiking', title: 'Spiking', maps_to: 'in-progress' },
					{ id: 'done', title: 'Done', terminal: true },
				],
			});
			const serialized = serializeBoardYaml(board);
			const reparsed = parseBoardYaml(serialized, { expectProject: true });
			expect(reparsed).toEqual(board);
		});

		it('round-trips a representative global board, including wip_limit', () => {
			const { parseBoardYaml, serializeBoardYaml } = loadMain();
			const board = parseBoardYaml(GLOBAL_BOARD_TEXT, { expectProject: false });
			expect(board).toEqual({
				version: 1,
				columns: [
					{ id: 'backlog', title: 'Backlog' },
					{ id: 'in-progress', title: 'In Progress' },
					{ id: 'done', title: 'Done', terminal: true, wip_limit: 5 },
				],
			});
			const serialized = serializeBoardYaml(board);
			const reparsed = parseBoardYaml(serialized, { expectProject: false });
			expect(reparsed).toEqual(board);
		});
	});

	describe('parseBoardYaml rejection rules', () => {
		it('rejects an unknown top-level key', () => {
			const { parseBoardYaml } = loadMain();
			const text = 'version: 1\nfoo: bar\ncolumns:\n  - id: backlog\n    title: Backlog\n';
			expect(() => parseBoardYaml(text)).toThrow("Unknown top-level key 'foo' (line 2)");
		});

		it('rejects a duplicate column id', () => {
			const { parseBoardYaml } = loadMain();
			const text =
				'version: 1\n' +
				'columns:\n' +
				'  - id: backlog\n' +
				'    title: Backlog\n' +
				'  - id: backlog\n' +
				'    title: Backlog Again\n';
			expect(() => parseBoardYaml(text)).toThrow("Duplicate column id 'backlog' (line 5)");
		});

		it('rejects a missing version', () => {
			const { parseBoardYaml } = loadMain();
			const text = 'columns:\n  - id: backlog\n    title: Backlog\n';
			expect(() => parseBoardYaml(text)).toThrow('version is required');
		});

		it('rejects a non-integer version', () => {
			const { parseBoardYaml } = loadMain();
			const text = 'version: abc\ncolumns:\n  - id: backlog\n    title: Backlog\n';
			expect(() => parseBoardYaml(text)).toThrow('version must be an integer (line 1)');
		});

		it('rejects a column with no id', () => {
			const { parseBoardYaml } = loadMain();
			const text = 'version: 1\ncolumns:\n  - title: Backlog\n';
			expect(() => parseBoardYaml(text)).toThrow("Column is missing required 'id' (line 3)");
		});

		it('rejects a column with no title', () => {
			const { parseBoardYaml } = loadMain();
			const text = 'version: 1\ncolumns:\n  - id: backlog\n';
			expect(() => parseBoardYaml(text)).toThrow("Column is missing required 'title' (line 3)");
		});

		it('rejects a missing project on a project file', () => {
			const { parseBoardYaml } = loadMain();
			const text = 'version: 1\ncolumns:\n  - id: backlog\n    title: Backlog\n';
			expect(() => parseBoardYaml(text, { expectProject: true })).toThrow(
				'project is required on a project board'
			);
		});

		it('rejects a project key on the global file', () => {
			const { parseBoardYaml } = loadMain();
			const text =
				'version: 1\nproject: /Users/example/code/my-app\ncolumns:\n  - id: backlog\n    title: Backlog\n';
			expect(() => parseBoardYaml(text, { expectProject: false })).toThrow(
				'project is not allowed on the global board'
			);
		});

		it('rejects a tab-indented list rather than half-parsing it', () => {
			const { parseBoardYaml } = loadMain();
			const text = 'version: 1\ncolumns:\n\t- id: backlog\n    title: Backlog\n';
			expect(() => parseBoardYaml(text)).toThrow('Tab indentation is not supported (line 3)');
		});

		it('rejects a nested map rather than half-parsing it', () => {
			const { parseBoardYaml } = loadMain();
			const text =
				'version: 1\n' +
				'columns:\n' +
				'  - id: backlog\n' +
				'    title: Backlog\n' +
				'    maps_to:\n' +
				'      sub: value\n';
			expect(() => parseBoardYaml(text)).toThrow('Nested maps are not supported (line 6)');
		});

		it('rejects an anchor rather than half-parsing it', () => {
			const { parseBoardYaml } = loadMain();
			const text = 'version: 1\ncolumns:\n  - id: backlog\n    title: &anchor Backlog\n';
			expect(() => parseBoardYaml(text)).toThrow('Anchors and aliases are not supported (line 4)');
		});
	});

	describe('projectBoardSlug', () => {
		it('is stable for the same path', () => {
			const { projectBoardSlug } = loadMain();
			const path = '/Users/example/code/my-app';
			expect(projectBoardSlug(path)).toBe(projectBoardSlug(path));
		});

		it('differs for two projects sharing a basename', () => {
			const { projectBoardSlug } = loadMain();
			const slugA = projectBoardSlug('/Users/example/code-a/my-app');
			const slugB = projectBoardSlug('/Users/example/code-b/my-app');
			expect(slugA).not.toBe(slugB);
			expect(slugA.startsWith('my-app-')).toBe(true);
			expect(slugB.startsWith('my-app-')).toBe(true);
		});

		it('only emits [a-z0-9-] regardless of the input path', () => {
			const { projectBoardSlug } = loadMain();
			const slug = projectBoardSlug('/Users/Example/My App_2!');
			expect(slug).toMatch(/^[a-z0-9-]+$/);
			expect(slug).toMatch(/^my-app-2-[0-9a-f]{8}$/);
		});
	});

	describe('resolveColumns', () => {
		it("uses a project board's own columns and maps each to its global column", () => {
			const { parseBoardYaml, resolveColumns } = loadMain();
			const projectBoard = parseBoardYaml(PROJECT_BOARD_TEXT, { expectProject: true });
			const globalBoard = parseBoardYaml(GLOBAL_BOARD_TEXT, { expectProject: false });
			const resolved = resolveColumns(projectBoard, globalBoard);
			expect(resolved.map((c) => c.id)).toEqual(['backlog', 'spiking', 'done']);
			expect(resolved[0].globalColumn).toEqual({ id: 'backlog', title: 'Backlog' });
			expect(resolved[1].globalColumn).toEqual({ id: 'in-progress', title: 'In Progress' });
		});

		it('falls back to DEFAULT_COLUMNS when there is no project board', () => {
			const { DEFAULT_COLUMNS, resolveColumns } = loadMain();
			const resolved = resolveColumns(null, null);
			expect(resolved.map((c) => c.id)).toEqual(DEFAULT_COLUMNS.map((c) => c.id));
		});

		it('resolves an orphaned maps_to to null instead of throwing', () => {
			const { resolveColumns } = loadMain();
			const projectBoard: Board = {
				version: 1,
				project: '/x',
				columns: [{ id: 'a', title: 'A', maps_to: 'does-not-exist' }],
			};
			const globalBoard: Board = {
				version: 1,
				columns: [{ id: 'backlog', title: 'Backlog' }],
			};
			const resolved = resolveColumns(projectBoard, globalBoard);
			expect(resolved).toEqual([
				{
					id: 'a',
					title: 'A',
					terminal: false,
					maps_to: 'does-not-exist',
					wip_limit: undefined,
					globalColumn: null,
				},
			]);
		});
	});

	describe('legalColumnsFor', () => {
		it("on a project board, is the project's own resolved column ids", () => {
			const { parseBoardYaml, legalColumnsFor } = loadMain();
			const projectBoard = parseBoardYaml(PROJECT_BOARD_TEXT, { expectProject: true });
			const globalBoard = parseBoardYaml(GLOBAL_BOARD_TEXT, { expectProject: false });
			expect(legalColumnsFor({ columnId: 'spiking' }, projectBoard, globalBoard)).toEqual([
				'backlog',
				'spiking',
				'done',
			]);
			expect(legalColumnsFor(null, projectBoard, globalBoard)).toEqual([
				'backlog',
				'spiking',
				'done',
			]);
		});
	});

	describe('resolveTerminalColumn', () => {
		it('picks the column marked terminal: true', () => {
			const { resolveTerminalColumn } = loadMain();
			const columns: BoardColumn[] = [
				{ id: 'a', title: 'A' },
				{ id: 'b', title: 'B', terminal: true },
			];
			expect(resolveTerminalColumn(columns)).toEqual({ id: 'b', title: 'B', terminal: true });
		});

		it('falls back to a column whose id is done when none is marked terminal', () => {
			const { resolveTerminalColumn } = loadMain();
			const columns: BoardColumn[] = [
				{ id: 'a', title: 'A' },
				{ id: 'done', title: 'Done' },
			];
			expect(resolveTerminalColumn(columns)).toEqual({ id: 'done', title: 'Done' });
		});

		it('falls back to the last column when there is no terminal flag and no done id', () => {
			const { resolveTerminalColumn } = loadMain();
			const columns: BoardColumn[] = [
				{ id: 'a', title: 'A' },
				{ id: 'z', title: 'Z' },
			];
			expect(resolveTerminalColumn(columns)).toEqual({ id: 'z', title: 'Z' });
		});

		it('returns null for an empty column list', () => {
			const { resolveTerminalColumn } = loadMain();
			expect(resolveTerminalColumn([])).toBeNull();
		});
	});
});
