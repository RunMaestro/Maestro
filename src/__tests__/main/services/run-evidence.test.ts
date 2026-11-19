/**
 * Run evidence against real folders: a temporary git repository and a temporary folder that is
 * not one. git runs for real (no mocks), so these cover the exact commands the service issues.
 */

import { spawnSync } from 'child_process';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	createLocalGitRunner,
	finishRunEvidence,
	scanMtimeSnapshot,
	startRunEvidence,
	type RunEvidenceHost,
} from '../../../main/services/run-evidence';
import { GIT_EMPTY_TREE, RUN_EVIDENCE_MTIME_MAX_ENTRIES } from '../../../shared/runEvidence';

const gitAvailable = spawnSync('git', ['--version'], { timeout: 5000 }).status === 0;
// Git exports its repository-location variables to hooks (GIT_DIR from a linked worktree). A
// fixture command that inherits them would operate on the host repository.
const gitLocalEnvVars = (() => {
	const result = spawnSync('git', ['rev-parse', '--local-env-vars'], {
		encoding: 'utf8',
		timeout: 5000,
	});
	return result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
})();

function fixtureEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C' };
	for (const name of gitLocalEnvVars) delete env[name];
	return env;
}

let root: string;

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync(
		'git',
		[
			'-c',
			'commit.gpgsign=false',
			'-c',
			'user.name=Fixture',
			'-c',
			'user.email=fixture@example.invalid',
			...args,
		],
		{ cwd, encoding: 'utf8', timeout: 10_000, env: fixtureEnv() }
	);
	expect(result.status, result.stderr).toBe(0);
	return result.stdout;
}

function write(relative: string, content: string): void {
	const file = path.join(root, relative);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
}

function localHost(cwd = root): RunEvidenceHost {
	return { cwd, git: createLocalGitRunner(cwd), local: true };
}

beforeEach(() => {
	root = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'run-evidence-'));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!gitAvailable)('run evidence in a git repository', () => {
	beforeEach(() => {
		git(root, 'init', '-q', '-b', 'main');
	});

	function commitAll(message: string): void {
		git(root, 'add', '-A');
		git(root, 'commit', '-q', '-m', message);
	}

	it('reports created, changed, and deleted files, committed or not, with the branch', async () => {
		write('edit.ts', 'one');
		write('rm.ts', 'gone soon');
		write('keep.ts', 'untouched');
		commitAll('base');

		const start = await startRunEvidence(localHost());
		expect(start).toMatchObject({ source: 'git', changes: {} });

		write('edit.ts', 'two');
		unlinkSync(path.join(root, 'rm.ts'));
		write('untracked.txt', 'new');
		write('committed/new.ts', 'new and committed');
		git(root, 'add', 'committed/new.ts');
		git(root, 'commit', '-q', '-m', 'agent commit');

		const evidence = await finishRunEvidence(localHost(), start!);
		expect(evidence).toEqual({
			source: 'git',
			createdFiles: ['committed/new.ts', 'untracked.txt'],
			changedFiles: ['edit.ts'],
			deletedFiles: ['rm.ts'],
			branch: 'main',
		});
	});

	it('leaves out a file that was already dirty and was not touched, but keeps one edited again', async () => {
		write('dirty-untouched.ts', 'base');
		write('dirty-edited.ts', 'base');
		commitAll('base');
		write('dirty-untouched.ts', 'local edit');
		write('dirty-edited.ts', 'local edit');
		write('scratch.txt', 'untracked before the run');

		const start = await startRunEvidence(localHost());
		write('dirty-edited.ts', 'agent edit');

		const evidence = await finishRunEvidence(localHost(), start!);
		expect(evidence).toMatchObject({
			createdFiles: [],
			changedFiles: ['dirty-edited.ts'],
			deletedFiles: [],
		});
	});

	it('reports a file the run reverted to the start commit as changed', async () => {
		write('file.ts', 'base');
		commitAll('base');
		write('file.ts', 'local edit');

		const start = await startRunEvidence(localHost());
		git(root, 'checkout', '--', 'file.ts');

		expect((await finishRunEvidence(localHost(), start!))?.changedFiles).toEqual(['file.ts']);
	});

	it('works in a repository with no commit yet', async () => {
		write('before.txt', 'there at start');

		const start = await startRunEvidence(localHost());
		expect(start).toMatchObject({ source: 'git', base: GIT_EMPTY_TREE });
		write('after.txt', 'made by the run');

		expect(await finishRunEvidence(localHost(), start!)).toMatchObject({
			createdFiles: ['after.txt'],
			changedFiles: [],
			deletedFiles: [],
		});
	});

	it('scopes the evidence to the agent folder inside a larger repository', async () => {
		write('pkg/inner.ts', 'base');
		write('outside.ts', 'base');
		commitAll('base');
		const pkg = path.join(root, 'pkg');

		const start = await startRunEvidence(localHost(pkg));
		write('pkg/inner.ts', 'edited');
		write('pkg/added.ts', 'new');
		write('outside.ts', 'edited outside the agent folder');

		expect(await finishRunEvidence(localHost(pkg), start!)).toMatchObject({
			createdFiles: ['added.ts'],
			changedFiles: ['inner.ts'],
			deletedFiles: [],
		});
	});

	it('reports no branch on a detached checkout', async () => {
		write('a.ts', 'base');
		commitAll('base');
		git(root, 'checkout', '-q', '--detach');

		const start = await startRunEvidence(localHost());
		const evidence = await finishRunEvidence(localHost(), start!);
		expect(evidence).not.toHaveProperty('branch');
	});

	it('answers null when git cannot read the folder at the end', async () => {
		write('a.ts', 'base');
		commitAll('base');
		const start = await startRunEvidence(localHost());
		const failing: RunEvidenceHost = {
			...localHost(),
			git: async () => ({ stdout: '', stderr: 'fatal: broken', exitCode: 128 }),
		};

		expect(await finishRunEvidence(failing, start!)).toBeNull();
	});
});

describe('run evidence outside a git repository', () => {
	const notARepo = async () => ({
		stdout: '',
		stderr: 'fatal: not a git repository',
		exitCode: 128,
	});

	it('falls back to an mtime scan and reports created, changed, and deleted files', async () => {
		write('edit.md', 'one');
		write('gone.md', 'two');
		write('docs/keep.md', 'three');
		const host: RunEvidenceHost = { cwd: root, git: notARepo, local: true };

		const start = await startRunEvidence(host);
		expect(start).toMatchObject({ source: 'mtime', truncated: false });

		const later = new Date(Date.now() + 60_000);
		utimesSync(path.join(root, 'edit.md'), later, later);
		unlinkSync(path.join(root, 'gone.md'));
		write('docs/new.md', 'four');

		expect(await finishRunEvidence(host, start!)).toEqual({
			source: 'mtime',
			createdFiles: ['docs/new.md'],
			changedFiles: ['edit.md'],
			deletedFiles: ['gone.md'],
		});
	});

	it('reads three folder levels and never enters node_modules or .git', async () => {
		write('one.md', 'x');
		write('a/two.md', 'x');
		write('a/b/three.md', 'x');
		write('a/b/c/four.md', 'x');
		write('node_modules/pkg/index.js', 'x');
		write('.git/HEAD', 'x');

		const snapshot = await scanMtimeSnapshot(root, 1);
		expect(Object.keys(snapshot!.files).sort()).toEqual(['a/b/three.md', 'a/two.md', 'one.md']);
	});

	it('stops at the entry cap and still diffs an unchanged folder to nothing', async () => {
		for (let i = 0; i < RUN_EVIDENCE_MTIME_MAX_ENTRIES + 5; i++) {
			write(`f${String(i).padStart(4, '0')}.md`, 'x');
		}
		const host: RunEvidenceHost = { cwd: root, git: notARepo, local: true };

		const start = await startRunEvidence(host);
		expect(start).toMatchObject({ source: 'mtime', truncated: true });
		expect(Object.keys((start as { files: object }).files)).toHaveLength(
			RUN_EVIDENCE_MTIME_MAX_ENTRIES
		);

		expect(await finishRunEvidence(host, start!)).toMatchObject({
			createdFiles: [],
			changedFiles: [],
			deletedFiles: [],
		});
	});

	it('has no evidence for a remote folder that is not a repository', async () => {
		const remote: RunEvidenceHost = { cwd: '/remote/project', git: notARepo, local: false };
		expect(await startRunEvidence(remote)).toBeNull();
		expect(
			await finishRunEvidence(remote, { source: 'mtime', takenAt: 1, files: {}, truncated: false })
		).toBeNull();
	});

	it('answers null when the folder itself cannot be read', async () => {
		expect(await scanMtimeSnapshot(path.join(root, 'missing'), 1)).toBeNull();
	});
});
