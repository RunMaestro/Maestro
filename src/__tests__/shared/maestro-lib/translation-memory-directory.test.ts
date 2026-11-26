// @vitest-environment node
/**
 * `discoverClaudeMemoryRoot()`: which folder Claude's memory lives in, and why a repository's own
 * `autoMemoryDirectory` is held to the project and the account's config directory (RC-F13 / #16). A cloned
 * repo writes `.claude/settings.json` and `.claude/settings.local.json`, so a value there must not be able to
 * aim the Memory Viewer or a provider migration at `~/.ssh`. The account's own settings file is the user's and
 * is honored wherever it points.
 */
import { realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverClaudeMemoryRoot } from '../../../shared/maestro-lib/translation/memory';
import { encodeClaudeProjectPath } from '../../../shared/pathUtils';

/** A directory link that needs no privilege on Windows. */
const DIRECTORY_LINK = process.platform === 'win32' ? 'junction' : 'dir';

describe('discoverClaudeMemoryRoot: a repository autoMemoryDirectory', () => {
	let root: string;
	let home: string;
	let project: string;
	let account: string;

	beforeEach(async () => {
		root = realpathSync.native(await fs.mkdtemp(path.join(os.tmpdir(), 'memory-directory-')));
		home = path.join(root, 'home');
		project = path.join(root, 'project');
		account = path.join(home, '.claude');
		await Promise.all(
			[path.join(home, '.ssh'), path.join(project, '.claude'), account].map((dir) =>
				fs.mkdir(dir, { recursive: true })
			)
		);
		// `~` expands through os.homedir(), which reads these: a throwaway home, never the real one.
		vi.stubEnv('HOME', home);
		vi.stubEnv('USERPROFILE', home);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await fs.rm(root, { recursive: true, force: true });
	});

	const projectSettings = (file = 'settings.json') => path.join(project, '.claude', file);
	const writeProjectSettings = (value: unknown, file = 'settings.json') =>
		fs.writeFile(projectSettings(file), JSON.stringify({ autoMemoryDirectory: value }));
	const defaultMemory = () =>
		path.join(account, 'projects', encodeClaudeProjectPath(project), 'memory');
	const discover = () => discoverClaudeMemoryRoot(project, account);

	it('uses the default folder when nothing sets one', async () => {
		await expect(discover()).resolves.toEqual({
			path: defaultMemory(),
			source: 'default',
			ignored: [],
		});
	});

	it.each([
		['the home folder `~/.ssh`', () => '~/.ssh'],
		['`../../`, above the project', () => '../../'],
		['an absolute path elsewhere', () => path.join(root, 'elsewhere')],
		['a sibling whose name starts with the project name', () => `${project}-notes`],
	])('ignores %s and uses the default folder', async (_label, value) => {
		await writeProjectSettings(value());
		const result = await discover();
		expect(result.path).toBe(defaultMemory());
		expect(result.source).toBe('default');
		expect(result.ignored).toMatchObject([{ settingsPath: projectSettings(), directory: value() }]);
	});

	it('names where the ignored value really points', async () => {
		await writeProjectSettings('~/.ssh');
		const [ignored] = (await discover()).ignored;
		expect(ignored.resolvedPath).toBe(realpathSync.native(path.join(home, '.ssh')));
	});

	it.each([
		[
			'a folder that does not exist yet',
			() => 'docs/memory',
			() => path.join(project, 'docs', 'memory'),
		],
		[
			'an absolute path inside the project',
			() => path.join(project, 'memory'),
			() => path.join(project, 'memory'),
		],
		['the project itself', () => '.', () => project],
	])('keeps %s', async (_label, value, expected) => {
		await writeProjectSettings(value());
		await expect(discover()).resolves.toEqual({
			path: expected(),
			source: 'project',
			ignored: [],
		});
	});

	it('keeps a folder inside the account config directory', async () => {
		const shared = path.join(account, 'shared-memory');
		await writeProjectSettings(shared);
		await expect(discover()).resolves.toEqual({ path: shared, source: 'project', ignored: [] });
	});

	it('ignores a symlink inside the project that leads out of it, also for a folder not created yet', async () => {
		const secrets = path.join(root, 'secrets');
		await fs.mkdir(secrets);
		await fs.symlink(secrets, path.join(project, 'mem'), DIRECTORY_LINK);
		const realSecrets = realpathSync.native(secrets);
		const cases: Array<[value: string, resolved: string]> = [
			['mem', realSecrets],
			['mem/not-created-yet', path.join(realSecrets, 'not-created-yet')],
		];
		for (const [value, resolved] of cases) {
			await writeProjectSettings(value);
			const result = await discover();
			expect(result.path).toBe(defaultMemory());
			expect(result.ignored).toMatchObject([{ directory: value, resolvedPath: resolved }]);
		}
	});

	it('keeps a symlink inside the project that stays inside it, returning its resolved target', async () => {
		await fs.mkdir(path.join(project, 'real-memory'));
		await fs.symlink(path.join(project, 'real-memory'), path.join(project, 'mem'), DIRECTORY_LINK);
		await writeProjectSettings('mem');
		await expect(discover()).resolves.toEqual({
			path: path.join(project, 'real-memory'),
			source: 'project',
			ignored: [],
		});
	});

	it.skipIf(process.platform === 'win32')(
		'does not treat a literal backslash in a sibling name as a path separator on POSIX',
		async () => {
			const sibling = `${project}\\memory`;
			await writeProjectSettings(sibling);
			const result = await discover();
			expect(result.path).toBe(defaultMemory());
			expect(result.source).toBe('default');
			expect(result.ignored).toHaveLength(1);
		}
	);

	it('holds .claude/settings.local.json to the same rule', async () => {
		await writeProjectSettings('~/.ssh', 'settings.local.json');
		const result = await discover();
		expect(result.path).toBe(defaultMemory());
		expect(result.ignored).toMatchObject([
			{ settingsPath: projectSettings('settings.local.json'), directory: '~/.ssh' },
		]);
	});

	it('keeps the earlier project value when a later one is ignored', async () => {
		await writeProjectSettings('docs/memory');
		await writeProjectSettings('~/.ssh', 'settings.local.json');
		const result = await discover();
		expect(result.path).toBe(path.join(project, 'docs', 'memory'));
		expect(result.source).toBe('project');
		expect(result.ignored).toHaveLength(1);
	});

	it('falls back to the account value when the project value is ignored', async () => {
		await fs.writeFile(
			path.join(account, 'settings.json'),
			JSON.stringify({ autoMemoryDirectory: 'notes/memory' })
		);
		await writeProjectSettings('~/.ssh');
		const result = await discover();
		expect(result.path).toBe(path.join(project, 'notes', 'memory'));
		expect(result.source).toBe('account');
		expect(result.ignored).toHaveLength(1);
	});

	it('honors the account settings value wherever it points', async () => {
		const elsewhere = path.join(root, 'elsewhere');
		await fs.writeFile(
			path.join(account, 'settings.json'),
			JSON.stringify({ autoMemoryDirectory: elsewhere })
		);
		await expect(discover()).resolves.toEqual({ path: elsewhere, source: 'account', ignored: [] });
	});

	it('skips a blank value without calling it ignored', async () => {
		await writeProjectSettings('   ');
		await expect(discover()).resolves.toMatchObject({
			path: defaultMemory(),
			source: 'default',
			ignored: [],
		});
	});

	it('judges a worktree setting against the worktree, not the main checkout', async () => {
		const mainCheckout = path.join(root, 'main-checkout');
		await writeProjectSettings('docs/memory');
		await expect(discoverClaudeMemoryRoot(project, account, mainCheckout)).resolves.toMatchObject({
			path: path.join(project, 'docs', 'memory'),
			source: 'project',
		});
		await writeProjectSettings(path.join(mainCheckout, 'memory'));
		await expect(discoverClaudeMemoryRoot(project, account, mainCheckout)).resolves.toMatchObject({
			path: path.join(account, 'projects', encodeClaudeProjectPath(mainCheckout), 'memory'),
			source: 'default',
			ignored: [{ directory: path.join(mainCheckout, 'memory') }],
		});
	});
});
