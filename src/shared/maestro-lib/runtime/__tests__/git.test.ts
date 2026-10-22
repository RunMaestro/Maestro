import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commitAll, isGitRepository, readGitBranch } from '../git';

const git = (cwd: string, ...args: string[]): string =>
	execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

describe('runtime git', () => {
	let repo: string;
	let plain: string;

	beforeEach(() => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-git-repo-'));
		plain = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-git-plain-'));
		git(repo, 'init', '-q', '-b', 'trunk');
		git(repo, 'config', 'user.email', 'test@example.com');
		git(repo, 'config', 'user.name', 'Test');
		git(repo, 'config', 'commit.gpgsign', 'false');
		fs.writeFileSync(path.join(repo, 'a.txt'), 'one');
		git(repo, 'add', '-A');
		git(repo, 'commit', '-q', '-m', 'first');
	});
	afterEach(() => {
		fs.rmSync(repo, { recursive: true, force: true });
		fs.rmSync(plain, { recursive: true, force: true });
	});

	it('reads the branch, and whether a folder is a repository', async () => {
		expect(await readGitBranch(repo)).toBe('trunk');
		expect(await isGitRepository(repo)).toBe(true);
		expect(await isGitRepository(plain)).toBe(false);
		expect(await readGitBranch(plain)).toBeUndefined();
	});

	it('commits everything the iteration left, with the message, and answers the short hash', async () => {
		fs.writeFileSync(path.join(repo, 'a.txt'), 'two');
		fs.writeFileSync(path.join(repo, 'b.txt'), 'new');

		const result = await commitAll(repo, 'Maestro Auto Run (goal) iteration 1 - first cut');

		expect(result.committed).toBe(true);
		expect(result.commitHash).toBe(git(repo, 'rev-parse', '--short', 'HEAD'));
		expect(git(repo, 'log', '-1', '--format=%s')).toBe(
			'Maestro Auto Run (goal) iteration 1 - first cut'
		);
		expect(git(repo, 'status', '--porcelain')).toBe('');
	});

	it('is a quiet no-op on a clean tree', async () => {
		const before = git(repo, 'rev-parse', 'HEAD');
		expect(await commitAll(repo, 'nothing')).toEqual({ committed: false });
		expect(git(repo, 'rev-parse', 'HEAD')).toBe(before);
	});

	it('reports a failed commit instead of throwing', async () => {
		const result = await commitAll(plain, 'not a repository');
		expect(result.committed).toBe(false);
		expect(result.error).toContain('git add failed');
	});
});
