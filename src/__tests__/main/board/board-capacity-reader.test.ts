import * as fs from 'node:fs';
import * as path from 'node:path';
import { fork, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';
import { readBoardWorkerCapacity } from '../../../main/board/board-capacity-reader';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));
const fixture = createBoardIsolationFixture();
const children = new Set<ChildProcess>();
let bundle: string;
let sqliteModule: string;
let sequence = 0;
beforeAll(async () => {
	fixture.install();
	const folder = path.join(fixture.contract.root, 'capacity-bundle');
	fs.mkdirSync(folder);
	bundle = path.join(folder, 'process.cjs');
	sqliteModule =
		process.env.MAESTRO_TEST_SQLITE_MODULE ??
		createRequire(path.resolve('package.json')).resolve('better-sqlite3');
	await build({
		entryPoints: [path.resolve('src/__tests__/main/board/fixtures/board-capacity-process.ts')],
		outfile: bundle,
		bundle: true,
		platform: 'node',
		format: 'cjs',
		packages: 'external',
		plugins: [
			{
				name: 'fixture-sqlite',
				setup(builder) {
					builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({
						path: sqliteModule,
						external: true,
					}));
				},
			},
		],
	});
});
afterAll(async () => fixture.cleanup());
afterEach(async () => {
	vi.restoreAllMocks();
	fs.chmodSync(fixture.contract.root, 0o700);
	for (const child of children) {
		if (child.connected) await request(child, { action: 'close' });
		if (child.exitCode === null) await once(child, 'exit');
	}
	children.clear();
	for (const suffix of ['', '-wal', '-shm'])
		fs.rmSync(fixture.contract.db + suffix, { force: true });
});
function child() {
	const value = fork(bundle, [], {
		cwd: fixture.contract.worktree,
		env: { ...fixture.env },
		stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
	});
	children.add(value);
	return value;
}
function request(child: ChildProcess, message: Record<string, unknown>): Promise<any> {
	const id = ++sequence;
	return new Promise((resolve, reject) => {
		const receive = (reply: any) => {
			if (reply.id !== id) return;
			child.off('message', receive);
			child.off('error', reject);
			if (reply.error) reject(new Error(reply.error));
			else resolve(reply);
		};
		child.on('message', receive);
		child.once('error', reject);
		child.send({ ...message, id, contract: fixture.contract });
	});
}
function files() {
	return fs.readdirSync(path.dirname(fixture.contract.db)).sort();
}
function hashes() {
	return Object.fromEntries(
		['', '-wal']
			.filter((suffix) => fs.existsSync(fixture.contract.db + suffix))
			.map((suffix) => [
				suffix,
				createHash('sha256')
					.update(fs.readFileSync(fixture.contract.db + suffix))
					.digest('hex'),
			])
	);
}
it.each([
	{ board: false, maestroCue: false },
	{ board: false, maestroCue: true },
	{ board: true, maestroCue: false },
	{ board: true, maestroCue: true },
])(
	'fresh native host preserves persisted worker capacity, free ordinary worker and gate exception: %j',
	async (flags) => {
		const writer = child();
		await request(writer, {
			action: 'setup',
			journal: 'DELETE',
			worker: 'held',
			kind: 'reservation',
		});
		await request(writer, { action: 'hold', worker: 'legacy', kind: 'migration' });
		await request(writer, { action: 'close' });
		if (writer.exitCode === null) await once(writer, 'exit');
		children.delete(writer);
		const before = hashes();
		const names = files();
		const host = child();
		for (const worker of ['held', 'legacy']) {
			const result = await request(host, { action: 'start', worker, flags });
			expect(result.allowed).toBe(false);
			expect(result.started).toBe(false);
			if (flags.board && flags.maestroCue) expect(result.runIdAllowed).toBe(worker === 'held');
			if (!flags.board || !flags.maestroCue) {
				expect(result.activations).toBe(0);
				expect(result.retained).toBe(false);
				expect(result.runIdAllowed).toBe(false);
			}
		}
		const free = await request(host, { action: 'start', worker: 'ordinary-other', flags });
		expect(free.allowed).toBe(true);
		expect(free.started).toBe(true);
		expect(free.output).toContain('ordinary child completed');
		if (!flags.board || !flags.maestroCue) {
			expect(hashes()).toEqual(before);
			expect(files()).toEqual(names);
			expect(free.activations).toBe(0);
		}
	}
);
it('reads newer WAL commits at the final native boundary after proof issuance in another fresh process', async () => {
	const writer = child();
	await request(writer, { action: 'setup' });
	const host = child();
	const flags = { board: false, maestroCue: true };
	fs.chmodSync(fixture.contract.root, 0o500);
	let creationDenied = false;
	try {
		fs.accessSync(fixture.contract.root, fs.constants.W_OK);
	} catch (error) {
		creationDenied =
			process.platform !== 'win32' &&
			['EACCES', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '');
	}
	await request(host, { action: 'prepare', worker: 'late', flags });
	if (process.platform !== 'win32' && process.getuid?.() !== 0) expect(creationDenied).toBe(true);
	const free = await request(host, { action: 'start', worker: 'ordinary-other', flags });
	if (creationDenied) expect(free.allowed).toBe(true);
	else {
		expect(free.allowed).toBe(false);
		expect(free.diagnostics.join('\n')).toContain('WAL no-create observation unsupported');
	}
	await request(writer, { action: 'hold', worker: 'late', kind: 'reservation' });
	await request(writer, { action: 'hold', worker: 'legacy', kind: 'migration' });
	const before = hashes();
	const names = files();
	for (const worker of ['late', 'legacy']) {
		const result = await request(host, { action: 'start', worker, flags });
		expect(result.allowed).toBe(false);
		expect(result.started).toBe(false);
		expect(result.activations).toBe(0);
	}
	expect(hashes()).toEqual(before);
	expect(files()).toEqual(names);
});
it('permits only proven missing DB without creating any files or opening the Board facade', async () => {
	const names = files();
	const host = child();
	const free = await request(host, {
		action: 'start',
		worker: 'ordinary-other',
		flags: { board: false, maestroCue: false },
	});
	expect(free.allowed).toBe(true);
	expect(free.activations).toBe(0);
	expect(free.retained).toBe(false);
	expect(files()).toEqual(names);
	expect(fs.existsSync(fixture.contract.db)).toBe(false);
});
it.each(['corrupt', 'old-schema', 'unknown-schema', 'missing-wal', 'unreadable'])(
	'refuses %s evidence diagnostically without schema repair or new files',
	async (kind) => {
		if (kind === 'corrupt') fs.writeFileSync(fixture.contract.db, 'not SQLite');
		else if (kind === 'unreadable') fs.mkdirSync(fixture.contract.db);
		else {
			const writer = child();
			await request(writer, {
				action: 'setup',
				journal: kind === 'missing-wal' ? 'WAL' : 'DELETE',
				version: kind === 'old-schema' ? 7 : kind === 'unknown-schema' ? 99 : undefined,
			});
			await request(writer, { action: 'close' });
			if (writer.exitCode === null) await once(writer, 'exit');
			children.delete(writer);
		}
		const names = files();
		const before = kind === 'unreadable' ? undefined : hashes();
		try {
			const host = child();
			if (kind === 'unreadable') {
				await expect(
					request(host, {
						action: 'start',
						worker: 'ordinary-other',
						flags: { board: true, maestroCue: false },
					})
				).rejects.toThrow('ambiguous file type');
				expect(files()).toEqual(names);
				return;
			}
			const result = await request(host, {
				action: 'start',
				worker: 'ordinary-other',
				flags: { board: true, maestroCue: false },
			});
			expect(result.allowed).toBe(false);
			expect(result.started).toBe(false);
			expect(result.activations).toBe(0);
			expect(result.diagnostics.join('\n')).toContain('Board capacity unavailable');
			expect(files()).toEqual(names);
			expect(hashes()).toEqual(before);
		} finally {
			if (kind === 'unreadable') fs.rmdirSync(fixture.contract.db);
		}
	}
);
it('does not treat an access error as missing or permit a different isolation DB path', () => {
	const stat = fs.lstatSync;
	const spy = vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => {
		if (String(args[0]) === fixture.contract.db)
			throw Object.assign(new Error('denied'), { code: 'EACCES' });
		return stat(...args);
	});
	expect(() => readBoardWorkerCapacity('free')).toThrow('EACCES');
	spy.mockRestore();
	expect(() =>
		readBoardWorkerCapacity('free', path.join(fixture.contract.root, 'wrong.sqlite'))
	).toThrow('isolation database identity');
});

it('refuses a DB disappearance after existence was observed instead of reclassifying it as absent', async () => {
	const writer = child();
	await request(writer, { action: 'setup', journal: 'DELETE' });
	await request(writer, { action: 'close' });
	if (writer.exitCode === null) await once(writer, 'exit');
	children.delete(writer);
	const open = fs.openSync;
	vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
		if (String(args[0]) === fixture.contract.db && args[1] === 'r')
			fs.unlinkSync(fixture.contract.db);
		return open(...args);
	});
	expect(() => readBoardWorkerCapacity('ordinary-other')).toThrow('Board capacity unavailable');
	expect(fs.existsSync(fixture.contract.db)).toBe(false);
});

it('refuses disappearing WAL sidecars after readonly open and before first schema access, without recreating them', async () => {
	const writer = child();
	await request(writer, { action: 'setup' });
	await request(writer, { action: 'close' });
	if (writer.exitCode === null) await once(writer, 'exit');
	children.delete(writer);
	// A checkpointed WAL header remains after clean close. Supply sidecar names
	// only to exercise their disappearance before any SQLite schema/WAL access.
	fs.writeFileSync(fixture.contract.db + '-wal', '');
	fs.writeFileSync(fixture.contract.db + '-shm', '');
	fs.chmodSync(fixture.contract.root, 0o500);
	let creationDenied = false;
	try {
		fs.accessSync(fixture.contract.root, fs.constants.W_OK);
	} catch (error) {
		creationDenied =
			process.platform !== 'win32' &&
			['EACCES', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '');
	}
	const stat = fs.lstatSync;
	let calls = 0;
	vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => {
		if (String(args[0]) === fixture.contract.db + '-wal' && ++calls === 3) {
			fs.chmodSync(fixture.contract.root, 0o700);
			fs.unlinkSync(fixture.contract.db + '-wal');
			fs.unlinkSync(fixture.contract.db + '-shm');
			fs.chmodSync(fixture.contract.root, 0o500);
		}
		return stat(...args);
	});
	expect(() => readBoardWorkerCapacity('ordinary-other')).toThrow('Board capacity unavailable');
	if (creationDenied) {
		expect(calls).toBe(3);
		expect(fs.existsSync(fixture.contract.db + '-wal')).toBe(false);
		expect(fs.existsSync(fixture.contract.db + '-shm')).toBe(false);
	} else {
		expect(calls).toBe(1);
		expect(fs.existsSync(fixture.contract.db + '-wal')).toBe(true);
		expect(fs.existsSync(fixture.contract.db + '-shm')).toBe(true);
	}
});

it('does not recreate sidecars removed after the final successful prequery stat', async () => {
	const writer = child();
	await request(writer, { action: 'setup' });
	await request(writer, { action: 'close' });
	if (writer.exitCode === null) await once(writer, 'exit');
	children.delete(writer);
	const loaded = createRequire(path.resolve('package.json'))(sqliteModule);
	const SQLite = loaded.default ?? loaded;
	const lastWriter = new SQLite(fixture.contract.db, { fileMustExist: true });
	lastWriter.prepare('SELECT count(*) FROM reservations').get();
	fs.chmodSync(fixture.contract.root, 0o500);
	let creationDenied = false;
	try {
		fs.accessSync(fixture.contract.root, fs.constants.W_OK);
	} catch (error) {
		creationDenied =
			process.platform !== 'win32' &&
			['EACCES', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? '');
	}
	const stat = fs.lstatSync;
	let shmStats = 0;
	let removed = false;
	vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => {
		// Return valid captured Stats: every prequery check succeeds. The actual
		// SQLite first read follows this boundary, after these names disappear.
		const captured = stat(...args);
		if (String(args[0]) === fixture.contract.db + '-shm' && ++shmStats === 3) {
			lastWriter.close();
			// Owned filesystem fault seam models external removal despite a reader's
			// retained descriptors; restore real OS no-create protection before returning.
			fs.chmodSync(fixture.contract.root, 0o700);
			fs.rmSync(fixture.contract.db + '-wal', { force: true });
			fs.rmSync(fixture.contract.db + '-shm', { force: true });
			fs.chmodSync(fixture.contract.root, 0o500);
			removed = true;
		}
		return captured;
	});
	try {
		expect(() => readBoardWorkerCapacity('ordinary-other')).toThrow('Board capacity unavailable');
		if (creationDenied) {
			expect(shmStats).toBe(3);
			expect(removed).toBe(true);
			expect(fs.existsSync(fixture.contract.db + '-wal')).toBe(false);
			expect(fs.existsSync(fixture.contract.db + '-shm')).toBe(false);
		} else {
			expect(shmStats).toBe(1);
			expect(removed).toBe(false);
		}
	} finally {
		if (lastWriter.open) lastWriter.close();
	}
});

it('diagnoses unsupported writable-directory WAL observation before SQLite can recreate raced sidecars', async () => {
	const writer = child();
	await request(writer, { action: 'setup' });
	const names = files();
	const before = hashes();
	const host = child();
	const result = await request(host, {
		action: 'start',
		worker: 'ordinary-other',
		flags: { board: false, maestroCue: false },
	});
	expect(result.allowed).toBe(false);
	expect(result.started).toBe(false);
	expect(result.activations).toBe(0);
	expect(result.diagnostics.join('\n')).toContain('WAL no-create observation unsupported');
	expect(files()).toEqual(names);
	expect(hashes()).toEqual(before);
});

it('does not create WAL files if a foreign writer changes journal format after the last header check', async () => {
	const writer = child();
	await request(writer, { action: 'setup', journal: 'DELETE' });
	await request(writer, { action: 'close' });
	if (writer.exitCode === null) await once(writer, 'exit');
	children.delete(writer);
	const before = files();
	const read = fs.readSync;
	let reads = 0;
	let changed = false;
	vi.spyOn(fs, 'readSync').mockImplementation((...args) => {
		const result = read(...args);
		if (++reads === 3) {
			const script =
				'const m=require(process.argv[1]);const D=m.default??m;const db=new D(process.argv[2],{fileMustExist:true,timeout:100});try{db.pragma("journal_mode=WAL")}finally{db.close()}';
			try {
				execFileSync(process.execPath, ['-e', script, sqliteModule, fixture.contract.db], {
					timeout: 10000,
					stdio: 'pipe',
				});
				changed = true;
			} catch (error) {
				expect(String((error as { stderr?: Buffer }).stderr)).toMatch(/locked|busy/i);
			}
		}
		return result;
	});
	let outcome: boolean | undefined;
	let failure: unknown;
	try {
		outcome = readBoardWorkerCapacity('ordinary-other');
	} catch (error) {
		failure = error;
	}
	expect(reads).toBeGreaterThanOrEqual(3);
	if (changed) expect(failure).toMatchObject({ name: 'BoardCapacityReadError' });
	else {
		expect(failure).toBeUndefined();
		expect(outcome).toBe(true);
	}
	expect(files()).toEqual(before);
});
