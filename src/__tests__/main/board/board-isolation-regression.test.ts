import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fork } from 'node:child_process';
import { buildSync } from 'esbuild';
import Database from 'better-sqlite3';
import {
	assertBoardIsolationRegistrations,
	boardIsolationChildEnv,
	readBoardIsolationRegistries,
	requireBoardIsolation,
	type BoardIsolation,
} from '../../../main/board/board-isolation';
import { openBoardDb } from '../../../main/board/board-db';
import {
	BoardStorageFacade,
	configureBoardStorage,
	getBoardStorage,
} from '../../../main/board/board-storage';

let contract: BoardIsolation;
let scratch: string;
let bundle: string;
let childEnv: NodeJS.ProcessEnv;

beforeAll(() => {
	contract = requireBoardIsolation();
	readBoardIsolationRegistries(contract);
	if (fs.existsSync(contract.db)) throw new Error('Regression database must be fresh');
	scratch = fs.mkdtempSync(path.join(contract.root, 'admission-regression-'));
	bundle = path.join(scratch, 'child.cjs');
	buildSync({
		entryPoints: ['src/__tests__/main/board/fixtures/board-global-store-process.ts'],
		outfile: bundle,
		bundle: true,
		platform: 'node',
		format: 'cjs',
		packages: 'external',
		logLevel: 'silent',
	});
	childEnv = boardIsolationChildEnv(contract);
});
afterAll(() => {
	if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

function child(
	env: NodeJS.ProcessEnv,
	input: object
): Promise<{ ready: boolean; code: number | null }> {
	return new Promise((resolve, reject) => {
		const process = fork(bundle, [], {
			cwd: contract.worktree,
			env,
			stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
		});
		let ready = false;
		process.on('error', reject);
		process.on('message', () => {
			ready = true;
			process.kill();
		});
		process.on('exit', (code) => resolve({ ready, code }));
		process.send(input);
	});
}

describe('Board isolation admission regressions', () => {
	it('accepts the native checkout and rejects missing, relative and traversing paths without creating them', () => {
		expect(requireBoardIsolation({ env: { ...process.env }, expected: contract })).toEqual(
			contract
		);
		for (const value of [
			undefined,
			'relative/db.sqlite',
			path.join(contract.root, 'x') + '/../../escape.sqlite',
		]) {
			const env = { ...process.env, BOARD_DB_PATH: value };
			expect(() => requireBoardIsolation({ env, expected: contract })).toThrow();
		}
		expect(fs.existsSync(contract.db)).toBe(false);
	});

	it('rejects production, custom sync and symlink roots before creating a database', () => {
		const production = path.join(scratch, 'production');
		fs.mkdirSync(production);
		fs.writeFileSync(
			path.join(production, 'maestro-bootstrap.json'),
			JSON.stringify({ customSyncPath: contract.root })
		);
		expect(() =>
			requireBoardIsolation({
				env: { ...process.env },
				expected: contract,
				productionUserData: production,
			})
		).toThrow();
		expect(() =>
			requireBoardIsolation({
				env: { ...process.env },
				expected: contract,
				productionUserData: contract.root,
			})
		).toThrow();
		const alias = path.join(scratch, 'alias');
		fs.symlinkSync(contract.root, alias, 'dir');
		expect(() =>
			requireBoardIsolation({
				env: { ...process.env, BOARD_DB_PATH: path.join(alias, 'bad.sqlite') },
				expected: contract,
			})
		).toThrow();
		expect(fs.existsSync(contract.db)).toBe(false);
	});

	it('refuses invalid, remote, duplicate and outside registrations', () => {
		const valid = { sessions: [], sources: [] };
		expect(() => assertBoardIsolationRegistrations(contract, valid)).not.toThrow();
		for (const registrations of [
			{ sessions: null, sources: [] },
			{ sessions: [{ id: 'a' }], sources: [] },
			{ sessions: [], sources: [{ id: 'a', root: contract.sourceRoot, sshRemoteId: 'remote' }] },
			{ sessions: [], sources: [{ id: 'a', root: contract.worktree }] },
			{
				sessions: [],
				sources: [
					{ id: 'a', root: contract.sourceRoot },
					{ id: 'a', root: contract.sourceRoot },
				],
			},
		])
			expect(() => assertBoardIsolationRegistrations(contract, registrations)).toThrow();
		expect(fs.existsSync(contract.db)).toBe(false);
	});

	it('refuses a non-explicit database before mkdir or constructor', () => {
		const other = path.join(scratch, 'uncreated', 'other.sqlite');
		const constructor = vi.fn();
		expect(() => openBoardDb(other, constructor as unknown as typeof Database)).toThrow();
		expect(constructor).not.toHaveBeenCalled();
		expect(fs.existsSync(path.dirname(other))).toBe(false);
	});

	it('requires admitted connection provenance and an explicit facade, and refuses reset', () => {
		expect(() => getBoardStorage()).toThrow();
		expect(() => configureBoardStorage(null)).toThrow();
		const forged = { name: contract.db } as Database.Database;
		expect(() => new BoardStorageFacade(forged)).toThrow();
		const db = openBoardDb(contract.db);
		try {
			const facade = new BoardStorageFacade(db);
			configureBoardStorage(facade);
			expect(getBoardStorage()).toBe(facade);
			expect(() => configureBoardStorage(null)).toThrow();
		} finally {
			db.close();
			for (const suffix of ['', '-wal', '-shm']) fs.rmSync(contract.db + suffix, { force: true });
		}
	});

	it('requires the separately supplied parent identity in bundled children before opening DB', async () => {
		const input = { file: contract.db, contract };
		for (const [env, message] of [
			[childEnv, { file: contract.db }],
			[{ PATH: process.env.PATH }, input],
			[{ ...childEnv, BOARD_ISOLATION_ID: 'replaced' }, input],
			[{ ...childEnv, BOARD_ISOLATION_CONTRACT: '{}' }, input],
		] as [NodeJS.ProcessEnv, object][]) {
			const result = await child(env, message);
			expect(result.ready).toBe(false);
			expect(result.code).not.toBe(0);
			expect(fs.existsSync(contract.db)).toBe(false);
		}
		const result = await child(childEnv, input);
		expect(result.ready).toBe(true);
		for (const suffix of ['', '-wal', '-shm']) fs.rmSync(contract.db + suffix, { force: true });
	});
});
