/** Exercise remote worktree path resolution against a real POSIX shell and filesystem. */
import { spawnSync } from 'child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from 'vitest';
import type { SshRemoteConfig } from '../../../shared/types';

vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../main/utils/ssh-command-builder', () => ({ buildSshCommand: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { execFileNoThrow } from '../../../main/utils/execFile';
import { buildSshCommand } from '../../../main/utils/ssh-command-builder';
import {
	listWorktreesRemote,
	resolveWorktreeAliasesRemote,
	resolveWorktreePathsRemote,
} from '../../../main/utils/remote-git';
import { buildShellCommand, shellEscape } from '../../../main/utils/shell-escape';

function findPortableShell(): string | undefined {
	const candidates = ['sh'];
	if (process.platform === 'win32') {
		const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
		if (git.status === 0) {
			let directory = path.resolve(git.stdout.trim());
			while (path.dirname(directory) !== directory) {
				for (const relative of ['usr/bin/sh.exe', 'bin/sh.exe']) {
					const executable = path.join(directory, relative);
					if (existsSync(executable)) candidates.unshift(executable);
				}
				directory = path.dirname(directory);
			}
		}
	}
	return candidates.find(
		(candidate) => spawnSync(candidate, ['-c', 'exit 0'], { timeout: 5000 }).status === 0
	);
}

const portableShell = findPortableShell();
const gitAvailable = spawnSync('git', ['--version'], { timeout: 5000 }).status === 0;
// Keep fixtures out of the checkout: a stray repository or worktree here must
// never sit inside the project being tested.
const fixturesDirectory = realpathSync.native(os.tmpdir());
// Git exports its repository-location variables to hooks, and from a linked
// worktree that includes GIT_DIR. A fixture `git init` / `commit` / `worktree add`
// that inherits them operates on the HOST repository instead of the fixture.
const gitLocalEnvVars = (() => {
	const result = spawnSync('git', ['rev-parse', '--local-env-vars'], {
		encoding: 'utf8',
		timeout: 5000,
	});
	return result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
})();

/** The test process environment without any variable that points git at a repository. */
function fixtureEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C' };
	for (const name of gitLocalEnvVars) delete env[name];
	return env;
}
const remote: SshRemoteConfig = {
	id: 'actual-shell-remote',
	name: 'Actual shell',
	host: 'fixture.invalid',
	port: 22,
	username: 'fixture',
	enabled: true,
};

describe.skipIf(!portableShell)('remote worktree paths with a real POSIX shell', () => {
	let fixtureRoot: string;
	let shellRoot: string;

	function shellPath(...segments: string[]): string {
		return path.posix.join(shellRoot, ...segments);
	}

	function resolveFixturePaths(paths: string[], basePath = shellPath('physical', 'worktrees')) {
		return resolveWorktreePathsRemote(shellPath('repo'), basePath, remote, paths);
	}

	function fixtureGit(...args: string[]): string {
		const result = spawnSync('git', args, {
			cwd: path.join(fixtureRoot, 'repo'),
			encoding: 'utf8',
			timeout: 5000,
			env: fixtureEnv(),
		});
		expect(result.status, result.stderr).toBe(0);
		return result.stdout;
	}

	function directoryAlias(target: string, alias: string, context: TestContext): void {
		try {
			symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') context.skip();
			throw error;
		}
	}

	beforeEach(() => {
		vi.clearAllMocks();
		fixtureRoot = mkdtempSync(path.join(fixturesDirectory, 'remote-worktree-paths-'));
		mkdirSync(path.join(fixtureRoot, 'repo'));
		mkdirSync(path.join(fixtureRoot, 'physical', 'worktrees'), { recursive: true });
		const location = spawnSync(portableShell!, ['-c', 'pwd -P'], {
			cwd: fixtureRoot,
			encoding: 'utf8',
			timeout: 5000,
			env: fixtureEnv(),
		});
		expect(location.status).toBe(0);
		shellRoot = location.stdout.replace(/\n$/, '');
		vi.mocked(buildSshCommand).mockImplementation(async (_remote, options) => {
			if (options.command === 'sh') return { command: portableShell!, args: options.args ?? [] };
			if (options.command !== 'git') throw new Error('Expected a remote shell or Git command');
			return {
				command: portableShell!,
				args: [
					'-c',
					`cd -P -- ${shellEscape(options.cwd!)} && ${buildShellCommand('git', options.args ?? [])}`,
				],
			};
		});
		vi.mocked(execFileNoThrow).mockImplementation(async (command, args) => {
			const result = spawnSync(command, args, {
				cwd: fixtureRoot,
				encoding: 'utf8',
				timeout: 5000,
				env: fixtureEnv(),
			});
			return {
				// Git for Windows prints drive paths; the remote fixture uses its POSIX shell paths.
				stdout: (result.stdout ?? '').replace(
					/^worktree ([A-Za-z]):\//gm,
					(_match, drive: string) => `worktree /${drive.toLowerCase()}/`
				),
				stderr: result.stderr ?? result.error?.message ?? '',
				exitCode: result.status ?? result.error?.code ?? 1,
			};
		});
	});

	it.skipIf(!gitAvailable)('retains a removed but unpruned real Git worktree', async () => {
		fixtureGit('init', '--initial-branch=main');
		fixtureGit(
			'-c',
			'user.name=Fixture',
			'-c',
			'user.email=fixture@example.invalid',
			'commit',
			'--allow-empty',
			'-m',
			'fixture'
		);
		const removedDirectory = path.join(fixtureRoot, 'physical', 'worktrees', 'removed');
		fixtureGit('worktree', 'add', '-b', 'removed', removedDirectory);
		expect(path.dirname(path.resolve(removedDirectory))).toBe(
			path.join(fixtureRoot, 'physical', 'worktrees')
		);
		rmSync(removedDirectory, { recursive: true });
		const porcelain = fixtureGit('worktree', 'list', '--porcelain');
		expect(porcelain).toContain('branch refs/heads/removed\nprunable ');

		const child = shellPath('physical', 'worktrees', 'removed');
		const resolved = await resolveFixturePaths([child]);
		expect(resolved.data).toMatchObject({
			resolvedSessionPaths: { [child]: child },
			missingSessionPaths: [child],
		});
		const registry = await listWorktreesRemote(shellPath('repo'), remote);
		expect(registry.success).toBe(true);
		expect(registry.data?.find((entry) => entry.branch === 'removed')).toMatchObject({
			path: child,
			isPrunable: true,
		});
	});

	// Git for Windows does not consistently canonicalize descendants of junctions.
	it.skipIf(!gitAvailable || process.platform === 'win32')(
		'exposes a real Git registry alias after its parent group is migrated and replaced by a symlink',
		async (context) => {
			fixtureGit('init', '--initial-branch=main');
			fixtureGit(
				'-c',
				'user.name=Fixture',
				'-c',
				'user.email=fixture@example.invalid',
				'commit',
				'--allow-empty',
				'-m',
				'fixture'
			);
			const group = path.join(fixtureRoot, 'physical', 'worktrees', 'group');
			mkdirSync(group);
			fixtureGit('worktree', 'add', '-b', 'review', path.join(group, 'review'));
			const movedGroup = path.join(fixtureRoot, 'migrated-group');
			expect(path.dirname(path.resolve(group))).toBe(
				path.join(fixtureRoot, 'physical', 'worktrees')
			);
			expect(path.dirname(path.resolve(movedGroup))).toBe(fixtureRoot);
			renameSync(group, movedGroup);
			directoryAlias(movedGroup, group, context);

			const child = shellPath('physical', 'worktrees', 'group', 'review');
			const physicalChild = shellPath('migrated-group', 'review');
			const porcelain = fixtureGit('worktree', 'list', '--porcelain');
			expect(porcelain).toContain(`worktree ${child}\n`);
			expect(porcelain).not.toContain('prunable');
			const registry = await listWorktreesRemote(shellPath('repo'), remote);
			expect(registry.data?.find((entry) => entry.branch === 'review')?.path).toBe(child);
			const resolved = await resolveFixturePaths([child]);
			expect(resolved.data?.resolvedSessionPaths).toEqual({ [child]: physicalChild });
			expect(physicalChild).not.toBe(child);
			const aliases = await resolveWorktreeAliasesRemote([child, physicalChild], remote);
			expect(aliases).toEqual({
				success: true,
				data: { resolvedSessionPaths: { [child]: physicalChild, [physicalChild]: physicalChild } },
			});
		}
	);

	afterEach(() => {
		// Delete only this test's generated fixture, including its local alias links.
		if (!fixtureRoot) return;
		if (
			path.dirname(path.resolve(fixtureRoot)) !== fixturesDirectory ||
			!path.basename(fixtureRoot).startsWith('remote-worktree-paths-')
		) {
			throw new Error('Refusing to remove a fixture outside its generated directory');
		}
		rmSync(fixtureRoot, { recursive: true, force: true });
	});

	it('resolves a current-prefix leaf alias outside the canonical base', async (context) => {
		mkdirSync(path.join(fixtureRoot, 'elsewhere', 'review'), { recursive: true });
		directoryAlias(
			path.join(fixtureRoot, 'elsewhere', 'review'),
			path.join(fixtureRoot, 'physical', 'worktrees', 'review'),
			context
		);
		const child = shellPath('physical', 'worktrees', 'review');
		const result = await resolveFixturePaths([child]);

		expect(result.success).toBe(true);
		expect(result.data?.resolvedSessionPaths).toEqual({
			[child]: shellPath('elsewhere', 'review'),
		});
		expect(result.data?.missingSessionPaths).toBeUndefined();
		expect(result.data?.unresolvedSessionPaths).toBeUndefined();
	});

	// Git for Windows does not consistently canonicalize descendants of junctions.
	it.skipIf(process.platform === 'win32')(
		'resolves a current-prefix group alias outside the canonical base',
		async (context) => {
			mkdirSync(path.join(fixtureRoot, 'elsewhere', 'review'), { recursive: true });
			directoryAlias(
				path.join(fixtureRoot, 'elsewhere'),
				path.join(fixtureRoot, 'physical', 'worktrees', 'group'),
				context
			);
			const child = shellPath('physical', 'worktrees', 'group', 'review');
			const result = await resolveFixturePaths([child]);

			expect(result.success).toBe(true);
			expect(result.data?.resolvedSessionPaths).toEqual({
				[child]: shellPath('elsewhere', 'review'),
			});
			expect(result.data?.missingSessionPaths).toBeUndefined();
			expect(result.data?.unresolvedSessionPaths).toBeUndefined();
		}
	);

	it.each(['configured', 'physical'])(
		'records a missing current-prefix child using its reachable %s parent',
		async (prefix, context) => {
			directoryAlias(
				path.join(fixtureRoot, 'physical', 'worktrees'),
				path.join(fixtureRoot, 'configured-alias'),
				context
			);
			const base = shellPath('configured-alias');
			const child =
				prefix === 'configured'
					? shellPath('configured-alias', 'removed')
					: shellPath('physical', 'worktrees', 'removed');
			const result = await resolveFixturePaths([child], base);

			expect(result.success).toBe(true);
			expect(result.data).toMatchObject({
				resolvedBasePath: shellPath('physical', 'worktrees'),
				resolvedSessionPaths: { [child]: shellPath('physical', 'worktrees', 'removed') },
				missingSessionPaths: [child],
			});
			expect(result.data?.unresolvedSessionPaths).toBeUndefined();
		}
	);

	it.each(['before', 'after'])(
		'isolates an unreachable current-prefix group %s healthy siblings',
		async (position) => {
			mkdirSync(path.join(fixtureRoot, 'physical', 'worktrees', 'live'));
			const child = shellPath('physical', 'worktrees', 'unreachable', 'review');
			const live = shellPath('physical', 'worktrees', 'live');
			const missing = shellPath('physical', 'worktrees', 'removed');
			const candidates = position === 'before' ? [child, live, missing] : [live, missing, child];
			const result = await resolveFixturePaths(candidates);

			expect(result.success).toBe(true);
			expect(result.data).toMatchObject({
				resolvedSessionPaths: { [live]: live, [missing]: missing },
				missingSessionPaths: [missing],
				unresolvedSessionPaths: [child],
			});
			expect(result.data?.resolvedSessionPaths?.[child]).toBeUndefined();
		}
	);

	it('resolves a surviving child and a removed alias leaf independently', async (context) => {
		// Git for Windows does not consistently canonicalize descendants of junctions.
		// Keep the live child separate from the alias used to resolve the missing leaf.
		mkdirSync(path.join(fixtureRoot, 'live-child'));
		directoryAlias(
			path.join(fixtureRoot, 'physical', 'worktrees'),
			path.join(fixtureRoot, 'old-alias'),
			context
		);
		const live = shellPath('live-child');
		const removed = shellPath('old-alias', 'removed');

		const result = await resolveFixturePaths([removed, live]);

		expect(result).toEqual({
			success: true,
			data: {
				resolvedCwd: shellPath('repo'),
				resolvedBasePath: shellPath('physical', 'worktrees'),
				resolvedSessionPaths: {
					[removed]: shellPath('physical', 'worktrees', 'removed'),
					[live]: live,
				},
				missingSessionPaths: [removed],
			},
		});
	});

	it('resolves a removed alias leaf with trailing separators', async (context) => {
		directoryAlias(
			path.join(fixtureRoot, 'physical', 'worktrees'),
			path.join(fixtureRoot, 'old-alias'),
			context
		);
		const removed = `${shellPath('old-alias', 'removed')}///`;
		const result = await resolveFixturePaths([removed]);

		expect(result).toEqual({
			success: true,
			data: {
				resolvedCwd: shellPath('repo'),
				resolvedBasePath: shellPath('physical', 'worktrees'),
				resolvedSessionPaths: {
					[removed]: shellPath('physical', 'worktrees', 'removed'),
				},
				missingSessionPaths: [removed],
			},
		});
	});

	it.each(['.', '..'])('does not derive a missing candidate for a terminal %s', async (leaf) => {
		mkdirSync(path.join(fixtureRoot, 'old-alias'));
		const child = `${shellPath('old-alias', 'missing')}/${leaf}`;
		const result = await resolveFixturePaths([child]);

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({ unresolvedSessionPaths: [child] });
		expect(result.data?.resolvedSessionPaths?.[child]).toBeUndefined();
	});

	it('isolates unsafe line feeds without sending them to the remote shell', async () => {
		mkdirSync(path.join(fixtureRoot, 'old-alias'));
		mkdirSync(path.join(fixtureRoot, 'live-child'));
		const child = shellPath('old-alias', 'missing\nchild');
		const live = shellPath('live-child');
		const result = await resolveFixturePaths([child, live]);

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({
			unresolvedSessionPaths: [child],
			resolvedSessionPaths: { [live]: live },
		});
		expect(
			vi
				.mocked(buildSshCommand)
				.mock.calls.some(([, options]) =>
					options.args?.some((argument) => argument.includes(child))
				)
		).toBe(false);
	});

	it('keeps missing leaf names literal without executing shell metacharacters', async (context) => {
		directoryAlias(
			path.join(fixtureRoot, 'physical', 'worktrees'),
			path.join(fixtureRoot, 'old-alias'),
			context
		);
		const name = "missing $(touch sentinel) 'quote' `backtick` ";
		const child = shellPath('old-alias', name);
		const result = await resolveFixturePaths([child]);

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({
			resolvedSessionPaths: { [child]: shellPath('physical', 'worktrees', name) },
			missingSessionPaths: [child],
		});
		expect(existsSync(path.join(fixtureRoot, 'sentinel'))).toBe(false);
	});

	it.each(
		['missing parent', 'nondirectory', 'dangling symlink'].flatMap((failure) =>
			['alone', 'before', 'after'].map((position) => ({ failure, position }))
		)
	)(
		'preserves an unresolved $failure with probe ordering: $position',
		async ({ failure, position }, context) => {
			mkdirSync(path.join(fixtureRoot, 'live-child'));
			mkdirSync(path.join(fixtureRoot, 'missing-parent'));
			const live = shellPath('live-child');
			const missing = shellPath('missing-parent', 'removed-leaf');
			let child: string;
			if (failure === 'missing parent') {
				child = shellPath('unreachable-parent', 'child');
			} else if (failure === 'nondirectory') {
				writeFileSync(path.join(fixtureRoot, 'file-child'), 'still present');
				child = shellPath('file-child');
			} else {
				directoryAlias(
					path.join(fixtureRoot, 'missing-target'),
					path.join(fixtureRoot, 'dangling-child'),
					context
				);
				child = shellPath('dangling-child');
			}
			const candidates =
				position === 'alone'
					? [child]
					: position === 'before'
						? [child, live, missing]
						: [live, missing, child];
			const result = await resolveFixturePaths(candidates);

			expect(result.success).toBe(true);
			expect(result.data).toMatchObject({ unresolvedSessionPaths: [child] });
			if (position !== 'alone') {
				expect(result.data).toMatchObject({
					resolvedSessionPaths: { [live]: live, [missing]: missing },
					missingSessionPaths: [missing],
				});
			}
			expect(result.data?.resolvedSessionPaths?.[child]).toBeUndefined();
		}
	);

	it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
		'continues resolving healthy siblings after a permission failure',
		async () => {
			const inaccessible = path.join(fixtureRoot, 'inaccessible-parent');
			mkdirSync(path.join(inaccessible, 'child'), { recursive: true });
			mkdirSync(path.join(fixtureRoot, 'live-child'));
			const child = shellPath('inaccessible-parent', 'child');
			const live = shellPath('live-child');
			chmodSync(inaccessible, 0);
			try {
				const result = await resolveFixturePaths([child, live]);
				expect(result.success).toBe(true);
				expect(result.data).toMatchObject({
					resolvedSessionPaths: { [live]: live },
					unresolvedSessionPaths: [child],
				});
				expect(result.data?.resolvedSessionPaths?.[child]).toBeUndefined();
			} finally {
				chmodSync(inaccessible, 0o700);
			}
		}
	);

	it('resolves symlink bases while preserving literal spaces and shell metacharacters', async (context) => {
		const name = "literal $(touch sentinel) 'quote' `backtick`";
		mkdirSync(path.join(fixtureRoot, name));
		directoryAlias(
			path.join(fixtureRoot, 'physical', 'worktrees'),
			path.join(fixtureRoot, 'configured-alias'),
			context
		);
		const child = shellPath(name);

		const result = await resolveFixturePaths([child], shellPath('configured-alias'));

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({
			resolvedCwd: shellPath('repo'),
			resolvedBasePath: shellPath('physical', 'worktrees'),
			resolvedSessionPaths: { [child]: child },
		});
		expect(existsSync(path.join(fixtureRoot, 'sentinel'))).toBe(false);
	});

	it('resolves dotdot after following a symlink without lexical path collapse', async (context) => {
		mkdirSync(path.join(fixtureRoot, 'elsewhere', 'deep'), { recursive: true });
		mkdirSync(path.join(fixtureRoot, 'elsewhere', 'review'));
		directoryAlias(
			path.join(fixtureRoot, 'elsewhere', 'deep'),
			path.join(fixtureRoot, 'physical', 'worktrees', 'nested'),
			context
		);
		const child = `${shellPath('physical', 'worktrees', 'nested')}/../review`;
		const result = await resolveFixturePaths([child], shellPath('elsewhere'));

		expect(result.success).toBe(true);
		expect(result.data?.resolvedSessionPaths).toEqual({
			[child]: shellPath('elsewhere', 'review'),
		});
	});

	it.skipIf(process.platform === 'win32')(
		'isolates a safe alias whose physical target ends with a line feed',
		async (context) => {
			const target = path.join(fixtureRoot, 'physical-target\n');
			mkdirSync(target);
			mkdirSync(path.join(fixtureRoot, 'live-child'));
			directoryAlias(target, path.join(fixtureRoot, 'safe-alias'), context);
			const child = shellPath('safe-alias');
			const live = shellPath('live-child');
			const result = await resolveFixturePaths([child, live]);

			expect(result.success).toBe(true);
			expect(result.data).toMatchObject({
				unresolvedSessionPaths: [child],
				resolvedSessionPaths: { [live]: live },
			});
			expect(result.data?.resolvedSessionPaths?.[child]).toBeUndefined();
		}
	);

	it.skipIf(process.platform === 'win32')(
		'isolates a safe alias whose physical target contains a carriage return',
		async (context) => {
			const target = path.join(fixtureRoot, 'physical-\rtarget');
			mkdirSync(target);
			mkdirSync(path.join(fixtureRoot, 'live-child'));
			directoryAlias(target, path.join(fixtureRoot, 'safe-alias'), context);
			const child = shellPath('safe-alias');
			const live = shellPath('live-child');
			const result = await resolveFixturePaths([live, child]);

			expect(result.success).toBe(true);
			expect(result.data).toMatchObject({
				unresolvedSessionPaths: [child],
				resolvedSessionPaths: { [live]: live },
			});
			expect(result.data?.resolvedSessionPaths?.[child]).toBeUndefined();
		}
	);

	it.skipIf(process.platform === 'win32')(
		'isolates an existing alias whose filename ends with a line feed',
		async () => {
			const name = 'existing-linefeed\n';
			mkdirSync(path.join(fixtureRoot, name));
			mkdirSync(path.join(fixtureRoot, 'live-child'));
			const child = shellPath(name);
			const live = shellPath('live-child');
			const result = await resolveFixturePaths([child, live]);

			expect(result.success).toBe(true);
			expect(result.data).toMatchObject({
				unresolvedSessionPaths: [child],
				resolvedSessionPaths: { [live]: live },
			});
		}
	);

	it.skipIf(process.platform === 'win32')(
		'keeps a literal POSIX backslash in an alias filename',
		async () => {
			const name = 'literal\\backslash';
			mkdirSync(path.join(fixtureRoot, name));
			const child = shellPath(name);
			const result = await resolveFixturePaths([child]);

			expect(result.success).toBe(true);
			expect(result.data?.resolvedSessionPaths).toEqual({ [child]: child });
		}
	);
});
