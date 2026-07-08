import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	cancelContribution,
	finalizeContribution,
	startContribution,
} from '../../main/services/symphony-runner';
import { execFileNoThrow } from '../../main/utils/execFile';
import { clearGhCache } from '../../main/utils/cliDetection';
import { ensureForkSetup } from '../../main/utils/symphony-fork';
import { PLAYBOOKS_DIR } from '../../shared/maestro-paths';
import type { DocumentReference } from '../../shared/symphony-types';

const state = vi.hoisted(() => ({
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

vi.mock('../../main/utils/logger', () => ({
	logger: state.logger,
}));

vi.mock('../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

vi.mock('../../main/utils/symphony-fork', () => ({
	ensureForkSetup: vi.fn(),
}));

function ok(stdout = '') {
	return { stdout, stderr: '', exitCode: 0 };
}

function fail(stderr: string, exitCode = 1) {
	return { stdout: '', stderr, exitCode };
}

function queueStartWorkflow(prUrl = 'https://github.com/owner/repo/pull/42') {
	vi.mocked(execFileNoThrow)
		.mockResolvedValueOnce(ok())
		.mockResolvedValueOnce(ok())
		.mockResolvedValueOnce(ok())
		.mockResolvedValueOnce(ok())
		.mockResolvedValueOnce(ok())
		.mockResolvedValueOnce(ok())
		.mockResolvedValueOnce(ok())
		.mockResolvedValueOnce(ok(prUrl));
}

function contributionOptions(localPath: string, documents: DocumentReference[] = []) {
	return {
		contributionId: 'contrib-1',
		repoSlug: 'owner/repo',
		repoUrl: 'https://github.com/owner/repo.git',
		issueNumber: 123,
		issueTitle: 'Fix the thing',
		documentPaths: documents,
		localPath,
		branchName: 'symphony/issue-123-fix',
	};
}

describe('symphony runner integration', () => {
	let tempRoot: string;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		vi.clearAllMocks();
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-symphony-runner-'));
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		clearGhCache();
		vi.mocked(ensureForkSetup).mockResolvedValue({ isFork: false });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		fsSync.rmSync(tempRoot, { recursive: true, force: true });
	});

	it('starts a direct contribution and prepares local plus external Auto Run documents', async () => {
		const localPath = path.join(tempRoot, 'repo');
		await fs.mkdir(path.join(localPath, 'docs'), { recursive: true });
		await fs.writeFile(path.join(localPath, 'docs', 'task.md'), '# Local task\n', 'utf-8');
		const externalBody = Buffer.from('# External task\n');
		fetchMock.mockResolvedValue({
			ok: true,
			arrayBuffer: vi.fn(async () =>
				externalBody.buffer.slice(
					externalBody.byteOffset,
					externalBody.byteOffset + externalBody.byteLength
				)
			),
		});
		queueStartWorkflow();
		const statuses: string[] = [];

		const result = await startContribution({
			...contributionOptions(localPath, [
				{ name: 'task.md', path: 'docs/task.md', isExternal: false },
				{
					name: 'external.md',
					path: 'https://example.test/external.md',
					isExternal: true,
				},
			]),
			onStatusChange: (status) => statuses.push(status),
		});

		expect(result).toEqual({
			success: true,
			draftPrUrl: 'https://github.com/owner/repo/pull/42',
			draftPrNumber: 42,
			autoRunPath: path.posix.join(localPath, PLAYBOOKS_DIR),
			isFork: false,
			forkSlug: undefined,
		});
		expect(statuses).toEqual(['cloning', 'setting_up', 'running']);
		expect(execFileNoThrow).toHaveBeenNthCalledWith(1, 'git', [
			'clone',
			'--depth=1',
			'https://github.com/owner/repo.git',
			localPath,
		]);
		expect(execFileNoThrow).toHaveBeenNthCalledWith(
			2,
			'git',
			['checkout', '-b', 'symphony/issue-123-fix'],
			localPath
		);
		expect(execFileNoThrow).toHaveBeenCalledWith(
			'git',
			['commit', '--allow-empty', '-m', '[Symphony] Start contribution for #123'],
			localPath
		);
		expect(execFileNoThrow).toHaveBeenCalledWith(
			'git',
			['push', '-u', 'origin', 'symphony/issue-123-fix'],
			localPath
		);
		expect(execFileNoThrow).toHaveBeenCalledWith(
			'gh',
			expect.arrayContaining([
				'pr',
				'create',
				'--draft',
				'--title',
				'[WIP] Symphony: Fix the thing',
			]),
			localPath
		);
		await expect(
			fs.readFile(path.join(localPath, PLAYBOOKS_DIR, 'task.md'), 'utf-8')
		).resolves.toBe('# Local task\n');
		await expect(
			fs.readFile(path.join(localPath, PLAYBOOKS_DIR, 'external.md'), 'utf-8')
		).resolves.toContain('# External task');
	});

	it('creates cross-fork draft PRs with upstream repo and fork owner head arguments', async () => {
		const localPath = path.join(tempRoot, 'fork-repo');
		vi.mocked(ensureForkSetup).mockResolvedValue({
			isFork: true,
			forkSlug: 'alice/repo',
		});
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok('symphony/issue-123-fix\n'))
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok('https://github.com/owner/repo/pull/43'));

		const result = await startContribution(contributionOptions(localPath));

		expect(result).toMatchObject({
			success: true,
			draftPrNumber: 43,
			isFork: true,
			forkSlug: 'alice/repo',
		});
		expect(execFileNoThrow).toHaveBeenCalledWith(
			'gh',
			expect.arrayContaining(['--repo', 'owner/repo', '--head', 'alice:symphony/issue-123-fix']),
			localPath
		);
	});

	it('cleans up local repositories on start failures after clone succeeds', async () => {
		const localPath = path.join(tempRoot, 'failed-repo');
		await fs.mkdir(localPath, { recursive: true });
		await fs.writeFile(path.join(localPath, 'leftover.txt'), 'leftover', 'utf-8');
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(fail('branch exists', 128));

		const branchFailure = await startContribution(contributionOptions(localPath));

		expect(branchFailure).toEqual({ success: false, error: 'Branch creation failed' });
		await expect(fs.access(localPath)).rejects.toThrow();

		const forkFailurePath = path.join(tempRoot, 'fork-failure');
		vi.mocked(execFileNoThrow).mockReset();
		vi.mocked(execFileNoThrow).mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok());
		vi.mocked(ensureForkSetup).mockResolvedValueOnce({
			isFork: false,
			error: 'gh auth missing',
		});

		const forkFailure = await startContribution(contributionOptions(forkFailurePath));

		expect(forkFailure).toEqual({
			success: false,
			error: 'Fork setup failed: gh auth missing',
		});
	});

	it('reports clone, commit, push, draft PR, and cross-fork branch failures', async () => {
		const cloneFailurePath = path.join(tempRoot, 'clone-failure');
		vi.mocked(execFileNoThrow).mockResolvedValueOnce(fail('not found', 128));
		await expect(startContribution(contributionOptions(cloneFailurePath))).resolves.toEqual({
			success: false,
			error: 'Clone failed',
		});

		const commitFailurePath = path.join(tempRoot, 'commit-failure');
		vi.mocked(execFileNoThrow).mockReset();
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(fail('commit failed'));
		await expect(startContribution(contributionOptions(commitFailurePath))).resolves.toEqual({
			success: false,
			error: 'Empty commit failed',
		});

		const pushFailurePath = path.join(tempRoot, 'push-failure');
		vi.mocked(execFileNoThrow).mockReset();
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(fail('push failed'));
		await expect(startContribution(contributionOptions(pushFailurePath))).resolves.toEqual({
			success: false,
			error: 'Push failed',
		});

		const prFailurePath = path.join(tempRoot, 'pr-failure');
		vi.mocked(execFileNoThrow).mockReset();
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(fail('gh failed'));
		await expect(startContribution(contributionOptions(prFailurePath))).resolves.toEqual({
			success: false,
			error: 'PR creation failed: gh failed',
		});

		const branchLookupPath = path.join(tempRoot, 'branch-lookup-failure');
		vi.mocked(ensureForkSetup).mockResolvedValueOnce({
			isFork: true,
			forkSlug: 'alice/repo',
		});
		vi.mocked(execFileNoThrow).mockReset();
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(fail('no branch'));
		await expect(startContribution(contributionOptions(branchLookupPath))).resolves.toEqual({
			success: false,
			error: 'Failed to determine current branch name',
		});

		const thrownFailurePath = path.join(tempRoot, 'thrown-failure');
		vi.mocked(execFileNoThrow).mockReset();
		vi.mocked(execFileNoThrow).mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok());
		vi.mocked(ensureForkSetup).mockRejectedValueOnce(new Error('fork exploded'));
		await expect(startContribution(contributionOptions(thrownFailurePath))).resolves.toEqual({
			success: false,
			error: 'fork exploded',
		});
	});

	it('continues start workflow when git config or document setup is partially unavailable', async () => {
		const localPath = path.join(tempRoot, 'warnings-repo');
		fetchMock
			.mockResolvedValueOnce({ ok: false, status: 404 })
			.mockRejectedValueOnce(new Error('network down'));
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(fail('email config failed'))
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok('not-a-pr-url'));

		const result = await startContribution(
			contributionOptions(localPath, [
				{ name: 'missing.md', path: 'docs/missing.md', isExternal: false },
				{ name: 'external.md', path: 'https://example.test/missing.md', isExternal: true },
				{ name: 'offline.md', path: 'https://example.test/offline.md', isExternal: true },
			])
		);

		expect(result).toMatchObject({
			success: true,
			draftPrUrl: 'not-a-pr-url',
			draftPrNumber: undefined,
			autoRunPath: path.posix.join(localPath, PLAYBOOKS_DIR),
		});
		expect(state.logger.warn).toHaveBeenCalledWith(
			'Failed to set git user.email',
			'[SymphonyRunner]',
			expect.objectContaining({ error: 'email config failed' })
		);
		expect(state.logger.warn).toHaveBeenCalledWith(
			'Failed to copy document',
			'[SymphonyRunner]',
			expect.objectContaining({ name: 'missing.md' })
		);
		expect(state.logger.error).toHaveBeenCalledWith('Failed to download file', '[SymphonyRunner]', {
			url: 'https://example.test/missing.md',
			status: 404,
		});
		expect(state.logger.error).toHaveBeenCalledWith(
			'Error downloading file',
			'[SymphonyRunner]',
			expect.objectContaining({ url: 'https://example.test/offline.md' })
		);
		expect(state.logger.warn).toHaveBeenCalledWith(
			'Failed to download document, skipping',
			'[SymphonyRunner]',
			{
				name: 'external.md',
			}
		);
		expect(state.logger.warn).toHaveBeenCalledWith(
			'Failed to download document, skipping',
			'[SymphonyRunner]',
			{
				name: 'offline.md',
			}
		);
	});

	it('finalizes contributions and reports commit, push, and ready failures', async () => {
		const localPath = path.join(tempRoot, 'finalize-repo');
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce({ stdout: '', stderr: 'nothing to commit', exitCode: 1 })
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok('https://github.com/owner/repo/pull/44\n'));

		const result = await finalizeContribution(localPath, 44, 123, 'Fix the thing', 'owner/repo');

		expect(result).toEqual({ success: true, prUrl: 'https://github.com/owner/repo/pull/44' });
		expect(execFileNoThrow).toHaveBeenCalledWith(
			'gh',
			['pr', 'ready', '44', '--repo', 'owner/repo'],
			localPath
		);
		expect(execFileNoThrow).toHaveBeenCalledWith(
			'gh',
			expect.arrayContaining(['pr', 'edit', '44', '--repo', 'owner/repo']),
			localPath
		);

		vi.mocked(execFileNoThrow).mockReset();
		clearGhCache();
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(fail('commit failed'));
		await expect(finalizeContribution(localPath, 44, 123, 'Fix')).resolves.toEqual({
			success: false,
			error: 'Commit failed: commit failed',
		});

		vi.mocked(execFileNoThrow).mockReset();
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(fail('push failed'));
		await expect(finalizeContribution(localPath, 44, 123, 'Fix')).resolves.toEqual({
			success: false,
			error: 'Push failed: push failed',
		});

		vi.mocked(execFileNoThrow).mockReset();
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(ok())
			.mockResolvedValueOnce(fail('ready failed'));
		await expect(finalizeContribution(localPath, 44, 123, 'Fix')).resolves.toEqual({
			success: false,
			error: 'Failed to mark PR ready: ready failed',
		});
	});

	it('cancels contributions with local cleanup, cross-fork repo routing, and close failure errors', async () => {
		const localPath = path.join(tempRoot, 'cancel-repo');
		await fs.mkdir(localPath, { recursive: true });
		vi.mocked(execFileNoThrow).mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok());

		await expect(cancelContribution(localPath, 44)).resolves.toEqual({ success: true });
		expect(execFileNoThrow).toHaveBeenCalledWith(
			'gh',
			['pr', 'close', '44', '--delete-branch'],
			localPath
		);
		await expect(fs.access(localPath)).rejects.toThrow();

		vi.mocked(execFileNoThrow).mockReset();
		clearGhCache();
		vi.mocked(execFileNoThrow).mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok());
		await expect(cancelContribution(localPath, 45, false, 'owner/repo')).resolves.toEqual({
			success: true,
		});
		expect(execFileNoThrow).toHaveBeenCalledWith(
			'gh',
			['pr', 'close', '45', '--repo', 'owner/repo'],
			localPath
		);

		vi.mocked(execFileNoThrow).mockReset();
		clearGhCache();
		vi.mocked(execFileNoThrow).mockResolvedValueOnce(ok()).mockResolvedValueOnce({
			stdout: 'close stdout',
			stderr: '',
			exitCode: 1,
		});
		await expect(cancelContribution(localPath, 46)).resolves.toEqual({
			success: false,
			error: 'Failed to close PR #46: close stdout',
		});
	});
});
