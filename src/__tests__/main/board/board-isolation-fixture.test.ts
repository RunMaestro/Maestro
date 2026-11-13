import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { buildSync } from 'esbuild';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';
import {
	boardIsolationChildEnv,
	isBoardIsolationRequested,
	readBoardIsolationRegistries,
	requireBoardIsolation,
} from '../../../main/board/board-isolation';
import { openBoardDb } from '../../../main/board/board-db';
import { canonicalJson } from '../../../shared/canonicalJson';
import { resolveSyncDir } from '../../../shared/syncPath';

const fixtures = new Set<ReturnType<typeof createBoardIsolationFixture>>();
function fixture() {
	const value = createBoardIsolationFixture();
	fixtures.add(value);
	return value;
}
afterEach(async () => {
	for (const value of fixtures) await value.cleanup();
	fixtures.clear();
	vi.unstubAllEnvs();
});

describe('portable Board isolation fixture', () => {
	it('distinguishes ordinary demo mode from explicit Board isolation', () => {
		expect(isBoardIsolationRequested({ MAESTRO_DEMO_DIR: '/demo' })).toBe(false);
		expect(isBoardIsolationRequested({ MAESTRO_DEMO_DIR: '/demo', BOARD_DB_PATH: '/db' })).toBe(
			true
		);
		expect(() => requireBoardIsolation({ env: { BOARD_DB_PATH: '/db' } })).toThrow(
			'missing explicit BOARD_ISOLATION_ID'
		);
		for (const env of [{ BOARD_ISOLATION_ID: '' }, { BOARD_ISOLATION_CONTRACT: '' }]) {
			expect(isBoardIsolationRequested(env)).toBe(true);
			expect(() => requireBoardIsolation({ env })).toThrow('missing explicit BOARD_ISOLATION_ID');
		}
		for (const env of [{ VITEST: '1' }, { NODE_ENV: 'test' }, { MAESTRO_E2E_TEST: '1' }]) {
			expect(isBoardIsolationRequested(env)).toBe(true);
		}
	});
	it('creates distinct private canonical storage and registries without changing process env', async () => {
		const original = { ...process.env };
		const first = fixture();
		const second = fixture();
		expect(process.env).toEqual(original);
		for (const key of Object.keys(first.contract) as (keyof typeof first.contract)[]) {
			if (key !== 'worktree') expect(first.contract[key]).not.toBe(second.contract[key]);
		}
		for (const value of [first, second]) {
			const { contract, env, sources } = value;
			expect(Object.isFrozen(value)).toBe(true);
			expect(Object.isFrozen(contract)).toBe(true);
			expect(Object.isFrozen(env)).toBe(true);
			expect(Object.isFrozen(sources)).toBe(true);
			expect(env.HOME).toBe(original.HOME);
			expect(env.CODEX_HOME).toBe(original.CODEX_HOME);
			expect(fs.realpathSync.native(contract.root)).toBe(contract.root);
			expect(path.dirname(contract.root)).toBe(path.join(contract.worktree, 'isolated'));
			expect(env.BOARD_ISOLATION_CONTRACT).toBe(canonicalJson(contract));
			expect(requireBoardIsolation({ env, expected: contract })).toEqual(contract);
			expect(resolveSyncDir(contract.userData)).toBe(contract.sync);
			expect(fs.existsSync(contract.db)).toBe(false);
			expect(readBoardIsolationRegistries(contract, env)).toEqual({
				sessions: [],
				sources: [
					{ id: 'one', root: sources.one },
					{ id: 'two', root: sources.two },
				],
			});
			for (const dir of [
				contract.root,
				contract.userData,
				contract.sync,
				contract.sourceRoot,
				...Object.values(sources),
			]) {
				expect(fs.statSync(dir).isDirectory()).toBe(true);
				if (process.platform !== 'win32') expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
			}
			for (const file of [contract.agentRegistry, contract.sourceRegistry]) {
				expect(path.dirname(file)).toBe(contract.root);
				if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
			}
		}
		await first.cleanup();
		expect(fs.existsSync(first.contract.root)).toBe(false);
		expect(readBoardIsolationRegistries(second.contract, second.env).sessions).toEqual([]);
		expect(process.env).toEqual(original);
	});

	it('does not admit missing, malformed, replaced or cross-fixture contracts', () => {
		const first = fixture();
		const second = fixture();
		expect(() => requireBoardIsolation({ env: {} })).toThrow('missing explicit BOARD_ISOLATION_ID');
		for (const key of [
			'BOARD_ISOLATION_ID',
			'BOARD_ISOLATED_ROOT',
			'BOARD_DB_PATH',
			'MAESTRO_USER_DATA',
			'BOARD_SYNC_PATH',
			'BOARD_AGENT_REGISTRY',
			'BOARD_SOURCE_REGISTRY',
			'BOARD_SOURCE_ROOT',
		]) {
			const env = { ...first.env };
			delete env[key];
			expect(() => requireBoardIsolation({ env, expected: first.contract })).toThrow();
		}
		for (const patch of [
			{ BOARD_ISOLATION_CONTRACT: '{}' },
			{ BOARD_ISOLATION_CONTRACT: '{broken' },
			{ BOARD_ISOLATION_ID: 'replaced' },
			{ BOARD_DB_PATH: second.contract.db },
			{ BOARD_DB_PATH: 'relative.sqlite' },
			{ BOARD_AGENT_REGISTRY: first.contract.worktree },
		])
			expect(() =>
				requireBoardIsolation({ env: { ...first.env, ...patch }, expected: first.contract })
			).toThrow();
		expect(() => boardIsolationChildEnv(first.contract, second.env)).toThrow();
		expect(fs.existsSync(first.contract.db)).toBe(false);
		expect(fs.existsSync(second.contract.db)).toBe(false);
	});

	it('retains registry admission checks before opening any DB', () => {
		const value = fixture();
		for (const contents of [
			'{broken',
			canonicalJson({ sources: null }),
			canonicalJson({ sources: [{ id: 'outside', root: value.contract.worktree }] }),
		]) {
			fs.writeFileSync(value.contract.sourceRegistry, contents);
			expect(() => readBoardIsolationRegistries(value.contract, value.env)).toThrow();
			expect(fs.existsSync(value.contract.db)).toBe(false);
		}
	});

	it('ignores inherited fixture paths while preserving HOME and leaving ambient env untouched', () => {
		const first = fixture();
		vi.stubEnv('BOARD_ISOLATION_CONTRACT', canonicalJson(first.contract));
		vi.stubEnv('BOARD_DB_PATH', first.contract.db);
		vi.stubEnv('BOARD_MIGRATION_EVIDENCE_DIR', first.contract.root);
		vi.stubEnv('MAESTRO_DEMO_DIR', first.contract.userData);
		vi.stubEnv('MAESTRO_DATA_DIR', first.contract.userData);
		const original = { ...process.env };
		const second = fixture();
		expect(second.env.BOARD_DB_PATH).toBe(second.contract.db);
		expect(second.env.BOARD_MIGRATION_EVIDENCE_DIR).toBeUndefined();
		expect(second.env.MAESTRO_DEMO_DIR).toBeUndefined();
		expect(second.env.MAESTRO_DATA_DIR).toBeUndefined();
		expect(second.env.HOME).toBe(original.HOME);
		expect(second.env.CODEX_HOME).toBe(original.CODEX_HOME);
		expect(process.env).toEqual(original);
	});

	it('runs independently parent-bound children under ordinary Vitest forks', async () => {
		const first = fixture();
		const second = fixture();
		const bundle = path.join(first.contract.root, 'initialize.cjs');
		buildSync({
			entryPoints: ['src/__tests__/main/board/fixtures/board-global-store-process.ts'],
			outfile: bundle,
			bundle: true,
			platform: 'node',
			format: 'cjs',
			packages: 'external',
			logLevel: 'silent',
		});
		for (const value of [first, second]) {
			const child = fork(bundle, [], {
				cwd: value.contract.worktree,
				env: boardIsolationChildEnv(value.contract, value.env),
				stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
			});
			let stderr = '';
			child.stderr!.on('data', (data) => {
				stderr += data;
			});
			const exited = once(child, 'exit');
			try {
				const ready = once(child, 'message', { signal: AbortSignal.timeout(5000) });
				child.send({ file: value.contract.db, contract: value.contract });
				expect((await ready)[0]).toMatchObject({ ready: true });
				const result = once(child, 'message', { signal: AbortSignal.timeout(5000) });
				child.send({ initialize: true });
				expect((await result)[0]).toMatchObject({ board: { cards: [] } });
				expect((await exited)[0], stderr).toBe(0);
				expect(fs.existsSync(value.contract.db)).toBe(true);
			} finally {
				if (child.exitCode === null && child.signalCode === null) child.kill();
				await exited;
			}
		}
	});

	it('refuses to remove a replaced root and preserves the other fixture', async () => {
		const value = fixture();
		const neighbor = fixture();
		const moved = value.contract.root + '-owned';
		fs.renameSync(value.contract.root, moved);
		fs.mkdirSync(value.contract.root, { mode: 0o700 });
		const marker = path.join(value.contract.root, 'not-owned.txt');
		fs.writeFileSync(marker, 'preserve');
		try {
			await expect(value.cleanup()).rejects.toThrow('ownership changed');
			expect(fs.readFileSync(marker, 'utf8')).toBe('preserve');
			expect(fs.existsSync(neighbor.contract.agentRegistry)).toBe(true);
		} finally {
			fs.rmSync(value.contract.root, { recursive: true });
			fs.renameSync(moved, value.contract.root);
		}
	});

	it('closes resources before deletion, restores only installed keys and rejects a second process contract', async () => {
		const value = fixture();
		const other = fixture();
		const original = { ...process.env };
		value.install();
		value.install();
		expect(() => other.install()).toThrow('retained process contract');
		expect(process.env.BOARD_DB_PATH).toBe(value.contract.db);
		const db = openBoardDb(value.contract.db);
		vi.stubEnv('MAESTRO_BOARD_FIXTURE_TEST_SENTINEL', 'changed while installed');
		try {
			await expect(
				value.cleanup(() => {
					throw new Error('still busy');
				})
			).rejects.toThrow('still busy');
			expect(db.open).toBe(true);
			expect(fs.existsSync(value.contract.root)).toBe(true);
			await value.cleanup(async () => {
				await Promise.resolve();
				expect(fs.existsSync(value.contract.root)).toBe(true);
				expect(requireBoardIsolation()).toEqual(value.contract);
				db.close();
			});
			expect(db.open).toBe(false);
			expect(fs.existsSync(value.contract.root)).toBe(false);
			expect(process.env).toEqual({
				...original,
				MAESTRO_BOARD_FIXTURE_TEST_SENTINEL: 'changed while installed',
			});
			expect(() => value.install()).toThrow('already disposed');
			const closeAgain = vi.fn();
			await value.cleanup(closeAgain);
			expect(closeAgain).not.toHaveBeenCalled();
		} finally {
			if (db.open) db.close();
		}
	});
});
