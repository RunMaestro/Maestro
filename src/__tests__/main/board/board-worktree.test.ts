/**
 * @file board-worktree.test.ts
 * @description Board Phase 4 worktree provisioning. Runs against a REAL temp
 * git repository (no mocks) so the reuse-on-second-call and sibling-path rules
 * are verified against actual `git worktree` behavior:
 *   - first call creates the checkout on the conventional branch;
 *   - a second call for the same card reuses it (retries continue the work);
 *   - a card with no branch fails loudly instead of falling back to the repo;
 *   - the naming helpers agree with what lands on disk.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ensureCardWorktree } from '../../../main/board/board-worktree';
import {
	boardCardBranchName,
	boardWorktreePath,
	buildCardWorktreeRef,
} from '../../../shared/board/worktree';

const BOARD_ID = '1a2b3c4d-0000-0000-0000-000000000000';
const CARD_ID = '5e6f7a8b-0000-0000-0000-000000000000';

let tmpRoot: string;
let projectRoot: string;

function git(args: string[], cwd: string): void {
	execFileSync('git', args, { cwd, stdio: 'ignore' });
}

beforeAll(() => {
	// realpath: macOS hands out /var/... symlinks for tmpdir, which git resolves
	// to /private/var/... and would break the path comparisons below.
	tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-board-wt-')));
	projectRoot = path.join(tmpRoot, 'project');
	fs.mkdirSync(projectRoot);
	git(['init', '-b', 'main'], projectRoot);
	git(['config', 'user.email', 'test@example.com'], projectRoot);
	git(['config', 'user.name', 'Test'], projectRoot);
	fs.writeFileSync(path.join(projectRoot, 'README.md'), '# test\n');
	git(['add', '.'], projectRoot);
	git(['commit', '-m', 'init'], projectRoot);
});

afterAll(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('board worktree naming', () => {
	it('derives branch board/<board>/<card> from the first eight id characters', () => {
		expect(boardCardBranchName(BOARD_ID, CARD_ID)).toBe('board/1a2b3c4d/5e6f7a8b');
	});

	it('puts the checkout in a worktrees folder BESIDE the project, never inside it', () => {
		const p = boardWorktreePath('/repos/project', 'board/aaaa/bbbb');
		expect(p).toBe('/repos/worktrees/board/aaaa/bbbb');
		expect(p.startsWith('/repos/project')).toBe(false);
	});

	it('builds a ref whose path matches its branch', () => {
		const ref = buildCardWorktreeRef('/repos/project', BOARD_ID, CARD_ID);
		expect(ref).toEqual({
			branch: 'board/1a2b3c4d/5e6f7a8b',
			path: '/repos/worktrees/board/1a2b3c4d/5e6f7a8b',
		});
	});
});

describe('ensureCardWorktree', () => {
	it('creates the checkout on the card branch, then reuses it on the next attempt', async () => {
		const ref = buildCardWorktreeRef(projectRoot, BOARD_ID, CARD_ID);

		const first = await ensureCardWorktree(projectRoot, ref);
		expect(first).toEqual({ ok: true, path: ref.path, branch: ref.branch });
		expect(fs.existsSync(path.join(ref.path, 'README.md'))).toBe(true);
		const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
			cwd: ref.path,
			encoding: 'utf8',
		}).trim();
		expect(head).toBe(ref.branch);

		// A retry must land in the SAME tree so it continues the work.
		fs.writeFileSync(path.join(ref.path, 'in-progress.txt'), 'partial\n');
		const second = await ensureCardWorktree(projectRoot, ref);
		expect(second).toEqual({ ok: true, path: ref.path, branch: ref.branch });
		expect(fs.existsSync(path.join(ref.path, 'in-progress.txt'))).toBe(true);
	});

	it('derives the conventional path when the ref carries only a branch', async () => {
		const branch = 'board/1a2b3c4d/cccccccc';
		const result = await ensureCardWorktree(projectRoot, { path: '', branch });
		expect(result).toEqual({ ok: true, path: boardWorktreePath(projectRoot, branch), branch });
	});

	it('fails with a readable reason when the card worktree has no branch', async () => {
		const result = await ensureCardWorktree(projectRoot, { path: '/tmp/whatever' });
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toMatch(/missing a branch/i);
	});

	it('refuses a checkout nested inside the main repository', async () => {
		const result = await ensureCardWorktree(projectRoot, {
			path: path.join(projectRoot, '.maestro', 'worktrees', CARD_ID),
			branch: 'board/1a2b3c4d/dddddddd',
		});
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.reason).toMatch(/inside the main repository/i);
	});
});
