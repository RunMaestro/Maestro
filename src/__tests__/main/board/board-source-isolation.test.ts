import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardRemoteTransport } from '../../../main/board/board-remote-source';
import type { BoardStorageFacade } from '../../../main/board/board-storage';

const fixture = vi.hoisted(() => ({
	registries: {
		sessions: [] as Array<{ id: string; dir?: string; sshRemoteId?: string }>,
		sources: [] as Array<{ id: string; root: string }>,
	},
	storage: vi.fn(),
}));
vi.mock('../../../main/board/board-isolation', () => ({
	isBoardIsolationRequested: () => true,
	requireBoardIsolation: () => ({}),
	readBoardIsolationRegistries: () => fixture.registries,
	assertBoardIsolationPath: vi.fn(),
}));
vi.mock('../../../main/board/board-storage', () => ({
	getBoardStorage: fixture.storage,
	BoardStorageError: class extends Error {},
}));

const transport = (): BoardRemoteTransport =>
	({
		config: vi.fn(),
		read: vi.fn(),
		git: vi.fn(),
		shell: vi.fn(),
	}) as unknown as BoardRemoteTransport;
const storage = { db: { prepare: vi.fn() } } as unknown as BoardStorageFacade;

beforeEach(() => {
	vi.resetModules();
	fixture.registries = { sessions: [], sources: [] };
	fixture.storage.mockClear();
	vi.mocked(storage.db.prepare).mockClear();
});

describe('isolated Board source host', () => {
	it('rejects missing provider and missing or productive transport before opening storage', async () => {
		const host = await import('../../../main/board/board-source-host');
		const { boardRemoteTransport } = await import('../../../main/board/board-remote-source');
		expect(() => host.refreshBoardSources()).toThrow();
		expect(() => host.configureBoardSourceHost(() => [])).toThrow();
		expect(() => host.configureBoardSourceHost(() => [], boardRemoteTransport)).toThrow();
		expect(fixture.storage).not.toHaveBeenCalled();
	});

	it('accepts a fixture provider and transport, then refuses replacement, reset and registry drift', async () => {
		const host = await import('../../../main/board/board-source-host');
		const remote = transport();
		const provider = () => fixture.registries.sessions;
		host.configureBoardSourceHost(provider, remote);
		await expect(host.discoverBoardSources(storage, [], remote)).resolves.toBeUndefined();
		expect(() => host.configureBoardSourceHost(provider, remote)).toThrow();
		expect(() => host.configureBoardSourceHost(() => [], transport())).toThrow();
		fixture.registries.sources = [{ id: 'changed', root: '/outside' }];
		await expect(host.discoverBoardSources(storage, [], remote)).rejects.toThrow();
		expect(storage.db.prepare).not.toHaveBeenCalled();
	});

	it('rejects an unregistered session root and a replaced transport before storage IO', async () => {
		const host = await import('../../../main/board/board-source-host');
		const remote = transport();
		fixture.registries.sessions = [{ id: 'agent', dir: '/outside' }];
		host.configureBoardSourceHost(() => fixture.registries.sessions, remote);
		await expect(
			host.discoverBoardSources(storage, fixture.registries.sessions, remote)
		).rejects.toThrow();
		await expect(
			host.discoverBoardSources(storage, fixture.registries.sessions, transport())
		).rejects.toThrow();
		expect(storage.db.prepare).not.toHaveBeenCalled();
	});
	it('rejects real SSH and source roots outside the admitted registry before discovery', async () => {
		const isolation = await vi.importActual<typeof import('../../../main/board/board-isolation')>(
			'../../../main/board/board-isolation'
		);
		const contract = isolation.requireBoardIsolation();
		const prepare = vi.spyOn(storage.db, 'prepare');
		expect(() =>
			isolation.assertBoardIsolationRegistrations(contract, {
				sessions: [{ id: 'remote', dir: contract.sourceRoot, sshRemoteId: 'real-ssh' }],
				sources: [],
			})
		).toThrow();
		expect(() =>
			isolation.assertBoardIsolationRegistrations(contract, {
				sessions: [],
				sources: [{ id: 'outside', root: contract.worktree }],
			})
		).toThrow();
		expect(prepare).not.toHaveBeenCalled();
	});
});
