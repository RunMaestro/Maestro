import * as fs from 'node:fs';
import * as path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
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
it.each(
	[
		{ board: false, maestroCue: false },
		{ board: false, maestroCue: true },
		{ board: true, maestroCue: false },
		{ board: true, maestroCue: true },
	].flatMap((flags) => [
		{ flags, closed: false },
		{ flags, closed: true },
	])
)('default writable WAL preserves held and free native starts: %j', async ({ flags, closed }) => {
	const writer = child();
	await request(writer, { action: 'setup' }); // openBoardDb's production default WAL
	expect([...fs.readFileSync(fixture.contract.db).subarray(18, 20)]).toEqual([2, 2]);
	const host = closed ? undefined : child();
	if (host) {
		await request(host, { action: 'prepare', worker: 'held', flags });
		await request(host, { action: 'prepare', worker: 'legacy', flags });
		// Prime a fresh host before a different process commits either hold.
		const free = await request(host, { action: 'start', worker: 'ordinary-other', flags });
		expect(free.allowed).toBe(true);
		expect(free.started).toBe(true);
		expect(free.output).toContain('ordinary child completed');
	}
	await request(writer, { action: 'hold', worker: 'held', kind: 'reservation' });
	await request(writer, { action: 'hold', worker: 'legacy', kind: 'migration' });
	const { snapshot, schema, version } = await request(writer, { action: 'snapshot' });
	if (closed) {
		await request(writer, { action: 'close' });
		if (writer.exitCode === null) await once(writer, 'exit');
		children.delete(writer);
		// No observation handle has opened this checkpointed WAL database yet.
		expect([...fs.readFileSync(fixture.contract.db).subarray(18, 20)]).toEqual([2, 2]);
		expect(fs.existsSync(fixture.contract.db + '-wal')).toBe(false);
		expect(fs.existsSync(fixture.contract.db + '-shm')).toBe(false);
	}
	const admissionHost = host ?? child();
	for (const worker of ['held', 'legacy']) {
		const result = await request(admissionHost, { action: 'start', worker, flags });
		expect(result.allowed).toBe(false);
		expect(result.started).toBe(false);
		if (flags.board && flags.maestroCue) expect(result.runIdAllowed).toBe(worker === 'held');
		else {
			expect(result.activations).toBe(0);
			expect(result.retained).toBe(false);
			expect(result.runIdAllowed).toBe(false);
		}
	}
	const free = await request(admissionHost, { action: 'start', worker: 'ordinary-other', flags });
	expect(free.allowed).toBe(true);
	expect(free.started).toBe(true);
	expect(free.output).toContain('ordinary child completed');
	if (!flags.board || !flags.maestroCue) {
		expect(free.activations).toBe(0);
		expect(free.retained).toBe(false);
	}
	const after = await request(closed ? admissionHost : writer, { action: 'snapshot' });
	expect(after.snapshot).toEqual(snapshot);
	expect(after.schema).toEqual(schema);
	expect(after.version).toBe(version);
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
	expect(free.started).toBe(true);
	expect(free.output).toContain('ordinary child completed');
	expect(free.activations).toBe(0);
	expect(free.retained).toBe(false);
	expect(files()).toEqual(names);
	expect(fs.existsSync(fixture.contract.db)).toBe(false);
});
it.each(['corrupt', 'old-schema', 'unknown-schema', 'unreadable'])(
	'refuses %s evidence diagnostically without schema repair or new files',
	async (kind) => {
		if (kind === 'corrupt') fs.writeFileSync(fixture.contract.db, 'not SQLite');
		else if (kind === 'unreadable') fs.mkdirSync(fixture.contract.db);
		else {
			const writer = child();
			await request(writer, {
				action: 'setup',
				journal: 'DELETE',
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
	await request(writer, { action: 'setup' });
	await request(writer, { action: 'close' });
	if (writer.exitCode === null) await once(writer, 'exit');
	children.delete(writer);
	const stat = fs.lstatSync;
	let removed = false;
	vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => {
		const observed = stat(...args);
		if (String(args[0]) === fixture.contract.db && typeof args[1] === 'object' && args[1]?.bigint) {
			fs.unlinkSync(fixture.contract.db);
			removed = true;
		}
		return observed;
	});
	expect(() => readBoardWorkerCapacity('ordinary-other')).toThrow('Board capacity unavailable');
	expect(removed).toBe(true);
	expect(fs.existsSync(fixture.contract.db)).toBe(false);
});
