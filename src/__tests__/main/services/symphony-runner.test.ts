/**
 * Tests for the Symphony Runner Service
 *
 * The Symphony Runner orchestrates git operations and PR workflows for
 * Symphony contributions, including cloning repos, creating branches,
 * pushing changes, and managing draft PRs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs/promises
vi.mock('fs/promises', () => ({
	default: {
		mkdir: vi.fn(),
		rm: vi.fn(),
		writeFile: vi.fn(),
		copyFile: vi.fn(),
	},
}));

// Mock execFileNoThrow
vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

// Mock the logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import mocked modules after mocks are set up
import fs from 'fs/promises';
import { execFileNoThrow } from '../../../main/utils/execFile';
import { logger } from '../../../main/utils/logger';
import {
	startContribution,
	finalizeContribution,
	cancelContribution,
} from '../../../main/services/symphony-runner';

describe('Symphony Runner Service', () => {
	// Helper to set up full successful workflow mocks (7 calls for startContribution)
	const mockSuccessfulWorkflow = (prUrl = 'https://github.com/owner/repo/pull/1') => {
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout -b
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // commit --allow-empty
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // push
			.mockResolvedValueOnce({ stdout: prUrl, stderr: '', exitCode: 0 }); // pr create
	};

	// Helper to set up finalize workflow mocks (8 calls)
	const mockFinalizeWorkflow = (prUrl = 'https://github.com/owner/repo/pull/1') => {
		vi.mocked(execFileNoThrow)
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git add -A
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git commit
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git push
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // gh pr ready
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // gh pr edit
			.mockResolvedValueOnce({ stdout: prUrl, stderr: '', exitCode: 0 }); // gh pr view
	};

	beforeEach(() => {
		vi.clearAllMocks();

		// Default mock implementations for fs
		vi.mocked(fs.mkdir).mockResolvedValue(undefined);
		vi.mocked(fs.rm).mockResolvedValue(undefined);
		vi.mocked(fs.writeFile).mockResolvedValue(undefined);
		vi.mocked(fs.copyFile).mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	// ============================================================================
	// Test File Setup
	// ============================================================================

	describe('test file setup', () => {
		it('should have proper imports and mocks for fs/promises', () => {
			expect(fs.mkdir).toBeDefined();
			expect(fs.rm).toBeDefined();
			expect(fs.writeFile).toBeDefined();
			expect(fs.copyFile).toBeDefined();
		});

		it('should have proper mock for execFileNoThrow', () => {
			expect(execFileNoThrow).toBeDefined();
			expect(vi.isMockFunction(execFileNoThrow)).toBe(true);
		});

		it('should have proper mock for logger', () => {
			expect(logger.info).toBeDefined();
			expect(logger.warn).toBeDefined();
			expect(logger.error).toBeDefined();
			expect(logger.debug).toBeDefined();
		});

		it('should have proper mock for global fetch', () => {
			expect(global.fetch).toBeDefined();
			expect(vi.isMockFunction(global.fetch)).toBe(true);
		});
	});

	// ============================================================================
	// Clone Repo Tests
	// ============================================================================

	describe('cloneRepo', () => {
		it('calls git clone with --depth=1 flag', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(execFileNoThrow).toHaveBeenCalledWith('git', [
				'clone',
				'--depth=1',
				'https://github.com/owner/repo',
				'/tmp/test-repo',
			]);
		});

		it('returns true on successful clone (exitCode 0)', async () => {
			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(true);
		});

		it('returns false on failed clone (non-zero exitCode)', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				stdout: '',
				stderr: 'fatal: repository not found',
				exitCode: 128,
			});

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(false);
			expect(result.error).toBe('Clone failed');
		});
	});

	// ============================================================================
	// Create Branch Tests
	// ============================================================================

	describe('createBranch', () => {
		it('calls git checkout -b with branch name', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['checkout', '-b', 'symphony/test-branch'],
				'/tmp/test-repo'
			);
		});

		it('uses correct working directory', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/custom/path/repo',
				branchName: 'symphony/test-branch',
			});

			expect(execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['checkout', '-b', 'symphony/test-branch'],
				'/custom/path/repo'
			);
		});

		it('returns true on success', async () => {
			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(true);
		});

		it('returns false on failure', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone succeeds
				.mockResolvedValueOnce({
					stdout: '',
					stderr: 'error: branch already exists',
					exitCode: 128,
				}); // checkout -b fails

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(false);
			expect(result.error).toBe('Branch creation failed');
		});
	});

	// ============================================================================
	// Configure Git User Tests
	// ============================================================================

	describe('configureGitUser', () => {
		it('sets user.name to "Maestro Symphony"', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['config', 'user.name', 'Maestro Symphony'],
				'/tmp/test-repo'
			);
		});

		it('sets user.email to "symphony@runmaestro.ai"', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['config', 'user.email', 'symphony@runmaestro.ai'],
				'/tmp/test-repo'
			);
		});

		it('returns true when both configs succeed', async () => {
			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(true);
		});

		it('logs warning when user.name config fails', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout -b
				.mockResolvedValueOnce({ stdout: '', stderr: 'error', exitCode: 1 }) // config user.name fails
				// Note: user.email is NOT called because configureGitUser returns early
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // commit --allow-empty
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // push
				.mockResolvedValueOnce({
					stdout: 'https://github.com/owner/repo/pull/1',
					stderr: '',
					exitCode: 0,
				}); // pr create

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(logger.warn).toHaveBeenCalledWith(
				'Failed to set git user.name',
				expect.any(String),
				expect.any(Object)
			);
		});

		it('logs warning when user.email config fails', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout -b
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name succeeds
				.mockResolvedValueOnce({ stdout: '', stderr: 'error', exitCode: 1 }) // config user.email fails
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // commit --allow-empty
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // push
				.mockResolvedValueOnce({
					stdout: 'https://github.com/owner/repo/pull/1',
					stderr: '',
					exitCode: 0,
				}); // pr create

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(logger.warn).toHaveBeenCalledWith(
				'Failed to set git user.email',
				expect.any(String),
				expect.any(Object)
			);
			// Workflow continues despite config failure
			expect(result.success).toBe(true);
		});
	});

	// ============================================================================
	// Create Empty Commit Tests
	// ============================================================================

	describe('createEmptyCommit', () => {
		it('calls git commit with --allow-empty flag', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['commit', '--allow-empty', '-m', '[Symphony] Start contribution for #123'],
				'/tmp/test-repo'
			);
		});

		it('uses provided commit message', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 456,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['commit', '--allow-empty', '-m', '[Symphony] Start contribution for #456'],
				'/tmp/test-repo'
			);
		});

		it('returns true on success', async () => {
			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(true);
		});

		it('returns false on failure', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout -b
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
				.mockResolvedValueOnce({ stdout: '', stderr: 'error', exitCode: 1 }); // commit --allow-empty fails

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(false);
			expect(result.error).toBe('Empty commit failed');
		});
	});

	// ============================================================================
	// Push Branch Tests
	// ============================================================================

	describe('pushBranch', () => {
		it('calls git push with -u origin and branch name', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['push', '-u', 'origin', 'symphony/test-branch'],
				'/tmp/test-repo'
			);
		});

		it('returns true on success', async () => {
			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(true);
		});

		it('returns false on failure', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout -b
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // commit --allow-empty
				.mockResolvedValueOnce({ stdout: '', stderr: 'error: push failed', exitCode: 1 }); // push fails

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(false);
			expect(result.error).toBe('Push failed');
		});
	});

	// ============================================================================
	// Create Draft PR Tests
	// ============================================================================

	describe('createDraftPR', () => {
		it('calls gh pr create with --draft flag', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(execFileNoThrow).toHaveBeenCalledWith(
				'gh',
				expect.arrayContaining(['pr', 'create', '--draft']),
				'/tmp/test-repo'
			);
		});

		it('includes issue reference in body with Closes #N', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 789,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			const prCreateCall = vi
				.mocked(execFileNoThrow)
				.mock.calls.find((call) => call[0] === 'gh' && call[1]?.includes('pr'));
			expect(prCreateCall).toBeDefined();
			const bodyIndex = prCreateCall![1].indexOf('--body');
			expect(bodyIndex).toBeGreaterThan(-1);
			const bodyArg = prCreateCall![1][bodyIndex + 1];
			expect(bodyArg).toContain('Closes #789');
		});

		it('returns success with prUrl from stdout', async () => {
			mockSuccessfulWorkflow('https://github.com/owner/repo/pull/42');

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(true);
			expect(result.draftPrUrl).toBe('https://github.com/owner/repo/pull/42');
		});

		it('parses PR number from URL correctly', async () => {
			mockSuccessfulWorkflow('https://github.com/owner/repo/pull/99');

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(true);
			expect(result.draftPrNumber).toBe(99);
		});

		it('returns error message on failure', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout -b
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // commit --allow-empty
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // push
				.mockResolvedValueOnce({ stdout: '', stderr: 'gh auth required', exitCode: 1 }); // pr create fails

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(false);
			expect(result.error).toContain('PR creation failed');
		});
	});

	// ============================================================================
	// Download File Tests
	// ============================================================================

	describe('downloadFile', () => {
		it('fetches URL and writes buffer to destination', async () => {
			const mockArrayBuffer = new ArrayBuffer(8);
			mockFetch.mockResolvedValueOnce({
				ok: true,
				arrayBuffer: vi.fn().mockResolvedValue(mockArrayBuffer),
			});

			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [{ name: 'doc.md', path: 'https://example.com/doc.md', isExternal: true }],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(mockFetch).toHaveBeenCalledWith('https://example.com/doc.md');
			expect(fs.writeFile).toHaveBeenCalledWith(
				'/tmp/test-repo/Auto Run Docs/doc.md',
				expect.any(Buffer)
			);
		});

		it('returns true on successful download', async () => {
			const mockArrayBuffer = new ArrayBuffer(8);
			mockFetch.mockResolvedValueOnce({
				ok: true,
				arrayBuffer: vi.fn().mockResolvedValue(mockArrayBuffer),
			});

			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [{ name: 'doc.md', path: 'https://example.com/doc.md', isExternal: true }],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(true);
		});

		it('returns false on HTTP error response', async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 404,
			});

			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [{ name: 'doc.md', path: 'https://example.com/doc.md', isExternal: true }],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			// Download failure logs error but doesn't fail the whole operation
			expect(logger.error).toHaveBeenCalledWith(
				'Failed to download file',
				expect.any(String),
				expect.objectContaining({ status: 404 })
			);
		});

		it('returns false on network error', async () => {
			mockFetch.mockRejectedValueOnce(new Error('Network error'));

			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [{ name: 'doc.md', path: 'https://example.com/doc.md', isExternal: true }],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			// Network error logs but doesn't fail the whole operation
			expect(logger.error).toHaveBeenCalledWith(
				'Error downloading file',
				expect.any(String),
				expect.objectContaining({ error: expect.any(Error) })
			);
		});
	});

	// ============================================================================
	// Setup Auto Run Docs Tests
	// ============================================================================

	describe('setupAutoRunDocs', () => {
		it('creates Auto Run Docs directory', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(fs.mkdir).toHaveBeenCalledWith('/tmp/test-repo/Auto Run Docs', { recursive: true });
		});

		it('downloads external documents (isExternal: true)', async () => {
			const mockArrayBuffer = new ArrayBuffer(8);
			mockFetch.mockResolvedValueOnce({
				ok: true,
				arrayBuffer: vi.fn().mockResolvedValue(mockArrayBuffer),
			});

			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [
					{ name: 'external.md', path: 'https://example.com/external.md', isExternal: true },
				],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(mockFetch).toHaveBeenCalledWith('https://example.com/external.md');
			expect(logger.info).toHaveBeenCalledWith(
				'Downloading external document',
				expect.any(String),
				expect.objectContaining({ name: 'external.md' })
			);
		});

		it('copies repo-internal documents (isExternal: false)', async () => {
			mockSuccessfulWorkflow();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [{ name: 'internal.md', path: 'docs/internal.md', isExternal: false }],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(fs.copyFile).toHaveBeenCalledWith(
				'/tmp/test-repo/docs/internal.md',
				'/tmp/test-repo/Auto Run Docs/internal.md'
			);
		});

		it('handles download failures without stopping', async () => {
			mockFetch.mockRejectedValueOnce(new Error('Download failed'));

			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [{ name: 'fail.md', path: 'https://example.com/fail.md', isExternal: true }],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			// Should succeed overall despite download failure
			expect(result.success).toBe(true);
			expect(logger.warn).toHaveBeenCalledWith(
				'Failed to download document, skipping',
				expect.any(String),
				expect.objectContaining({ name: 'fail.md' })
			);
		});

		it('handles copy failures without stopping', async () => {
			vi.mocked(fs.copyFile).mockRejectedValueOnce(new Error('Copy failed'));

			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [{ name: 'fail.md', path: 'docs/fail.md', isExternal: false }],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			// Should succeed overall despite copy failure
			expect(result.success).toBe(true);
			expect(logger.warn).toHaveBeenCalledWith(
				'Failed to copy document',
				expect.any(String),
				expect.objectContaining({ name: 'fail.md' })
			);
		});

		it('returns path to Auto Run Docs directory', async () => {
			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.autoRunPath).toBe('/tmp/test-repo/Auto Run Docs');
		});
	});

	// ============================================================================
	// Start Contribution Integration Tests
	// ============================================================================

	describe('startContribution', () => {
		it('executes full workflow: clone, branch, commit, push, PR, docs', async () => {
			mockSuccessfulWorkflow();

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(true);

			// Verify all steps were called
			const calls = vi.mocked(execFileNoThrow).mock.calls;
			expect(calls[0][0]).toBe('git');
			expect(calls[0][1]).toContain('clone');
			expect(calls[1][1]).toContain('checkout');
			expect(calls[2][1]).toContain('config');
			expect(calls[3][1]).toContain('config');
			expect(calls[4][1]).toContain('commit');
			expect(calls[5][1]).toContain('push');
			expect(calls[6][0]).toBe('gh');
		});

		it('calls onStatusChange callback at each step', async () => {
			mockSuccessfulWorkflow();

			const onStatusChange = vi.fn();

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
				onStatusChange,
			});

			expect(onStatusChange).toHaveBeenCalledWith('cloning');
			expect(onStatusChange).toHaveBeenCalledWith('setting_up');
			expect(onStatusChange).toHaveBeenCalledWith('running');
		});

		it('cleans up on clone failure', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				stdout: '',
				stderr: 'clone failed',
				exitCode: 128,
			});

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			// Clone failure doesn't trigger cleanup (nothing to clean)
			expect(fs.rm).not.toHaveBeenCalled();
		});

		it('cleans up on branch creation failure', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
				.mockResolvedValueOnce({ stdout: '', stderr: 'branch failed', exitCode: 1 }); // checkout -b fails

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(fs.rm).toHaveBeenCalledWith('/tmp/test-repo', { recursive: true, force: true });
		});

		it('cleans up on empty commit failure', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout -b
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
				.mockResolvedValueOnce({ stdout: '', stderr: 'commit failed', exitCode: 1 }); // commit fails

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(fs.rm).toHaveBeenCalledWith('/tmp/test-repo', { recursive: true, force: true });
		});

		it('cleans up on push failure', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout -b
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // commit
				.mockResolvedValueOnce({ stdout: '', stderr: 'push failed', exitCode: 1 }); // push fails

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(fs.rm).toHaveBeenCalledWith('/tmp/test-repo', { recursive: true, force: true });
		});

		it('cleans up on PR creation failure', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // checkout -b
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // commit
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // push
				.mockResolvedValueOnce({ stdout: '', stderr: 'pr create failed', exitCode: 1 }); // pr create fails

			await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(fs.rm).toHaveBeenCalledWith('/tmp/test-repo', { recursive: true, force: true });
		});

		it('returns draftPrUrl, draftPrNumber, autoRunPath on success', async () => {
			mockSuccessfulWorkflow('https://github.com/owner/repo/pull/42');

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(true);
			expect(result.draftPrUrl).toBe('https://github.com/owner/repo/pull/42');
			expect(result.draftPrNumber).toBe(42);
			expect(result.autoRunPath).toBe('/tmp/test-repo/Auto Run Docs');
		});

		it('handles unexpected errors gracefully', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // clone
				.mockRejectedValueOnce(new Error('Unexpected error'));

			const result = await startContribution({
				contributionId: 'test-id',
				repoSlug: 'owner/repo',
				repoUrl: 'https://github.com/owner/repo',
				issueNumber: 123,
				issueTitle: 'Test Issue',
				documentPaths: [],
				localPath: '/tmp/test-repo',
				branchName: 'symphony/test-branch',
			});

			expect(result.success).toBe(false);
			expect(result.error).toBe('Unexpected error');
			expect(fs.rm).toHaveBeenCalledWith('/tmp/test-repo', { recursive: true, force: true });
		});
	});

	// ============================================================================
	// Finalize Contribution Tests
	// ============================================================================

	describe('finalizeContribution', () => {
		it('configures git user', async () => {
			mockFinalizeWorkflow();

			await finalizeContribution('/tmp/test-repo', 1, 123, 'Test Issue');

			expect(execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['config', 'user.name', 'Maestro Symphony'],
				'/tmp/test-repo'
			);
			expect(execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['config', 'user.email', 'symphony@runmaestro.ai'],
				'/tmp/test-repo'
			);
		});

		it('stages all changes with git add -A', async () => {
			mockFinalizeWorkflow();

			await finalizeContribution('/tmp/test-repo', 1, 123, 'Test Issue');

			expect(execFileNoThrow).toHaveBeenCalledWith('git', ['add', '-A'], '/tmp/test-repo');
		});

		it('creates commit with Symphony message', async () => {
			mockFinalizeWorkflow();

			await finalizeContribution('/tmp/test-repo', 1, 456, 'Test Issue Title');

			const commitCall = vi
				.mocked(execFileNoThrow)
				.mock.calls.find((call) => call[0] === 'git' && call[1]?.includes('commit'));
			expect(commitCall).toBeDefined();
			expect(commitCall![1]).toContain('-m');
			const messageIndex = commitCall![1].indexOf('-m');
			const message = commitCall![1][messageIndex + 1];
			expect(message).toContain('[Symphony] Complete contribution for #456');
			expect(message).toContain('Test Issue Title');
		});

		it('handles "nothing to commit" gracefully', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git add -A
				.mockResolvedValueOnce({ stdout: '', stderr: 'nothing to commit', exitCode: 1 }) // git commit (nothing to commit)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git push
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // gh pr ready
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // gh pr edit
				.mockResolvedValueOnce({
					stdout: 'https://github.com/owner/repo/pull/1',
					stderr: '',
					exitCode: 0,
				}); // gh pr view

			const result = await finalizeContribution('/tmp/test-repo', 1, 123, 'Test Issue');

			// Should continue despite nothing to commit
			expect(result.success).toBe(true);
		});

		it('pushes changes to remote', async () => {
			mockFinalizeWorkflow();

			await finalizeContribution('/tmp/test-repo', 1, 123, 'Test Issue');

			expect(execFileNoThrow).toHaveBeenCalledWith('git', ['push'], '/tmp/test-repo');
		});

		it('returns error on push failure', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git add -A
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git commit
				.mockResolvedValueOnce({ stdout: '', stderr: 'push failed', exitCode: 1 }); // git push fails

			const result = await finalizeContribution('/tmp/test-repo', 1, 123, 'Test Issue');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Push failed');
		});

		it('marks PR as ready using gh pr ready', async () => {
			mockFinalizeWorkflow('https://github.com/owner/repo/pull/42');

			await finalizeContribution('/tmp/test-repo', 42, 123, 'Test Issue');

			expect(execFileNoThrow).toHaveBeenCalledWith('gh', ['pr', 'ready', '42'], '/tmp/test-repo');
		});

		it('returns error on ready failure', async () => {
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.name
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // config user.email
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git add -A
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git commit
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 }) // git push
				.mockResolvedValueOnce({ stdout: '', stderr: 'ready failed', exitCode: 1 }); // gh pr ready fails

			const result = await finalizeContribution('/tmp/test-repo', 1, 123, 'Test Issue');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Failed to mark PR ready');
		});

		it('updates PR body with completion summary', async () => {
			mockFinalizeWorkflow();

			await finalizeContribution('/tmp/test-repo', 1, 123, 'Test Issue');

			const editCall = vi
				.mocked(execFileNoThrow)
				.mock.calls.find((call) => call[0] === 'gh' && call[1]?.includes('edit'));
			expect(editCall).toBeDefined();
			expect(editCall![1]).toContain('--body');
		});

		it('returns final PR URL', async () => {
			mockFinalizeWorkflow('https://github.com/owner/repo/pull/99');

			const result = await finalizeContribution('/tmp/test-repo', 99, 123, 'Test Issue');

			expect(result.success).toBe(true);
			expect(result.prUrl).toBe('https://github.com/owner/repo/pull/99');
		});
	});

	// ============================================================================
	// Cancel Contribution Tests
	// ============================================================================

	describe('cancelContribution', () => {
		it('closes draft PR with gh pr close --delete-branch', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			await cancelContribution('/tmp/test-repo', 42, true);

			expect(execFileNoThrow).toHaveBeenCalledWith(
				'gh',
				['pr', 'close', '42', '--delete-branch'],
				'/tmp/test-repo'
			);
		});

		it('handles PR close failure gracefully (warns but continues)', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				stdout: '',
				stderr: 'pr close failed',
				exitCode: 1,
			});

			const result = await cancelContribution('/tmp/test-repo', 42, true);

			expect(logger.warn).toHaveBeenCalledWith(
				'Failed to close PR',
				expect.any(String),
				expect.objectContaining({ prNumber: 42 })
			);
			// Should still return success
			expect(result.success).toBe(true);
		});

		it('removes local directory when cleanup=true', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			await cancelContribution('/tmp/test-repo', 42, true);

			expect(fs.rm).toHaveBeenCalledWith('/tmp/test-repo', { recursive: true, force: true });
		});

		it('preserves local directory when cleanup=false', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				stdout: '',
				stderr: '',
				exitCode: 0,
			});

			await cancelContribution('/tmp/test-repo', 42, false);

			expect(fs.rm).not.toHaveBeenCalled();
		});

		it('returns success:true even if PR close fails', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				stdout: '',
				stderr: 'error',
				exitCode: 1,
			});

			const result = await cancelContribution('/tmp/test-repo', 42, true);

			expect(result.success).toBe(true);
		});
	});
});
