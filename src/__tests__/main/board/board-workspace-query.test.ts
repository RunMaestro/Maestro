import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openBoardDb } from '../../../main/board/board-db';
import { applyBoardMigration, planBoardMigration } from '../../../main/board/board-migration';
import {
	BoardStorageFacade,
	configureBoardCaptureHost,
	configureBoardReadinessHost,
	configureBoardStorage,
	queryBoardWorkspace,
	updateCard,
} from '../../../main/board/board-storage';
import { BoardWorkspaceStorageError } from '../../../main/board/board-workspace-storage';

const transport = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock('electron', () => ({
	ipcMain: {
		handle: (key: string, handler: (...args: any[]) => any) => transport.set(key, handler),
	},
	ipcRenderer: {
		invoke: async (key: string, ...args: unknown[]) =>
			JSON.parse(JSON.stringify(await transport.get(key)!(null, ...args))),
	},
}));
vi.mock('../../../main/utils/ipcHandler', () => ({
	withIpcErrorLogging:
		(_: unknown, handler: (...args: any[]) => any) =>
		(_event: unknown, ...args: unknown[]) =>
			handler(...args),
}));
vi.mock('../../../main/stores/getters', () => ({ getLiveSessions: () => [] }));
vi.mock('../../../main/board/board-dispatcher', () => ({ applyCardCancel: vi.fn() }));
vi.mock('../../../main/board/board-pr', () => ({ startCardPr: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
import { registerBoardHandlers } from '../../../main/ipc/handlers/board';
import { createBoardApi } from '../../../main/preload/board';

let dir: string;
let db: ReturnType<typeof openBoardDb>;
let facade: BoardStorageFacade;
let roots: string[];
let sources: string[];
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-board-query-'));
	roots = ['a', 'b'].map((name) => {
		const root = path.join(dir, name);
		fs.mkdirSync(root);
		return root;
	});
	db = openBoardDb(path.join(dir, 'board.sqlite'));
	sources = roots.map((root) => {
		const plan = planBoardMigration({
			source: { location: { kind: 'local' }, path: fs.realpathSync(root) },
			repository: null,
			profileBytes: null,
			workers: [],
			boardBytes: Buffer.from(
				JSON.stringify({
					boards: [
						{
							id: 'same-board',
							name: 'Collection',
							cards: [
								{
									id: 'same-card',
									title: root,
									body: '',
									parents: [],
									status: 'todo',
									createdAt: '2026-10-31',
									updatedAt: '2026-10-31',
								},
							],
						},
					],
				})
			),
		});
		applyBoardMigration(db, plan);
		return plan.sourceKey;
	});
	facade = new BoardStorageFacade(db);
	configureBoardStorage(facade);
	registerBoardHandlers({ getCueEngine: () => null });
});
afterEach(() => {
	configureBoardStorage(null);
	configureBoardCaptureHost(() => ({ agents: [], groups: [] }));
	configureBoardReadinessHost(() => null);
	db.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('central Board query with real SQLite and preload/IPC transport', () => {
	it('reads a fresh workspace revision without hydrating collections', () => {
		const revision = facade.workspace.readWorkspace().revision;
		const reads = vi.spyOn(facade.workspace, 'readCollection');
		expect(facade.workspace.readRevision()).toBe(revision);
		db.prepare('UPDATE workspace SET revision = revision + 1 WHERE id = 1').run();
		expect(facade.workspace.readRevision()).toBe(revision + 1);
		expect(reads).not.toHaveBeenCalled();
	});

	it('reads host readiness once per workspace query and refreshes it on the next query', () => {
		const catalog = vi.fn(() => ({ agents: [], groups: [] }));
		const readiness = vi.fn(() => null);
		configureBoardCaptureHost(catalog);
		configureBoardReadinessHost(readiness);

		expect(facade.query().collections).toHaveLength(2);
		expect(catalog).toHaveBeenCalledTimes(1);
		expect(readiness).toHaveBeenCalledTimes(1);
		expect(facade.query().collections).toHaveLength(2);
		expect(catalog).toHaveBeenCalledTimes(2);
		expect(readiness).toHaveBeenCalledTimes(2);
	});

	it('hydrates only the requested source while retaining the full source catalog', () => {
		const reads = vi.spyOn(facade.workspace, 'readCollection');
		const filtered = facade.query({ sourceKey: sources[0] });
		expect(filtered.sources.map((entry) => entry.sourceKey).sort()).toEqual([...sources].sort());
		expect(filtered.collections).toHaveLength(1);
		expect(reads.mock.calls.every(([key]) => key.sourceKey === sources[0])).toBe(true);
	});

	it('fences colliding legacy cards to the displayed source, collection and revisions', async () => {
		const api = createBoardApi();
		const response = await api.queryWorkspace();
		if (!response.ok) throw new Error('query failed');
		const one = response.value.collections.find((entry) => entry.sourceKey === sources[0])!;
		const two = response.value.collections.find((entry) => entry.sourceKey === sources[1])!;
		const card = two.board.cards[0];
		const read = {
			sourceKey: two.sourceKey,
			collectionKey: two.collectionKey,
			revision: two.revision,
			cardRevision: card.storageRevision!,
		};
		await expect(
			api.setCardStatus(roots[1], 'same-board', 'same-card', 'blocked', {
				...read,
				collectionKey: one.collectionKey,
			})
		).rejects.toThrow(/identity changed/);
		await expect(
			api.setCardStatus(roots[1], 'same-board', 'same-card', 'blocked', {
				...read,
				cardRevision: read.cardRevision + 1,
			})
		).rejects.toThrow(/changed since read/);
		const changed = await api.setCardStatus(roots[1], 'same-board', 'same-card', 'blocked', read);
		expect(changed.cards[0].status).toBe('blocked');
		expect(facade.read(roots[0], 'same-board').cards[0].status).toBe('todo');
		await expect(api.deleteCard(roots[1], 'same-board', 'same-card', read)).rejects.toThrow(
			/changed since read/
		);
		const fresh = facade.read(roots[1], 'same-board');
		await api.deleteCard(roots[1], 'same-board', 'same-card', {
			sourceKey: two.sourceKey,
			collectionKey: two.collectionKey,
			revision: fresh.storage!.expectedRevision!,
			cardRevision: fresh.cards[0].storageRevision!,
		});
		expect(facade.read(roots[0], 'same-board').cards).toHaveLength(1);
		expect(facade.read(roots[1], 'same-board').cards).toHaveLength(0);
	});

	it('returns distinct identities for equal legacy IDs; filtered views retain writer revisions after reopen', async () => {
		const api = createBoardApi();
		const response = await api.queryWorkspace();
		expect(response.ok).toBe(true);
		if (!response.ok) throw new Error('query failed');
		const all = response.value;
		expect(all.collections).toHaveLength(2);
		expect(new Set(all.collections.map((entry) => entry.collectionKey)).size).toBe(2);
		expect(all.sources.map((entry) => entry.sourceKey).sort()).toEqual([...sources].sort());
		for (const [i, root] of roots.entries()) {
			const view = queryBoardWorkspace({ projectRoot: root });
			expect(view.collections).toEqual(
				all.collections.filter((entry) => entry.sourceKey === sources[i])
			);
			expect(view.collections).toEqual(
				queryBoardWorkspace({ projectRef: { sourceKey: sources[i] } }).collections
			);
			expect(view.collections).toEqual(queryBoardWorkspace({ sourceKey: sources[i] }).collections);
			expect(view.collections[0].board).toEqual(facade.read(root, 'same-board'));
		}
		const original = facade.read(roots[0], 'same-board');
		updateCard(roots[0], original.id, { ...original.cards[0], title: 'Edited centrally' });
		expect(() => facade.save(roots[0], [original])).toThrow(
			expect.objectContaining({ code: 'stale-revision' })
		);
		const changed = queryBoardWorkspace({ projectRoot: roots[0] }).collections[0];
		expect(changed.board.cards[0].title).toBe('Edited centrally');
		expect(changed.revision).toBeGreaterThan(original.storage!.expectedRevision!);
		expect(
			queryBoardWorkspace().collections.find(
				(entry) => entry.collectionKey === changed.collectionKey
			)
		).toEqual(changed);
		expect(facade.read(roots[1], 'same-board').cards[0].title).toBe(roots[1]);
		db.close();
		db = openBoardDb(path.join(dir, 'board.sqlite'));
		facade = new BoardStorageFacade(db);
		configureBoardStorage(facade);
		expect((await api.queryWorkspace()).ok).toBe(true);
		expect(queryBoardWorkspace({ sourceKey: sources[0] }).collections[0]).toEqual(changed);
	});
	it('preserves typed missing, ambiguous and malformed query failures over serialization', async () => {
		const api = createBoardApi();
		expect(await api.queryWorkspace({ sourceKey: 'unknown' })).toMatchObject({
			ok: false,
			error: { code: 'legacy-mapping-missing' },
		});
		expect(await api.queryWorkspace({ projectRoot: path.join(dir, 'missing') })).toMatchObject({
			ok: false,
			error: { code: 'legacy-mapping-missing' },
		});
		configureBoardStorage(new BoardStorageFacade(db, () => sources));
		expect(await api.queryWorkspace({ projectRoot: roots[0] })).toMatchObject({
			ok: false,
			error: { code: 'legacy-mapping-ambiguous' },
		});
		expect(await api.queryWorkspace({ projectRef: {} } as any)).toMatchObject({
			ok: false,
			error: { code: 'invalid-input' },
		});
		expect(await api.queryWorkspace({ projectRoot: 42 } as any)).toMatchObject({
			ok: false,
			error: { code: 'invalid-input' },
		});
		expect(await api.queryWorkspace({ projectRef: 'unknown' } as any)).toMatchObject({
			ok: false,
			error: { code: 'invalid-input' },
		});
		expect(
			queryBoardWorkspace({ sourceKey: sources[0], projectRef: { sourceKey: sources[1] } })
				.collections
		).toEqual([]);
		expect(() => facade.query({ sourceKey: 'unknown' })).toThrow(BoardWorkspaceStorageError);
	});
});

it('returns persisted source locations after all source sessions disappear', async () => {
	const first = await createBoardApi().queryWorkspace();
	expect(first.ok).toBe(true);
	if (!first.ok) throw new Error(first.error.message);
	expect(first.value.sources.map((source) => source.location?.path).sort()).toEqual(
		[...roots].sort()
	);
	db.close();
	db = openBoardDb(path.join(dir, 'board.sqlite'));
	configureBoardStorage(new BoardStorageFacade(db));
	expect(await createBoardApi().queryWorkspace()).toEqual(first);
});
