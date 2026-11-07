import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardRemoteTransport } from '../../../main/board/board-remote-source';
import type { BoardStorageFacade } from '../../../main/board/board-storage';

const fixture = vi.hoisted(() => ({
	features: { board: true, maestroCue: true },
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

beforeEach(async () => {
	vi.resetModules();
	fixture.features = { board: true, maestroCue: true };
	const { configureBoardFeatures } = await import('../../../main/board/board-feature');
	configureBoardFeatures({ get: () => fixture.features });
	fixture.registries = { sessions: [], sources: [] };
	fixture.storage.mockClear();
	vi.mocked(storage.db.prepare).mockClear();
});

describe('isolated Board source host', () => {
	it('rejects missing provider and missing or productive transport before opening storage', async () => {
		const host = await import('../../../main/board/board-source-host');
		const { boardRemoteTransport } = await import('../../../main/board/board-remote-source');
		expect(() => host.refreshBoardSources()).toThrow(
			'Board isolation source provider or transport was not admitted'
		);
		expect(() => host.configureBoardSourceHost(() => [])).toThrow(
			'Board isolation requires one fixture source provider and transport'
		);
		expect(() => host.configureBoardSourceHost(() => [], boardRemoteTransport)).toThrow(
			'Board isolation requires one fixture source provider and transport'
		);
		expect(fixture.storage).not.toHaveBeenCalled();
	});

	it('accepts a fixture provider and transport, then refuses replacement, reset and registry drift', async () => {
		const host = await import('../../../main/board/board-source-host');
		const remote = transport();
		const provider = () => fixture.registries.sessions;
		host.configureBoardSourceHost(provider, remote);
		await expect(host.discoverBoardSources(storage, [], remote)).resolves.toBeUndefined();
		expect(() => host.configureBoardSourceHost(provider, remote)).toThrow(
			'Board isolation requires one fixture source provider and transport'
		);
		expect(() => host.configureBoardSourceHost(() => [], transport())).toThrow(
			'Board isolation requires one fixture source provider and transport'
		);
		fixture.registries.sources = [{ id: 'changed', root: '/outside' }];
		await expect(host.discoverBoardSources(storage, [], remote)).rejects.toThrow(
			'Board isolation source provider or transport was not admitted'
		);
		expect(storage.db.prepare).not.toHaveBeenCalled();
	});

	it('rejects an unregistered session root and a replaced transport before storage IO', async () => {
		const host = await import('../../../main/board/board-source-host');
		const remote = transport();
		fixture.registries.sessions = [{ id: 'agent', dir: '/outside' }];
		host.configureBoardSourceHost(() => fixture.registries.sessions, remote);
		await expect(
			host.discoverBoardSources(storage, fixture.registries.sessions, remote)
		).rejects.toThrow('Board isolation source root is not registered');
		await expect(
			host.discoverBoardSources(storage, fixture.registries.sessions, transport())
		).rejects.toThrow('Board isolation source provider or transport was not admitted');
		expect(storage.db.prepare).not.toHaveBeenCalled();
	});
	it.each([
		{ board: false, maestroCue: false, reason: 'BoardDisabled' },
		{ board: false, maestroCue: true, reason: 'BoardDisabled' },
		{ board: true, maestroCue: false, reason: 'CueDisabled' },
	])('pauses admitted fixture discovery without IO when gates change: %j', async (flags) => {
		const host = await import('../../../main/board/board-source-host');
		const remote = transport();
		host.configureBoardSourceHost(() => fixture.registries.sessions, remote);
		await expect(host.discoverBoardSources(storage, [], remote)).resolves.toBeUndefined();
		fixture.features = { board: flags.board, maestroCue: flags.maestroCue };
		await expect(host.discoverBoardSources(storage, [], remote)).rejects.toThrow(flags.reason);
		expect(() => host.refreshBoardSources()).toThrow(flags.reason);
		expect(fixture.storage).not.toHaveBeenCalled();
		expect(storage.db.prepare).not.toHaveBeenCalled();
		for (const operation of Object.values(remote)) expect(operation).not.toHaveBeenCalled();
		fixture.features = { board: true, maestroCue: true };
		await expect(host.discoverBoardSources(storage, [], remote)).resolves.toBeUndefined();
	});
});
