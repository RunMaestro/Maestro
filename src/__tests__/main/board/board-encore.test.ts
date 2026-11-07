import * as path from 'node:path';
import { openBoardDb } from '../../../main/board/board-db';
import { BoardStorageFacade, configureBoardStorage } from '../../../main/board/board-storage';
import { configureIsolatedBoardSourceHost } from '../../../main/board/board-source-host';
import { snapshotSqlite } from '../../helpers/sqliteSnapshot';
import { handleBoardCommand } from '../../../main/web-server/handlers/messageHandlers/board';
import { createBoardRunService } from '../../../main/board/board-spawn';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';
import { configureBoardFeatures } from '../../../main/board/board-feature';
import { executeBoardCommand } from '../../../main/board/board-command-host';
import { getBoardStorage, getExistingBoardStorage } from '../../../main/board/board-storage';
import { refreshBoardSources } from '../../../main/board/board-source-host';
import { BoardCueHost } from '../../../main/board/board-cue';

vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
const fixture = createBoardIsolationFixture();
beforeAll(() => {
	fixture.install();
	configureIsolatedBoardSourceHost(fixture.contract);
});
afterAll(async () => fixture.cleanup());
afterEach(() => configureBoardFeatures({ get: () => ({ board: true, maestroCue: true }) }));

it.each([
	{ board: false, maestroCue: false },
	{ board: false, maestroCue: true },
	{ board: true, maestroCue: false },
])(
	'refuses disabled host entry points before storage, discovery or native owner probes: %j',
	async (flags) => {
		configureBoardFeatures({ get: () => flags });
		const reason = flags.board ? 'CueDisabled' : 'BoardDisabled';
		await expect(executeBoardCommand({ action: 'initialize' })).rejects.toThrow(reason);
		expect(() => refreshBoardSources()).toThrow(reason);
		expect(() => getBoardStorage()).toThrow(reason);
		expect(getExistingBoardStorage()).toBeUndefined();
		const lock = vi.fn(() => null);
		const storage = vi.fn((): never => {
			throw new Error('Unexpected storage access');
		});
		const prepare = vi.fn();
		const host = new BoardCueHost({
			storage,
			lock,
			prepare,
			context: vi.fn(),
			service: { spawn: vi.fn(), stop: vi.fn(), probe: () => 'unknown' },
			ownerLiveness: () => 'unknown',
			onWait: vi.fn(),
		});
		await expect(
			host.runtimeFor({ sourceKey: 's', collectionKey: 'c', cardId: 'x' })
		).rejects.toThrow(reason);
		await host.tick();
		expect(lock).not.toHaveBeenCalled();
		expect(prepare).not.toHaveBeenCalled();
		expect(storage).not.toHaveBeenCalled();
		expect(fs.existsSync(fixture.contract.db)).toBe(false);
	}
);

it('allows both-on initialization, preserves legacy data through each off state, and resumes on enable', async () => {
	let flags = { board: true, maestroCue: true };
	configureBoardFeatures({ get: () => flags });
	const db = openBoardDb(fixture.contract.db);
	const storage = new BoardStorageFacade(db);
	configureBoardStorage(storage);
	try {
		expect(await executeBoardCommand({ action: 'initialize' })).toMatchObject({ ok: true });
		db.prepare('INSERT INTO workers VALUES (?, ?, ?, ?)').run(
			'legacy',
			0,
			1,
			'{"accessManaged":true,"allowedRepositoryIds":[]}'
		);
		const legacyFile = path.join(fixture.sources.one, '.maestro', 'board.yaml');
		fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
		fs.writeFileSync(legacyFile, 'boards: [invalid legacy yaml');
		for (const state of [
			{ board: false, maestroCue: false },
			{ board: false, maestroCue: true },
			{ board: true, maestroCue: false },
		]) {
			flags = state;
			const before = snapshotSqlite(db);
			await expect(executeBoardCommand({ action: 'query', query: {} })).rejects.toThrow(
				state.board ? 'CueDisabled' : 'BoardDisabled'
			);
			expect(() => refreshBoardSources()).toThrow();
			const report = vi.fn();
			const send = vi.fn();
			await handleBoardCommand(
				{ send, reportHandlerError: report } as never,
				{ isAuthorized: () => true, cli: true } as never,
				{ type: 'board_command', action: 'initialize', requestId: 'off' } as never
			);
			expect(report).toHaveBeenCalledOnce();
			expect(snapshotSqlite(db)).toEqual(before);
			expect(fs.readFileSync(legacyFile, 'utf8')).toBe('boards: [invalid legacy yaml');
			const getSessions = vi.fn((): never => {
				throw new Error('Unexpected session access');
			});
			const service = createBoardRunService({ getStoredSessions: getSessions } as never);
			expect(() => service.spawn({} as never, {} as never)).toThrow(
				state.board ? 'CueDisabled' : 'BoardDisabled'
			);
			expect(getSessions).not.toHaveBeenCalled();
		}
		fs.unlinkSync(legacyFile);
		flags = { board: true, maestroCue: true };
		expect(await executeBoardCommand({ action: 'query', query: {} })).toMatchObject({ ok: true });
		expect(db.prepare('SELECT * FROM workers WHERE agent_id=?').get('legacy')).toMatchObject({
			enabled: 0,
			paused: 1,
			payload_json: '{"accessManaged":true,"allowedRepositoryIds":[]}',
		});
	} finally {
		db.close();
	}
});

it('rechecks a toggle after asynchronous native-owner preparation before source/DB work', async () => {
	let flags = { board: true, maestroCue: true };
	configureBoardFeatures({ get: () => flags });
	let release!: (lock: null) => void;
	const storage = vi.fn((): never => {
		throw new Error('Unexpected storage access');
	});
	const prepare = vi.fn();
	const host = new BoardCueHost({
		storage,
		prepare,
		lock: () =>
			new Promise((resolve) => {
				release = resolve;
			}),
		context: vi.fn(),
		service: { spawn: vi.fn(), stop: vi.fn(), probe: () => 'unknown' },
		ownerLiveness: () => 'unknown',
		onWait: vi.fn(),
	});
	const pending = host.runtimeFor({ sourceKey: 's', collectionKey: 'c', cardId: 'x' });
	flags = { board: false, maestroCue: true };
	release(null);
	await expect(pending).rejects.toThrow('BoardDisabled');
	expect(storage).not.toHaveBeenCalled();
	expect(prepare).not.toHaveBeenCalled();
});
