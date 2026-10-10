/**
 * Integration tests for the worktree-checkpoint git mechanism.
 *
 * These run against a REAL temporary git repository rather than a mocked
 * `execFile`. That is the point: every claim this feature makes is a claim
 * about git's exact behaviour - that a scratch index leaves the real one
 * untouched, that `read-tree --reset -u` plus `clean` reproduces a tree, that
 * restoring puts an untracked file back untracked rather than staged. A mock
 * would assert the argv we chose, which is the part we already know; it would
 * not catch choosing the wrong argv, which is the only failure that matters.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	createCheckpoint,
	deleteCheckpoint,
	getCheckpoint,
	listCheckpoints,
	restoreCheckpoint,
} from '../../../main/git/checkpoints';

let repo: string;

function git(...args: string[]): string {
	return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

function write(relative: string, contents: string): void {
	const target = path.join(repo, relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, contents);
}

function read(relative: string): string {
	return fs.readFileSync(path.join(repo, relative), 'utf8');
}

function exists(relative: string): boolean {
	return fs.existsSync(path.join(repo, relative));
}

/** `git status --porcelain` as a set, so assertions don't depend on git's ordering. */
function status(): string[] {
	return git('status', '--porcelain')
		.split('\n')
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.sort();
}

beforeEach(() => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-ckpt-'));
	git('init', '--initial-branch=main', '.');
	git('config', 'user.email', 'test@example.com');
	git('config', 'user.name', 'Test');
	// Git for Windows defaults `core.autocrlf` to true, which rewrites LF to CRLF
	// on checkout - so a restore correctly round-tripping content through git
	// would still fail a byte-exact assertion, on Windows only. Pinning it here
	// keeps these tests asserting what they mean to (the content came back)
	// rather than the platform's line-ending policy. Note this is a property of
	// the TEST fixture, not of checkpoints: a checkpoint normalizes line endings
	// exactly as an ordinary commit does, which is the behaviour we want.
	git('config', 'core.autocrlf', 'false');
	// Deliberately NOT set as a global: an environment with no committer identity
	// is exactly the case createCheckpoint's explicit GIT_AUTHOR_* env covers.
	write('tracked.txt', 'original\n');
	write('.gitignore', 'ignored.txt\n');
	git('add', '.');
	git('commit', '-m', 'init');
});

afterEach(() => {
	fs.rmSync(repo, { recursive: true, force: true });
});

describe('createCheckpoint', () => {
	it('captures staged, unstaged, and untracked files', async () => {
		write('tracked.txt', 'modified\n');
		write('untracked.txt', 'new file\n');
		write('staged.txt', 'staged\n');
		git('add', 'staged.txt');

		const result = await createCheckpoint({ cwd: repo }, { label: 'snapshot' });
		expect(result.success).toBe(true);

		const files = git('ls-tree', '-r', '--name-only', result.checkpoint!.treeSha)
			.split('\n')
			.filter(Boolean)
			.sort();
		expect(files).toEqual(['.gitignore', 'staged.txt', 'tracked.txt', 'untracked.txt']);
	});

	it('excludes ignored files by default', async () => {
		write('ignored.txt', 'secret\n');
		const result = await createCheckpoint({ cwd: repo });
		const files = git('ls-tree', '-r', '--name-only', result.checkpoint!.treeSha);
		expect(files).not.toContain('ignored.txt');
		expect(result.checkpoint!.includesIgnored).toBe(false);
	});

	it('captures ignored files when asked', async () => {
		write('ignored.txt', 'secret\n');
		const result = await createCheckpoint({ cwd: repo }, { includeIgnored: true });
		const files = git('ls-tree', '-r', '--name-only', result.checkpoint!.treeSha);
		expect(files).toContain('ignored.txt');
		expect(result.checkpoint!.includesIgnored).toBe(true);
	});

	it('leaves the real index untouched', async () => {
		// The reason the scratch index exists. A checkpoint is meant to be taken
		// while an agent is mid-edit, and `git add -A` against the real index
		// would silently stage that agent's in-progress work.
		write('tracked.txt', 'modified\n');
		write('untracked.txt', 'new\n');
		const before = status();

		await createCheckpoint({ cwd: repo });

		expect(status()).toEqual(before);
	});

	it('leaves HEAD and the branch where they were', async () => {
		const headBefore = git('rev-parse', 'HEAD').trim();
		await createCheckpoint({ cwd: repo });
		expect(git('rev-parse', 'HEAD').trim()).toBe(headBefore);
		expect(git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
	});

	it('anchors the commit under refs/maestro/checkpoints so gc cannot collect it', async () => {
		const result = await createCheckpoint({ cwd: repo });
		const ref = `refs/maestro/checkpoints/${result.checkpoint!.id}`;
		expect(git('rev-parse', ref).trim()).toBe(result.checkpoint!.commitSha);
	});

	it('succeeds on a clean tree', async () => {
		// "Nothing has changed yet" is the state most worth returning to, and the
		// Auto Run hook takes its first checkpoint from exactly here.
		const result = await createCheckpoint({ cwd: repo });
		expect(result.success).toBe(true);
	});

	it('leaves no scratch index behind', async () => {
		await createCheckpoint({ cwd: repo });
		const gitDir = git('rev-parse', '--absolute-git-dir').trim();
		const leftovers = fs
			.readdirSync(gitDir)
			.filter((name) => name.startsWith('maestro-checkpoint-'));
		expect(leftovers).toEqual([]);
	});

	it('records the branch it was taken on', async () => {
		git('checkout', '-q', '-b', 'feature/x');
		const result = await createCheckpoint({ cwd: repo });
		expect(result.checkpoint!.branch).toBe('feature/x');
	});

	it('works from a subdirectory, capturing the whole tree', async () => {
		// `git add -A -- .` is cwd-relative, so a terminal-mode agent that has
		// cd'd into a subdirectory would otherwise snapshot only that subtree and
		// report it as a whole-tree checkpoint.
		write('sub/nested.txt', 'nested\n');
		write('untracked.txt', 'top level\n');
		const result = await createCheckpoint({ cwd: path.join(repo, 'sub') });

		const files = git('ls-tree', '-r', '--name-only', result.checkpoint!.treeSha);
		expect(files).toContain('untracked.txt');
		expect(files).toContain('sub/nested.txt');
	});

	it('reports a conflicted index instead of writing a broken checkpoint', async () => {
		git('checkout', '-q', '-b', 'other');
		write('tracked.txt', 'theirs\n');
		git('commit', '-qam', 'theirs');
		git('checkout', '-q', 'main');
		write('tracked.txt', 'ours\n');
		git('commit', '-qam', 'ours');
		try {
			git('merge', 'other');
		} catch {
			// Expected: this is how the unmerged index gets created.
		}

		const result = await createCheckpoint({ cwd: repo });
		expect(result.success).toBe(false);
		// The message has to name the repo state, not "write-tree failed", or the
		// user goes looking for a Maestro bug.
		expect(result.error).toMatch(/merge or rebase/i);
	});
});

describe('listCheckpoints', () => {
	it('returns an empty list for a repo with no checkpoints', async () => {
		const result = await listCheckpoints({ cwd: repo });
		expect(result.success).toBe(true);
		expect(result.checkpoints).toEqual([]);
	});

	it('returns checkpoints newest first', async () => {
		const first = await createCheckpoint({ cwd: repo }, { label: 'first' });
		const second = await createCheckpoint({ cwd: repo }, { label: 'second' });

		const result = await listCheckpoints({ cwd: repo });
		expect(result.checkpoints.map((c) => c.id)).toEqual([
			second.checkpoint!.id,
			first.checkpoint!.id,
		]);
	});

	it('round-trips the label and origin through the commit', async () => {
		await createCheckpoint({ cwd: repo }, { label: 'before the refactor', origin: 'auto-run' });
		const [checkpoint] = (await listCheckpoints({ cwd: repo })).checkpoints;
		expect(checkpoint.label).toBe('before the refactor');
		expect(checkpoint.origin).toBe('auto-run');
	});

	it('ignores an unrelated ref parked in the namespace', async () => {
		// The namespace is plain git, so anything can write there. One unreadable
		// ref must not take down the whole listing.
		git('update-ref', 'refs/maestro/checkpoints/bogus', git('rev-parse', 'HEAD').trim());
		await createCheckpoint({ cwd: repo }, { label: 'real' });

		const result = await listCheckpoints({ cwd: repo });
		expect(result.checkpoints.map((c) => c.label)).toEqual(['real']);
	});
});

describe('restoreCheckpoint', () => {
	it('reproduces the exact working tree, down to staged vs untracked', async () => {
		write('tracked.txt', 'modified\n');
		write('untracked.txt', 'new file\n');
		write('staged.txt', 'staged\n');
		git('add', 'staged.txt');
		const before = status();

		const created = await createCheckpoint({ cwd: repo }, { label: 'good state' });

		// Diverge: change everything, add a file, delete another.
		write('tracked.txt', 'AGENT WENT WRONG\n');
		fs.rmSync(path.join(repo, 'untracked.txt'));
		write('garbage.txt', 'junk\n');
		git('add', '-A');

		const result = await restoreCheckpoint({ cwd: repo }, created.checkpoint!.id);
		expect(result.success).toBe(true);

		expect(read('tracked.txt')).toBe('modified\n');
		expect(read('untracked.txt')).toBe('new file\n');
		expect(exists('garbage.txt')).toBe(false);
		// The important half: `untracked.txt` comes back UNTRACKED, not staged.
		// Restoring only the snapshot tree would have staged it, because
		// everything in a tree is by definition tracked.
		expect(status()).toEqual(before);
	});

	it('leaves the branch and commit history alone', async () => {
		const created = await createCheckpoint({ cwd: repo });
		write('tracked.txt', 'later work\n');
		git('commit', '-qam', 'later commit');
		const headAfterCommit = git('rev-parse', 'HEAD').trim();

		await restoreCheckpoint({ cwd: repo }, created.checkpoint!.id);

		// A checkpoint restores a TREE. Rewinding the branch too would turn "undo
		// my uncommitted edits" into "throw away my commits".
		expect(git('rev-parse', 'HEAD').trim()).toBe(headAfterCommit);
		expect(git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
	});

	it('takes a safety checkpoint first, so the restore itself is undoable', async () => {
		const created = await createCheckpoint({ cwd: repo }, { label: 'old' });
		write('tracked.txt', 'work I did not mean to discard\n');

		const result = await restoreCheckpoint({ cwd: repo }, created.checkpoint!.id);
		expect(result.safetyCheckpoint).toBeDefined();
		expect(result.safetyCheckpoint!.origin).toBe('pre-restore');
		expect(read('tracked.txt')).toBe('original\n');

		// Undo the restore.
		await restoreCheckpoint({ cwd: repo }, result.safetyCheckpoint!.id);
		expect(read('tracked.txt')).toBe('work I did not mean to discard\n');
	});

	it('does not delete ignored files when the checkpoint did not capture them', async () => {
		// The dangerous case. `git clean -fdx` here would wipe a .env and
		// node_modules the snapshot never held and cannot put back.
		const created = await createCheckpoint({ cwd: repo });
		write('ignored.txt', 'local secret\n');

		await restoreCheckpoint({ cwd: repo }, created.checkpoint!.id);

		expect(exists('ignored.txt')).toBe(true);
		expect(read('ignored.txt')).toBe('local secret\n');
	});

	it('restores ignored files when the checkpoint captured them', async () => {
		write('ignored.txt', 'original secret\n');
		const created = await createCheckpoint({ cwd: repo }, { includeIgnored: true });

		write('ignored.txt', 'clobbered\n');
		const result = await restoreCheckpoint({ cwd: repo }, created.checkpoint!.id);

		expect(result.success).toBe(true);
		expect(read('ignored.txt')).toBe('original secret\n');
		// And it must land back as ignored, not as a tracked file the user now
		// has to un-stage.
		expect(status()).toEqual([]);
	});

	it('works from a subdirectory', async () => {
		// `git clean` is cwd-relative too: restoring from `sub/` would leave every
		// file added outside it in place, and report a complete restore.
		const created = await createCheckpoint({ cwd: repo });
		write('sub/keep.txt', 'placeholder\n');
		write('top-level-garbage.txt', 'junk\n');

		await restoreCheckpoint({ cwd: path.join(repo, 'sub') }, created.checkpoint!.id);

		expect(exists('top-level-garbage.txt')).toBe(false);
	});

	it('refuses an unknown id', async () => {
		const result = await restoreCheckpoint({ cwd: repo }, '20260101T000000Z-nope12');
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/not found/i);
	});

	it('refuses an id that is not a legal ref segment', async () => {
		const result = await restoreCheckpoint({ cwd: repo }, '../../../etc/passwd');
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/invalid/i);
	});
});

describe('deleteCheckpoint', () => {
	it('removes the ref without touching the working tree', async () => {
		write('tracked.txt', 'in progress\n');
		const created = await createCheckpoint({ cwd: repo });

		const result = await deleteCheckpoint({ cwd: repo }, created.checkpoint!.id);
		expect(result.success).toBe(true);

		expect((await listCheckpoints({ cwd: repo })).checkpoints).toEqual([]);
		expect(read('tracked.txt')).toBe('in progress\n');
	});

	it('refuses an unknown id', async () => {
		const result = await deleteCheckpoint({ cwd: repo }, '20260101T000000Z-nope12');
		expect(result.success).toBe(false);
	});
});

describe('getCheckpoint', () => {
	it('finds a checkpoint by id', async () => {
		const created = await createCheckpoint({ cwd: repo }, { label: 'findme' });
		const found = await getCheckpoint({ cwd: repo }, created.checkpoint!.id);
		expect(found?.label).toBe('findme');
	});

	it('returns null for an unknown id', async () => {
		expect(await getCheckpoint({ cwd: repo }, '20260101T000000Z-nope12')).toBeNull();
	});
});
