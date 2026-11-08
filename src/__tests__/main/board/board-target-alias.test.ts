// @vitest-environment node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';
import { stopProcess } from '../../../shared/maestro-lib/control/termination';
const fixture = createBoardIsolationFixture({ syncInUserData: true });
let bundle: string;
let cliBundle: string;
beforeAll(async () => {
	const folder = path.join(fixture.contract.root, 'alias-bundle');
	fs.mkdirSync(folder);
	bundle = path.join(folder, 'process.cjs');
	cliBundle = path.join(folder, 'cli.cjs');
	await build({
		entryPoints: [path.resolve('src/cli/index.ts')],
		outfile: cliBundle,
		bundle: true,
		platform: 'node',
		format: 'cjs',
		packages: 'external',
	});
	const sqlite =
		process.env.MAESTRO_TEST_SQLITE_MODULE ??
		createRequire(path.resolve('package.json')).resolve('better-sqlite3');
	await build({
		entryPoints: [path.resolve('src/__tests__/main/board/fixtures/board-target-alias-process.ts')],
		outfile: bundle,
		bundle: true,
		platform: 'node',
		format: 'cjs',
		packages: 'external',
		plugins: [
			{
				name: 'fixture-sqlite',
				setup(b) {
					b.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: sqlite, external: true }));
				},
			},
		],
	});
});
afterAll(async () => fixture.cleanup());
async function run(mode: string) {
	const env = {
		...process.env,
		NODE_ENV: 'production',
		MAESTRO_USER_DATA: fixture.contract.userData,
	};
	for (const key of Object.keys(env))
		if (key.startsWith('BOARD_') || key.startsWith('VITEST') || key === 'MAESTRO_E2E_TEST')
			delete env[key as keyof typeof env];
	const child = fork(bundle, [], {
		cwd: fixture.contract.worktree,
		env,
		stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
	});
	let stderr = '';
	child.stderr!.on('data', (b) => {
		stderr += String(b);
	});
	try {
		const message = once(child, 'message');
		const exit = once(child, 'exit');
		child.send({ contract: fixture.contract, env: fixture.env, mode, cliBundle });
		const [result] = await message;
		const [code] = await exit;
		if (code !== 0) throw new Error(result.error ?? stderr);
		return result;
	} finally {
		if (child.exitCode === null) await stopProcess({ child }, { from: 'terminate', graceMs: 1000 });
		for (const suffix of ['', '-wal', '-shm'])
			fs.rmSync(fixture.contract.db + suffix, { force: true });
		for (const name of ['alias', 'alias.old', 'physical', 'foreign'])
			fs.rmSync(path.join(fixture.contract.sourceRoot, name), { recursive: true, force: true });
	}
}
it('admits an unchanged explicitly registered physical alias over real authenticated WS', async () => {
	const result = await run('valid');
	expect(result.productionSourceAdapter).toBe(true);
	expect(result.result.ok).toBe(true);
	expect(result.unchanged).toBe(false);
});
it.each(['retarget-await', 'retarget-queue', 'replace-queue', 'cwd-queue', 'missing-queue'])(
	'refuses an alias changed at %s without mutation',
	async (mode) => {
		const result = await run(mode);
		expect(result.result.ok).toBe(false);
		expect(result.unchanged).toBe(true);
	}
);
it('admits the alias while unrelated canonical discovery remains pending', async () => {
	const result = await run('barrier');
	expect(result.result.ok).toBe(true);
	expect(result.backgroundPending).toBe(true);
	expect(result.foreignProbes).toBe(1);
});

it.each([
	['list', { listed: ['b'], name: 'Remote board' }],
	['rename', { name: 'Renamed remote' }],
	['tick', { replyType: 'tick', name: 'Remote board' }],
	['closed', { name: 'Closed source edit' }],
] as const)('preserves actual CLI SSH %s through real auth WS', async (operation, expected) => {
	const result = await run('retained-ssh-cli-' + operation);
	expect(result).toMatchObject({ actualCli: true, operation, ...expected });
});
