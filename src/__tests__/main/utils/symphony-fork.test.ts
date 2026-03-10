import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecResult } from '../../../main/utils/execFile';

const mockExecFileNoThrow = vi.fn<(...args: unknown[]) => Promise<ExecResult>>();

vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: (...args: unknown[]) => mockExecFileNoThrow(...args),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../main/agents/path-prober', () => ({
	getExpandedEnv: () => ({ PATH: '/usr/bin' }),
}));

import { ensureForkSetup } from '../../../main/utils/symphony-fork';

function ok(stdout: string): ExecResult {
	return { stdout, stderr: '', exitCode: 0 };
}

function fail(stderr: string, exitCode: number | string = 1): ExecResult {
	return { stdout: '', stderr, exitCode };
}

describe('ensureForkSetup', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns error when gh is not authenticated', async () => {
		mockExecFileNoThrow.mockResolvedValueOnce(fail('not logged in'));

		const result = await ensureForkSetup('/tmp/repo', 'owner/repo');

		expect(result).toEqual({ isFork: false, error: 'GitHub CLI not authenticated' });
	});

	it('returns isFork: false when user owns the repo', async () => {
		mockExecFileNoThrow.mockResolvedValueOnce(ok('chris\n'));

		const result = await ensureForkSetup('/tmp/repo', 'chris/repo');

		expect(result).toEqual({ isFork: false });
		expect(mockExecFileNoThrow).toHaveBeenCalledTimes(1);
	});

	it('returns isFork: false when user has push access', async () => {
		mockExecFileNoThrow
			.mockResolvedValueOnce(ok('chris\n')) // gh api user
			.mockResolvedValueOnce(ok('true\n')); // permissions.push

		const result = await ensureForkSetup('/tmp/repo', 'owner/repo');

		expect(result).toEqual({ isFork: false });
	});

	it('forks and reconfigures remotes when no push access', async () => {
		mockExecFileNoThrow
			.mockResolvedValueOnce(ok('chris\n')) // gh api user
			.mockResolvedValueOnce(ok('false\n')) // permissions.push
			.mockResolvedValueOnce(ok('')) // gh repo fork
			.mockResolvedValueOnce(ok('https://github.com/chris/repo.git\n')) // clone url
			.mockResolvedValueOnce(ok('')) // git remote rename
			.mockResolvedValueOnce(ok('')) // git remote add
			.mockResolvedValueOnce(ok('')); // git remote set-head origin -a

		const result = await ensureForkSetup('/tmp/repo', 'owner/repo');

		expect(result).toEqual({ isFork: true, forkSlug: 'chris/repo' });

		// Verify fork command
		expect(mockExecFileNoThrow).toHaveBeenCalledWith(
			'gh',
			['repo', 'fork', 'owner/repo', '--clone=false'],
			undefined,
			expect.any(Object)
		);

		// Verify remote rename
		expect(mockExecFileNoThrow).toHaveBeenCalledWith(
			'git',
			['remote', 'rename', 'origin', 'upstream'],
			'/tmp/repo'
		);

		// Verify remote add
		expect(mockExecFileNoThrow).toHaveBeenCalledWith(
			'git',
			['remote', 'add', 'origin', 'https://github.com/chris/repo.git'],
			'/tmp/repo'
		);

		// Verify set-head for correct default branch resolution
		expect(mockExecFileNoThrow).toHaveBeenCalledWith(
			'git',
			['remote', 'set-head', 'origin', '-a'],
			'/tmp/repo'
		);
	});

	it('handles fork already existing', async () => {
		mockExecFileNoThrow
			.mockResolvedValueOnce(ok('chris\n')) // gh api user
			.mockResolvedValueOnce(ok('false\n')) // permissions.push
			.mockResolvedValueOnce(fail('repo already exists', 1)) // gh repo fork - already exists
			.mockResolvedValueOnce(ok('https://github.com/chris/repo.git\n')) // clone url
			.mockResolvedValueOnce(ok('')) // git remote rename
			.mockResolvedValueOnce(ok('')) // git remote add
			.mockResolvedValueOnce(ok('')); // git remote set-head origin -a

		const result = await ensureForkSetup('/tmp/repo', 'owner/repo');

		expect(result).toEqual({ isFork: true, forkSlug: 'chris/repo' });
	});

	it('returns error when fork fails for non-existing reason', async () => {
		mockExecFileNoThrow
			.mockResolvedValueOnce(ok('chris\n')) // gh api user
			.mockResolvedValueOnce(ok('false\n')) // permissions.push
			.mockResolvedValueOnce(fail('permission denied', 1)); // gh repo fork

		const result = await ensureForkSetup('/tmp/repo', 'owner/repo');

		expect(result.isFork).toBe(false);
		expect(result.error).toContain('permission denied');
	});

	it('falls back to set-url when remote rename fails', async () => {
		mockExecFileNoThrow
			.mockResolvedValueOnce(ok('chris\n')) // gh api user
			.mockResolvedValueOnce(ok('false\n')) // permissions.push
			.mockResolvedValueOnce(ok('')) // gh repo fork
			.mockResolvedValueOnce(ok('https://github.com/chris/repo.git\n')) // clone url
			.mockResolvedValueOnce(fail('upstream already exists')) // remote rename fails
			.mockResolvedValueOnce(ok('')) // git remote set-url (fallback)
			.mockResolvedValueOnce(ok('')); // git remote set-head origin -a

		const result = await ensureForkSetup('/tmp/repo', 'owner/repo');

		expect(result).toEqual({ isFork: true, forkSlug: 'chris/repo' });

		// Verify fallback to set-url
		expect(mockExecFileNoThrow).toHaveBeenCalledWith(
			'git',
			['remote', 'set-url', 'origin', 'https://github.com/chris/repo.git'],
			'/tmp/repo'
		);
	});

	it('returns error when both remote rename and set-url fail', async () => {
		mockExecFileNoThrow
			.mockResolvedValueOnce(ok('chris\n')) // gh api user
			.mockResolvedValueOnce(ok('false\n')) // permissions.push
			.mockResolvedValueOnce(ok('')) // gh repo fork
			.mockResolvedValueOnce(ok('https://github.com/chris/repo.git\n')) // clone url
			.mockResolvedValueOnce(fail('rename error')) // remote rename fails
			.mockResolvedValueOnce(fail('set-url error')); // set-url also fails

		const result = await ensureForkSetup('/tmp/repo', 'owner/repo');

		expect(result.isFork).toBe(false);
		expect(result.error).toContain('set-url error');
	});

	it('returns error when getting fork clone URL fails', async () => {
		mockExecFileNoThrow
			.mockResolvedValueOnce(ok('chris\n')) // gh api user
			.mockResolvedValueOnce(ok('false\n')) // permissions.push
			.mockResolvedValueOnce(ok('')) // gh repo fork
			.mockResolvedValueOnce(fail('not found')); // clone url fails

		const result = await ensureForkSetup('/tmp/repo', 'owner/repo');

		expect(result.isFork).toBe(false);
		expect(result.error).toContain('Failed to get fork clone URL');
	});
});
