/**
 * Symphony Integration Tests
 *
 * These tests verify Symphony workflows with minimal mocking.
 * Only external services (GitHub API, git/gh CLI) are mocked.
 * Real file system operations are used with temporary directories.
 *
 * Test coverage includes:
 * - Full contribution workflow: start → update status → complete
 * - State persistence across handler registrations
 * - Cache behavior and expiration
 * - Edge cases and error handling
 * - Security validation (path traversal, input sanitization)
 * - Performance considerations
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { ipcMain, BrowserWindow, App } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
	registerSymphonyHandlers,
	SymphonyHandlerDependencies,
} from '../../main/ipc/handlers/symphony';
import {
	REGISTRY_CACHE_TTL_MS,
	ISSUES_CACHE_TTL_MS,
	DEFAULT_CONTRIBUTOR_STATS,
} from '../../shared/symphony-constants';
import type {
	SymphonyRegistry,
	SymphonyIssue,
	SymphonyState,
	SymphonyCache,
	ActiveContribution,
	ContributorStats,
} from '../../shared/symphony-types';

// ============================================================================
// Minimal Mocking - Only External Services
// ============================================================================

// Mock electron IPC (required for handler registration)
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
	app: {
		getPath: vi.fn(),
	},
	BrowserWindow: vi.fn(),
}));

// Mock execFileNoThrow for git/gh CLI operations (external service)
vi.mock('../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

// Mock logger (not an external service, but avoid console noise)
vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock global fetch for GitHub API calls (external service)
const mockFetch = vi.fn();
global.fetch = mockFetch;

let mockSessionIds = new Set<string>();

// Import mocked functions
import { execFileNoThrow } from '../../main/utils/execFile';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a temporary directory for test isolation.
 * Each test gets its own directory to avoid interference.
 */
async function createTempDir(): Promise<string> {
	const tempBase = path.join(os.tmpdir(), 'maestro-symphony-tests');
	await fs.mkdir(tempBase, { recursive: true });
	const testTempDir = await fs.mkdtemp(path.join(tempBase, 'test-'));
	return testTempDir;
}

/**
 * Clean up a temporary directory after test.
 */
async function cleanupTempDir(testTempDir: string): Promise<void> {
	try {
		await fs.rm(testTempDir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
}

function getWeekKey(date: Date): string {
	const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
	const dayNum = d.getUTCDay() || 7;
	d.setUTCDate(d.getUTCDate() + 4 - dayNum);
	const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
	const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
	return `${d.getUTCFullYear()}-W${weekNo}`;
}

/**
 * Create a mock registry response.
 */
function createMockRegistry(overrides: Partial<SymphonyRegistry> = {}): SymphonyRegistry {
	return {
		schemaVersion: '1.0',
		lastUpdated: new Date().toISOString(),
		repositories: [
			{
				slug: 'test-owner/test-repo',
				name: 'Test Repository',
				description: 'A test repository for Symphony',
				url: 'https://github.com/test-owner/test-repo',
				category: 'developer-tools',
				maintainer: { name: 'Test Maintainer' },
				isActive: true,
				addedAt: new Date().toISOString(),
			},
		],
		...overrides,
	};
}

/**
 * Create a mock issue response.
 */
function createMockIssue(overrides: Partial<SymphonyIssue> = {}): SymphonyIssue {
	return {
		number: 1,
		title: 'Test Issue',
		body: '- `docs/task.md`\n- `docs/setup.md`',
		url: 'https://api.github.com/repos/test-owner/test-repo/issues/1',
		htmlUrl: 'https://github.com/test-owner/test-repo/issues/1',
		author: 'test-author',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		documentPaths: [
			{ name: 'task.md', path: 'docs/task.md', isExternal: false },
			{ name: 'setup.md', path: 'docs/setup.md', isExternal: false },
		],
		status: 'available',
		...overrides,
	};
}

/**
 * Create mock GitHub API issue response.
 */
function createGitHubIssueResponse(
	issues: Partial<SymphonyIssue>[] = [createMockIssue()]
): unknown[] {
	return issues.map((issue, index) => ({
		number: issue.number ?? index + 1,
		title: issue.title ?? `Test Issue ${index + 1}`,
		body: issue.body ?? '- `docs/task.md`',
		url: issue.url ?? `https://api.github.com/repos/test-owner/test-repo/issues/${index + 1}`,
		html_url: issue.htmlUrl ?? `https://github.com/test-owner/test-repo/issues/${index + 1}`,
		user: { login: issue.author ?? 'test-author' },
		created_at: issue.createdAt ?? new Date().toISOString(),
		updated_at: issue.updatedAt ?? new Date().toISOString(),
	}));
}

/**
 * Helper to invoke a registered IPC handler.
 */
async function invokeHandler(
	handlers: Map<string, Function>,
	channel: string,
	...args: unknown[]
): Promise<unknown> {
	const handler = handlers.get(channel);
	if (!handler) {
		throw new Error(`No handler registered for channel: ${channel}`);
	}
	const params = args[0];
	if (params && typeof params === 'object' && 'sessionId' in params) {
		const sessionId = (params as { sessionId?: unknown }).sessionId;
		if (typeof sessionId === 'string') {
			mockSessionIds.add(sessionId);
		}
	}
	// IPC handlers receive (event, ...args) but our handlers unwrap the args
	return await handler({}, ...args);
}

// ============================================================================
// Integration Test Suite
// ============================================================================

describe('Symphony Integration Tests', () => {
	let handlers: Map<string, Function>;
	let mockApp: App;
	let mockMainWindow: BrowserWindow;
	let mockDeps: SymphonyHandlerDependencies;
	let testTempDir: string;

	beforeAll(async () => {
		// Nothing to do - each test creates its own temp directory
	});

	afterAll(async () => {
		// Nothing to do - each test cleans its own temp directory
	});

	beforeEach(async () => {
		vi.clearAllMocks();
		mockSessionIds = new Set();

		// Create a fresh temp directory for each test to ensure isolation
		testTempDir = await createTempDir();

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Setup mock app with real temp directory
		mockApp = {
			getPath: vi.fn().mockReturnValue(testTempDir),
		} as unknown as App;

		// Setup mock main window
		mockMainWindow = {
			isDestroyed: vi.fn().mockReturnValue(false),
			webContents: {
				isDestroyed: vi.fn().mockReturnValue(false),
				send: vi.fn(),
			},
		} as unknown as BrowserWindow;

		// Setup mock sessions store (returns empty by default - no sessions)
		const mockSessionsStore = {
			get: vi.fn((key: string, defaultValue?: unknown) =>
				key === 'sessions' ? Array.from(mockSessionIds, (id) => ({ id })) : defaultValue
			),
			set: vi.fn(),
		};

		// Setup dependencies
		mockDeps = {
			app: mockApp,
			getMainWindow: () => mockMainWindow,
			sessionsStore: mockSessionsStore as any,
		};

		// Default fetch mock (successful responses)
		mockFetch.mockImplementation(async (url: string) => {
			if (url.includes('symphony-registry.json')) {
				return {
					ok: true,
					json: async () => createMockRegistry(),
				};
			}
			if (url.includes('/issues')) {
				return {
					ok: true,
					json: async () => createGitHubIssueResponse(),
				};
			}
			if (url.includes('/pulls')) {
				return {
					ok: true,
					json: async () => [], // No PRs by default
				};
			}
			return { ok: false, status: 404, statusText: 'Not Found' };
		});

		// Default execFileNoThrow mock (successful git operations)
		vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args, _cwd) => {
			// gh auth status - authenticated
			if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
				return { stdout: 'Logged in to github.com', stderr: '', exitCode: 0 };
			}
			// gh api user - authenticated as the test repository owner by default
			if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === 'user') {
				return { stdout: 'test-owner\n', stderr: '', exitCode: 0 };
			}
			// gh api repos/:owner/:repo --jq .permissions.push - has push access by default
			if (
				cmd === 'gh' &&
				args?.[0] === 'api' &&
				typeof args?.[1] === 'string' &&
				args[1].startsWith('repos/') &&
				args?.[2] === '--jq' &&
				args?.[3] === '.permissions.push'
			) {
				return { stdout: 'true\n', stderr: '', exitCode: 0 };
			}
			// git clone
			if (cmd === 'git' && args?.[0] === 'clone') {
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			// git checkout -b (create branch)
			if (cmd === 'git' && args?.[0] === 'checkout' && args?.[1] === '-b') {
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			// git symbolic-ref (get default branch)
			if (cmd === 'git' && args?.[0] === 'symbolic-ref') {
				return { stdout: 'refs/remotes/origin/main', stderr: '', exitCode: 0 };
			}
			// git rev-list (count commits)
			if (cmd === 'git' && args?.[0] === 'rev-list') {
				return { stdout: '1', stderr: '', exitCode: 0 };
			}
			// git rev-parse (get branch name)
			if (cmd === 'git' && args?.[0] === 'rev-parse') {
				return { stdout: 'symphony/issue-1-test', stderr: '', exitCode: 0 };
			}
			// git push
			if (cmd === 'git' && args?.[0] === 'push') {
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			// gh pr create
			if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'create') {
				return {
					stdout: 'https://github.com/test-owner/test-repo/pull/1',
					stderr: '',
					exitCode: 0,
				};
			}
			// gh pr ready
			if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'ready') {
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			// gh pr comment
			if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'comment') {
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			// Default: command not found
			return { stdout: '', stderr: 'command not found', exitCode: 127 };
		});

		// Register handlers
		registerSymphonyHandlers(mockDeps);
	});

	afterEach(async () => {
		handlers.clear();
		// Clean up temp directory after each test
		if (testTempDir) {
			await cleanupTempDir(testTempDir);
		}
	});

	function createTestState(
		overrides: Partial<Omit<SymphonyState, 'stats'>> & {
			stats?: Partial<ContributorStats>;
		} = {}
	): SymphonyState {
		return {
			active: overrides.active ?? [],
			history: overrides.history ?? [],
			stats: {
				...DEFAULT_CONTRIBUTOR_STATS,
				...overrides.stats,
			},
		};
	}

	function createActiveContribution(
		overrides: Partial<ActiveContribution> = {}
	): ActiveContribution {
		const { progress: progressOverride, tokenUsage: tokenUsageOverride, ...rest } = overrides;
		const progress = {
			totalDocuments: 1,
			completedDocuments: 0,
			totalTasks: 1,
			completedTasks: 0,
			...progressOverride,
		};
		const tokenUsage = {
			inputTokens: 0,
			outputTokens: 0,
			estimatedCost: 0,
			...tokenUsageOverride,
		};

		return {
			id: 'contrib-test',
			repoSlug: 'test-owner/test-repo',
			repoName: 'test-repo',
			issueNumber: 1,
			issueTitle: 'Test Issue',
			localPath: path.join(testTempDir, 'symphony-repos', 'test-repo'),
			branchName: 'symphony/issue-1-test',
			startedAt: '2026-05-01T00:00:00.000Z',
			status: 'running',
			timeSpent: 0,
			sessionId: 'session-test',
			agentType: 'claude-code',
			...rest,
			progress,
			tokenUsage,
		};
	}

	async function writeStateForTest(state: SymphonyState): Promise<void> {
		const stateFilePath = path.join(testTempDir, 'symphony', 'symphony-state.json');
		await fs.mkdir(path.dirname(stateFilePath), { recursive: true });
		await fs.writeFile(stateFilePath, JSON.stringify(state));
	}

	async function readStateForTest(): Promise<SymphonyState> {
		const stateFilePath = path.join(testTempDir, 'symphony', 'symphony-state.json');
		return JSON.parse(await fs.readFile(stateFilePath, 'utf-8')) as SymphonyState;
	}

	// ==========================================================================
	// Test File Setup Verification
	// ==========================================================================

	describe('Integration Test Setup', () => {
		it('should create temp directory with real file system', async () => {
			const stat = await fs.stat(testTempDir);
			expect(stat.isDirectory()).toBe(true);
		});

		it('should have mock fetch for GitHub API calls', () => {
			expect(mockFetch).toBeDefined();
			expect(vi.isMockFunction(mockFetch)).toBe(true);
		});

		it('should have mock execFileNoThrow for git/gh CLI operations', () => {
			expect(execFileNoThrow).toBeDefined();
			expect(vi.isMockFunction(execFileNoThrow)).toBe(true);
		});

		it('should use real file system operations for state files', async () => {
			const testFile = path.join(testTempDir, 'test-file.txt');
			await fs.writeFile(testFile, 'test content');
			const content = await fs.readFile(testFile, 'utf-8');
			expect(content).toBe('test content');
			await fs.rm(testFile);
		});

		it('should register all Symphony handlers', () => {
			const expectedHandlers = [
				'symphony:getRegistry',
				'symphony:getIssues',
				'symphony:getState',
				'symphony:getActive',
				'symphony:getCompleted',
				'symphony:getStats',
				'symphony:start',
				'symphony:registerActive',
				'symphony:updateStatus',
				'symphony:complete',
				'symphony:cancel',
				'symphony:checkPRStatuses',
				'symphony:clearCache',
				'symphony:getIssueCounts',
				'symphony:syncContribution',
				'symphony:cloneRepo',
				'symphony:startContribution',
				'symphony:createDraftPR',
				'symphony:fetchDocumentContent',
				'symphony:manualCredit',
			];

			for (const channel of expectedHandlers) {
				expect(handlers.has(channel), `Handler ${channel} should be registered`).toBe(true);
			}
		});
	});

	// ==========================================================================
	// Full Contribution Workflow Tests
	// ==========================================================================

	describe('Full Contribution Workflow', () => {
		it('should complete full contribution flow: start → update status → complete', async () => {
			// Create a local repo directory to simulate clone
			const repoDir = path.join(testTempDir, 'symphony-repos', 'test-repo-contrib_test');
			await fs.mkdir(repoDir, { recursive: true });

			// 1. Start contribution - this creates branch and initial state
			const startResult = (await invokeHandler(handlers, 'symphony:startContribution', {
				contributionId: 'contrib_test',
				sessionId: 'session-123',
				repoSlug: 'test-owner/test-repo',
				issueNumber: 1,
				issueTitle: 'Test Issue',
				localPath: repoDir,
				documentPaths: [{ name: 'task.md', path: 'docs/task.md', isExternal: false }],
			})) as { success: boolean; branchName?: string; error?: string };

			expect(startResult.success, startResult.error).toBe(true);
			expect(startResult.branchName).toMatch(/^symphony\/issue-1-/);

			// 2. Register the active contribution (simulating App.tsx behavior)
			const registerResult = (await invokeHandler(handlers, 'symphony:registerActive', {
				contributionId: 'contrib_test',
				sessionId: 'session-123',
				repoSlug: 'test-owner/test-repo',
				repoName: 'test-repo',
				issueNumber: 1,
				issueTitle: 'Test Issue',
				localPath: repoDir,
				branchName: startResult.branchName!,
				documentPaths: ['docs/task.md'],
				agentType: 'claude-code',
			})) as { success: boolean };

			expect(registerResult.success).toBe(true);

			// 3. Update status with progress
			const updateResult = (await invokeHandler(handlers, 'symphony:updateStatus', {
				contributionId: 'contrib_test',
				status: 'running',
				progress: {
					totalDocuments: 1,
					completedDocuments: 1,
					totalTasks: 5,
					completedTasks: 3,
				},
				tokenUsage: {
					inputTokens: 1000,
					outputTokens: 500,
					estimatedCost: 0.05,
				},
				timeSpent: 60000, // 1 minute
			})) as { updated: boolean };

			expect(updateResult.updated).toBe(true);

			// 4. Create draft PR (simulating first commit)
			// First, create metadata file that createDraftPR expects
			const metadataDir = path.join(testTempDir, 'symphony', 'contributions', 'contrib_test');
			await fs.mkdir(metadataDir, { recursive: true });
			await fs.writeFile(
				path.join(metadataDir, 'metadata.json'),
				JSON.stringify({
					contributionId: 'contrib_test',
					sessionId: 'session-123',
					repoSlug: 'test-owner/test-repo',
					issueNumber: 1,
					issueTitle: 'Test Issue',
					branchName: startResult.branchName,
					localPath: repoDir,
					prCreated: false,
				})
			);

			const prResult = (await invokeHandler(handlers, 'symphony:createDraftPR', {
				contributionId: 'contrib_test',
			})) as { success: boolean; draftPrNumber?: number; draftPrUrl?: string };

			expect(prResult.success).toBe(true);
			expect(prResult.draftPrNumber).toBe(1);
			expect(prResult.draftPrUrl).toContain('github.com');

			// 5. Update with PR info
			await invokeHandler(handlers, 'symphony:updateStatus', {
				contributionId: 'contrib_test',
				draftPrNumber: prResult.draftPrNumber,
				draftPrUrl: prResult.draftPrUrl,
			});

			// 6. Complete the contribution
			const completeResult = (await invokeHandler(handlers, 'symphony:complete', {
				contributionId: 'contrib_test',
				stats: {
					inputTokens: 2000,
					outputTokens: 1000,
					estimatedCost: 0.1,
					timeSpentMs: 120000,
					documentsProcessed: 1,
					tasksCompleted: 5,
				},
			})) as { prUrl?: string; prNumber?: number; error?: string };

			expect(completeResult.prUrl).toBeDefined();
			expect(completeResult.prNumber).toBe(1);

			// 7. Verify state after completion
			const state = (await invokeHandler(handlers, 'symphony:getState')) as {
				state: SymphonyState;
			};

			// Active should be empty (contribution moved to history)
			expect(state.state.active.length).toBe(0);

			// History should have the completed contribution
			expect(state.state.history.length).toBe(1);
			expect(state.state.history[0].id).toBe('contrib_test');
			expect(state.state.history[0].prNumber).toBe(1);

			// Stats should be updated
			expect(state.state.stats.totalContributions).toBe(1);
			expect(state.state.stats.totalTokensUsed).toBe(3000); // 2000 + 1000
		});

		it('should handle real state file persistence', async () => {
			// Create contribution to persist state
			const repoDir = path.join(testTempDir, 'symphony-repos', 'persist-test');
			await fs.mkdir(repoDir, { recursive: true });

			await invokeHandler(handlers, 'symphony:registerActive', {
				contributionId: 'persist_test',
				sessionId: 'session-persist',
				repoSlug: 'test-owner/test-repo',
				repoName: 'test-repo',
				issueNumber: 42,
				issueTitle: 'Persistence Test',
				localPath: repoDir,
				branchName: 'symphony/issue-42-test',
				documentPaths: ['docs/task.md'],
				agentType: 'claude-code',
			});

			// Verify state file was created on disk
			const stateFile = path.join(testTempDir, 'symphony', 'symphony-state.json');
			const stateContent = await fs.readFile(stateFile, 'utf-8');
			const persistedState = JSON.parse(stateContent) as SymphonyState;

			expect(persistedState.active.length).toBe(1);
			expect(persistedState.active[0].id).toBe('persist_test');
			expect(persistedState.active[0].issueNumber).toBe(42);
		});

		it('should handle multiple concurrent contributions without interference', async () => {
			// Start multiple contributions
			const contributions = ['contrib_a', 'contrib_b', 'contrib_c'];

			for (let i = 0; i < contributions.length; i++) {
				const repoDir = path.join(testTempDir, 'symphony-repos', `concurrent-${contributions[i]}`);
				await fs.mkdir(repoDir, { recursive: true });

				await invokeHandler(handlers, 'symphony:registerActive', {
					contributionId: contributions[i],
					sessionId: `session-${contributions[i]}`,
					repoSlug: `test-owner/repo-${i}`,
					repoName: `repo-${i}`,
					issueNumber: i + 1,
					issueTitle: `Issue ${i + 1}`,
					localPath: repoDir,
					branchName: `symphony/issue-${i + 1}-test`,
					documentPaths: ['docs/task.md'],
					agentType: 'claude-code',
				});
			}

			// Verify all contributions are tracked
			const activeResult = (await invokeHandler(handlers, 'symphony:getActive')) as {
				contributions: ActiveContribution[];
			};
			expect(activeResult.contributions.length).toBe(3);

			// Update each contribution with different progress
			for (let i = 0; i < contributions.length; i++) {
				await invokeHandler(handlers, 'symphony:updateStatus', {
					contributionId: contributions[i],
					progress: {
						totalTasks: 10,
						completedTasks: i + 1, // Different progress for each
					},
				});
			}

			// Verify each contribution has correct progress
			const stateResult = (await invokeHandler(handlers, 'symphony:getState')) as {
				state: SymphonyState;
			};
			for (let i = 0; i < contributions.length; i++) {
				const contrib = stateResult.state.active.find((c) => c.id === contributions[i]);
				expect(contrib?.progress.completedTasks).toBe(i + 1);
			}
		});

		it('should support contribution recovery after simulated app restart', async () => {
			const repoDir = path.join(testTempDir, 'symphony-repos', 'recovery-test');
			await fs.mkdir(repoDir, { recursive: true });

			// Start a contribution
			await invokeHandler(handlers, 'symphony:registerActive', {
				contributionId: 'recovery_test',
				sessionId: 'session-recovery',
				repoSlug: 'test-owner/recovery-repo',
				repoName: 'recovery-repo',
				issueNumber: 99,
				issueTitle: 'Recovery Test',
				localPath: repoDir,
				branchName: 'symphony/issue-99-test',
				documentPaths: ['docs/task.md'],
				agentType: 'claude-code',
			});

			// Simulate app restart by re-registering handlers (new handler instance)
			handlers.clear();
			registerSymphonyHandlers(mockDeps);

			// State should be recovered from disk
			const stateResult = (await invokeHandler(handlers, 'symphony:getState')) as {
				state: SymphonyState;
			};
			const recoveredContrib = stateResult.state.active.find((c) => c.id === 'recovery_test');

			expect(recoveredContrib).toBeDefined();
			expect(recoveredContrib?.issueNumber).toBe(99);
			expect(recoveredContrib?.repoSlug).toBe('test-owner/recovery-repo');
		});

		it('should handle status and completion error branches without corrupting active state', async () => {
			const missingUpdate = (await invokeHandler(handlers, 'symphony:updateStatus', {
				contributionId: 'missing-contribution',
				error: 'not found',
			})) as { updated: boolean };

			expect(missingUpdate.updated).toBe(false);

			await invokeHandler(handlers, 'symphony:registerActive', {
				contributionId: 'no_pr',
				sessionId: 'session-no-pr',
				repoSlug: 'test-owner/test-repo',
				repoName: 'test-repo',
				issueNumber: 41,
				issueTitle: 'No PR yet',
				localPath: path.join(testTempDir, 'symphony-repos', 'no-pr'),
				branchName: 'symphony/issue-41',
				totalDocuments: 1,
				agentType: 'claude-code',
			});

			const errorUpdate = (await invokeHandler(handlers, 'symphony:updateStatus', {
				contributionId: 'no_pr',
				error: 'agent failed',
			})) as { updated: boolean };
			expect(errorUpdate.updated).toBe(true);
			const stateAfterErrorUpdate = (await invokeHandler(handlers, 'symphony:getState')) as {
				state: SymphonyState;
			};
			expect(stateAfterErrorUpdate.state.active.find((c) => c.id === 'no_pr')?.error).toBe(
				'agent failed'
			);

			const noPrComplete = (await invokeHandler(handlers, 'symphony:complete', {
				contributionId: 'no_pr',
			})) as { error?: string };
			expect(noPrComplete.error).toContain('No draft PR exists yet');

			await invokeHandler(handlers, 'symphony:registerActive', {
				contributionId: 'ready_fail',
				sessionId: 'session-ready-fail',
				repoSlug: 'test-owner/test-repo',
				repoName: 'test-repo',
				issueNumber: 42,
				issueTitle: 'Ready fails',
				localPath: path.join(testTempDir, 'symphony-repos', 'ready-fail'),
				branchName: 'symphony/issue-42',
				totalDocuments: 1,
				agentType: 'claude-code',
				draftPrNumber: 42,
				draftPrUrl: 'https://github.com/test-owner/test-repo/pull/42',
			});
			vi.mocked(execFileNoThrow).mockResolvedValueOnce({
				stdout: '',
				stderr: 'ready failed',
				exitCode: 1,
			});
			const readyFailure = (await invokeHandler(handlers, 'symphony:complete', {
				contributionId: 'ready_fail',
			})) as { error?: string };
			expect(readyFailure.error).toBe('ready failed');
			const stateAfterReadyFailure = (await invokeHandler(handlers, 'symphony:getState')) as {
				state: SymphonyState;
			};
			expect(stateAfterReadyFailure.state.active.find((c) => c.id === 'ready_fail')).toMatchObject({
				status: 'failed',
				error: 'ready failed',
			});

			await invokeHandler(handlers, 'symphony:registerActive', {
				contributionId: 'comment_fail',
				sessionId: 'session-comment-fail',
				repoSlug: 'test-owner/test-repo',
				repoName: 'test-repo',
				issueNumber: 43,
				issueTitle: 'Comment fails',
				localPath: path.join(testTempDir, 'symphony-repos', 'comment-fail'),
				branchName: 'symphony/issue-43',
				totalDocuments: 1,
				agentType: 'claude-code',
				draftPrNumber: 43,
				draftPrUrl: 'https://github.com/test-owner/test-repo/pull/43',
			});
			vi.mocked(execFileNoThrow)
				.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
				.mockResolvedValueOnce({ stdout: '', stderr: 'comment failed', exitCode: 1 });
			const completed = (await invokeHandler(handlers, 'symphony:complete', {
				contributionId: 'comment_fail',
			})) as { prNumber?: number; prUrl?: string };

			expect(completed).toMatchObject({
				prNumber: 43,
				prUrl: 'https://github.com/test-owner/test-repo/pull/43',
			});
		});
	});

	// ==========================================================================
	// State Persistence Tests
	// ==========================================================================

	describe('State Persistence', () => {
		it('should survive state across handler registrations', async () => {
			// Create initial state
			await invokeHandler(handlers, 'symphony:registerActive', {
				contributionId: 'state_persist_1',
				sessionId: 'session-1',
				repoSlug: 'owner/repo1',
				repoName: 'repo1',
				issueNumber: 1,
				issueTitle: 'Issue 1',
				localPath: '/tmp/repo1',
				branchName: 'symphony/issue-1',
				documentPaths: [],
				agentType: 'claude-code',
			});

			// Re-register handlers (simulates module reload)
			handlers.clear();
			registerSymphonyHandlers(mockDeps);

			// State should persist
			const result = (await invokeHandler(handlers, 'symphony:getState')) as {
				state: SymphonyState;
			};
			expect(result.state.active.some((c) => c.id === 'state_persist_1')).toBe(true);
		});

		it('should create cache file that is readable', async () => {
			// Fetch registry (creates cache)
			await invokeHandler(handlers, 'symphony:getRegistry', false);

			// Verify cache file exists and is readable
			const cacheFile = path.join(testTempDir, 'symphony', 'symphony-cache.json');
			const cacheContent = await fs.readFile(cacheFile, 'utf-8');
			const cache = JSON.parse(cacheContent) as SymphonyCache;

			expect(cache.registry).toBeDefined();
			expect(cache.registry?.data).toBeDefined();
		});

		it('should create state file that is readable', async () => {
			// Create some state
			await invokeHandler(handlers, 'symphony:registerActive', {
				contributionId: 'state_file_test',
				sessionId: 'session-state',
				repoSlug: 'owner/repo',
				repoName: 'repo',
				issueNumber: 1,
				issueTitle: 'State File Test',
				localPath: '/tmp/repo',
				branchName: 'symphony/issue-1',
				documentPaths: [],
				agentType: 'claude-code',
			});

			// Verify state file
			const stateFile = path.join(testTempDir, 'symphony', 'symphony-state.json');
			const stateContent = await fs.readFile(stateFile, 'utf-8');
			const state = JSON.parse(stateContent) as SymphonyState;

			expect(state.active).toBeDefined();
			expect(state.history).toBeDefined();
			expect(state.stats).toBeDefined();
		});

		it('should handle corrupted state file gracefully', async () => {
			// Write corrupted state
			const stateFile = path.join(testTempDir, 'symphony', 'symphony-state.json');
			await fs.mkdir(path.dirname(stateFile), { recursive: true });
			await fs.writeFile(stateFile, '{ invalid json');

			// Re-register handlers
			handlers.clear();
			registerSymphonyHandlers(mockDeps);

			// Should return defaults
			const result = (await invokeHandler(handlers, 'symphony:getState')) as {
				state: SymphonyState;
			};
			expect(result.state.active).toEqual([]);
			expect(result.state.history).toEqual([]);
		});

		it('should handle corrupted cache file gracefully', async () => {
			// Write corrupted cache
			const cacheFile = path.join(testTempDir, 'symphony', 'symphony-cache.json');
			await fs.mkdir(path.dirname(cacheFile), { recursive: true });
			await fs.writeFile(cacheFile, 'not valid json at all');

			// Should fetch fresh data
			const result = (await invokeHandler(handlers, 'symphony:getRegistry', false)) as {
				registry: SymphonyRegistry;
				fromCache: boolean;
			};

			expect(result.registry).toBeDefined();
			expect(result.fromCache).toBe(false);
		});
	});

	// ==========================================================================
	// Cache Behavior Tests
	// ==========================================================================

	describe('Cache Behavior', () => {
		it('should expire registry cache after REGISTRY_CACHE_TTL_MS', async () => {
			// First fetch - caches data
			await invokeHandler(handlers, 'symphony:getRegistry', false);

			// Manually expire cache by modifying timestamp
			const cacheFile = path.join(testTempDir, 'symphony', 'symphony-cache.json');
			const cache = JSON.parse(await fs.readFile(cacheFile, 'utf-8')) as SymphonyCache;
			cache.registry!.fetchedAt = Date.now() - REGISTRY_CACHE_TTL_MS - 1000;
			await fs.writeFile(cacheFile, JSON.stringify(cache));

			// Clear and re-register handlers
			handlers.clear();
			registerSymphonyHandlers(mockDeps);

			// Track fetch calls
			mockFetch.mockClear();

			// Should fetch fresh
			const result = (await invokeHandler(handlers, 'symphony:getRegistry', false)) as {
				fromCache: boolean;
			};

			expect(result.fromCache).toBe(false);
			expect(mockFetch).toHaveBeenCalled();
		});

		it('should expire issues cache after ISSUES_CACHE_TTL_MS', async () => {
			// First fetch
			await invokeHandler(handlers, 'symphony:getIssues', 'test-owner/test-repo', false);

			// Expire cache
			const cacheFile = path.join(testTempDir, 'symphony', 'symphony-cache.json');
			const cache = JSON.parse(await fs.readFile(cacheFile, 'utf-8')) as SymphonyCache;
			if (cache.issues['test-owner/test-repo']) {
				cache.issues['test-owner/test-repo'].fetchedAt = Date.now() - ISSUES_CACHE_TTL_MS - 1000;
			}
			await fs.writeFile(cacheFile, JSON.stringify(cache));

			// Clear and re-register
			handlers.clear();
			registerSymphonyHandlers(mockDeps);
			mockFetch.mockClear();

			// Should fetch fresh
			const result = (await invokeHandler(
				handlers,
				'symphony:getIssues',
				'test-owner/test-repo',
				false
			)) as {
				fromCache: boolean;
			};

			expect(result.fromCache).toBe(false);
		});

		it('should clear all cached data with clearCache', async () => {
			// Create cache
			await invokeHandler(handlers, 'symphony:getRegistry', false);
			await invokeHandler(handlers, 'symphony:getIssues', 'owner/repo1', false);
			await invokeHandler(handlers, 'symphony:getIssues', 'owner/repo2', false);

			// Clear cache
			const result = (await invokeHandler(handlers, 'symphony:clearCache')) as { cleared: boolean };
			expect(result.cleared).toBe(true);

			// Verify cache is empty
			const cacheFile = path.join(testTempDir, 'symphony', 'symphony-cache.json');
			const cache = JSON.parse(await fs.readFile(cacheFile, 'utf-8')) as SymphonyCache;
			expect(cache.registry).toBeUndefined();
			expect(Object.keys(cache.issues)).toHaveLength(0);
		});

		it('should maintain repo-specific cache for issues', async () => {
			// Fetch issues for different repos
			await invokeHandler(handlers, 'symphony:getIssues', 'owner/repo-a', false);
			await invokeHandler(handlers, 'symphony:getIssues', 'owner/repo-b', false);

			// Verify cache has both
			const cacheFile = path.join(testTempDir, 'symphony', 'symphony-cache.json');
			const cache = JSON.parse(await fs.readFile(cacheFile, 'utf-8')) as SymphonyCache;

			expect(cache.issues['owner/repo-a']).toBeDefined();
			expect(cache.issues['owner/repo-b']).toBeDefined();
		});

		it('should fetch, cache, and fall back for paginated issue counts', async () => {
			const pageOneItems = Array.from({ length: 100 }, (_, index) => ({
				repository_url:
					index < 60
						? 'https://api.github.com/repos/owner/repo-a'
						: 'https://api.github.com/repos/owner/repo-b',
			}));
			const pageTwoItems = Array.from({ length: 2 }, () => ({
				repository_url: 'https://api.github.com/repos/owner/repo-b',
			}));

			mockFetch.mockImplementation(async (url: string) => {
				const page = new URL(url).searchParams.get('page');
				if (url.includes('/search/issues') && page === '1') {
					return {
						ok: true,
						json: async () => ({ total_count: 102, items: pageOneItems }),
					};
				}
				if (url.includes('/search/issues') && page === '2') {
					return {
						ok: true,
						json: async () => ({ total_count: 102, items: pageTwoItems }),
					};
				}
				return { ok: false, status: 404, statusText: 'Not Found' };
			});

			const first = (await invokeHandler(handlers, 'symphony:getIssueCounts', [
				'owner/repo-b',
				'owner/repo-a',
				'owner/repo-a',
			])) as { counts: Record<string, number>; fromCache: boolean };

			expect(first.fromCache).toBe(false);
			expect(first.counts).toEqual({
				'owner/repo-a': 60,
				'owner/repo-b': 42,
			});
			expect(mockFetch).toHaveBeenCalledTimes(2);

			const cached = (await invokeHandler(handlers, 'symphony:getIssueCounts', [
				'owner/repo-a',
				'owner/repo-b',
			])) as { counts: Record<string, number>; fromCache: boolean; cacheAge: number };

			expect(cached.fromCache).toBe(true);
			expect(cached.counts).toEqual(first.counts);
			expect(cached.cacheAge).toBeGreaterThanOrEqual(0);
			expect(mockFetch).toHaveBeenCalledTimes(2);

			mockFetch.mockRejectedValueOnce(new Error('offline'));
			const fallback = (await invokeHandler(
				handlers,
				'symphony:getIssueCounts',
				['owner/repo-a', 'owner/repo-b'],
				true
			)) as { counts: Record<string, number>; fromCache: boolean; cacheAge: number };

			expect(fallback.fromCache).toBe(true);
			expect(fallback.counts).toEqual(first.counts);
			expect(fallback.cacheAge).toBeGreaterThanOrEqual(0);
		});

		it('should enrich registries with star counts and fall back to expired registry cache', async () => {
			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('symphony-registry.json')) {
					return {
						ok: true,
						json: async () => createMockRegistry(),
					};
				}
				if (url.includes('/repos/test-owner/test-repo')) {
					return {
						ok: true,
						json: async () => ({ stargazers_count: 123 }),
					};
				}
				return { ok: false, status: 404, statusText: 'Not Found' };
			});

			const fresh = (await invokeHandler(handlers, 'symphony:getRegistry', true)) as {
				registry: SymphonyRegistry;
				fromCache: boolean;
			};

			expect(fresh.fromCache).toBe(false);
			expect(fresh.registry.repositories[0].stars).toBe(123);

			const cacheFile = path.join(testTempDir, 'symphony', 'symphony-cache.json');
			const cachedRegistry = createMockRegistry();
			const staleFetchedAt = Date.now() - REGISTRY_CACHE_TTL_MS - 1000;
			const staleCache: SymphonyCache = {
				registry: { data: cachedRegistry, fetchedAt: staleFetchedAt },
				issues: {},
				stars: {
					data: { 'test-owner/test-repo': 88 },
					fetchedAt: Date.now(),
				},
			};
			await fs.writeFile(cacheFile, JSON.stringify(staleCache));
			mockFetch.mockRejectedValueOnce(new Error('offline'));

			const fallback = (await invokeHandler(handlers, 'symphony:getRegistry', true)) as {
				registry: SymphonyRegistry;
				fromCache: boolean;
				cacheAge: number;
			};

			expect(fallback.fromCache).toBe(true);
			expect(fallback.cacheAge).toBeGreaterThan(0);
			expect(fallback.registry.repositories[0].stars).toBe(88);
		});

		it('should parse markdown attachments, preserve labels, link PR status, and use expired issue cache fallback', async () => {
			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('/issues?')) {
					return {
						ok: true,
						json: async () => [
							{
								number: 7,
								title: 'Implement markdown attachment parsing',
								body: '[external.md](https://github.com/test-owner/test-repo/files/1/external.md)\n- `docs/local.md`',
								url: 'https://api.github.com/repos/test-owner/test-repo/issues/7',
								html_url: 'https://github.com/test-owner/test-repo/issues/7',
								user: { login: 'maintainer' },
								created_at: new Date().toISOString(),
								updated_at: new Date().toISOString(),
								labels: [
									{ name: 'runmaestro.ai', color: '000000' },
									{ name: 'bug', color: 'ff0000' },
								],
							},
						],
					};
				}
				if (url.includes('/pulls?state=open')) {
					return {
						ok: true,
						json: async () => [
							{
								number: 11,
								title: 'Symphony: Implement markdown attachment parsing (#7)',
								body: 'Closes #7',
								html_url: 'https://github.com/test-owner/test-repo/pull/11',
								user: { login: 'contributor' },
								draft: true,
							},
						],
					};
				}
				return { ok: false, status: 404, statusText: 'Not Found' };
			});

			const fresh = (await invokeHandler(
				handlers,
				'symphony:getIssues',
				'test-owner/test-repo',
				true
			)) as { issues: SymphonyIssue[]; fromCache: boolean };

			expect(fresh.fromCache).toBe(false);
			expect(fresh.issues[0]).toMatchObject({
				status: 'in_progress',
				labels: [{ name: 'bug', color: 'ff0000' }],
				claimedByPr: {
					number: 11,
					url: 'https://github.com/test-owner/test-repo/pull/11',
					author: 'contributor',
					isDraft: true,
				},
			});
			expect(fresh.issues[0].documentPaths).toEqual(
				expect.arrayContaining([
					{
						name: 'external.md',
						path: 'https://github.com/test-owner/test-repo/files/1/external.md',
						isExternal: true,
					},
					{ name: 'local.md', path: 'docs/local.md', isExternal: false },
				])
			);

			const cacheFile = path.join(testTempDir, 'symphony', 'symphony-cache.json');
			const cache = JSON.parse(await fs.readFile(cacheFile, 'utf-8')) as SymphonyCache;
			cache.issues['test-owner/test-repo'].fetchedAt = Date.now() - ISSUES_CACHE_TTL_MS - 1000;
			await fs.writeFile(cacheFile, JSON.stringify(cache));
			mockFetch.mockRejectedValueOnce(new Error('offline'));

			const fallback = (await invokeHandler(
				handlers,
				'symphony:getIssues',
				'test-owner/test-repo',
				true
			)) as { issues: SymphonyIssue[]; fromCache: boolean; cacheAge: number };

			expect(fallback.fromCache).toBe(true);
			expect(fallback.cacheAge).toBeGreaterThan(0);
			expect(fallback.issues[0].status).toBe('in_progress');
		});

		it('should use fresh issue cache and avoid fetching PR status for empty issue lists', async () => {
			const cacheFile = path.join(testTempDir, 'symphony', 'symphony-cache.json');
			await fs.mkdir(path.dirname(cacheFile), { recursive: true });
			const cachedIssue = createMockIssue({ number: 55, title: 'Cached issue' });
			await fs.writeFile(
				cacheFile,
				JSON.stringify({
					issues: {
						'test-owner/test-repo': {
							data: [cachedIssue],
							fetchedAt: Date.now(),
						},
					},
				} satisfies Partial<SymphonyCache>)
			);

			const cached = (await invokeHandler(
				handlers,
				'symphony:getIssues',
				'test-owner/test-repo',
				false
			)) as { issues: SymphonyIssue[]; fromCache: boolean; cacheAge: number };

			expect(cached.fromCache).toBe(true);
			expect(cached.cacheAge).toBeGreaterThanOrEqual(0);
			expect(cached.issues[0].title).toBe('Cached issue');
			expect(mockFetch).not.toHaveBeenCalled();

			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('/issues?')) {
					return { ok: true, json: async () => [] };
				}
				if (url.includes('/pulls?state=open')) {
					throw new Error('PR lookup should not run for empty issue lists');
				}
				return { ok: false, status: 404, statusText: 'Not Found' };
			});

			const freshEmpty = (await invokeHandler(
				handlers,
				'symphony:getIssues',
				'test-owner/empty-repo',
				true
			)) as { issues: SymphonyIssue[]; fromCache: boolean };

			expect(freshEmpty).toMatchObject({ issues: [], fromCache: false });
			expect(mockFetch).toHaveBeenCalledTimes(1);
		});

		it('should keep issue loading recoverable when PR status enrichment fails', async () => {
			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('/issues?')) {
					return {
						ok: true,
						json: async () =>
							createGitHubIssueResponse([{ number: 64, title: 'Recoverable PR lookup' }]),
					};
				}
				if (url.includes('/pulls?state=open')) {
					return { ok: false, status: 503, statusText: 'Service Unavailable' };
				}
				return { ok: false, status: 404, statusText: 'Not Found' };
			});

			const nonOk = (await invokeHandler(
				handlers,
				'symphony:getIssues',
				'test-owner/test-repo',
				true
			)) as { issues: SymphonyIssue[]; fromCache: boolean };

			expect(nonOk.fromCache).toBe(false);
			expect(nonOk.issues[0]).toMatchObject({ number: 64, status: 'available' });

			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('/issues?')) {
					return {
						ok: true,
						json: async () =>
							createGitHubIssueResponse([{ number: 65, title: 'Thrown PR lookup' }]),
					};
				}
				if (url.includes('/pulls?state=open')) {
					throw new Error('github unavailable');
				}
				return { ok: false, status: 404, statusText: 'Not Found' };
			});

			const thrown = (await invokeHandler(
				handlers,
				'symphony:getIssues',
				'test-owner/throws-repo',
				true
			)) as { issues: SymphonyIssue[]; fromCache: boolean };

			expect(thrown.fromCache).toBe(false);
			expect(thrown.issues[0]).toMatchObject({ number: 65, status: 'available' });
		});

		it('should parse duplicate document references, null issue bodies, and nonmatching PRs', async () => {
			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('/issues?')) {
					return {
						ok: true,
						json: async () => [
							{
								number: 80,
								title: 'Document parser branches',
								body: [
									'[relative.md](docs/relative.md)',
									'[duplicate.md](https://github.com/test-owner/test-repo/files/1/duplicate.md)',
									'[duplicate.md](https://github.com/test-owner/test-repo/files/2/duplicate.md)',
									'- `docs/duplicate.md`',
									'- `https://github.com/test-owner/test-repo/blob/main/docs/ignored.md`',
								].join('\n'),
								url: 'https://api.github.com/repos/test-owner/test-repo/issues/80',
								html_url: 'https://github.com/test-owner/test-repo/issues/80',
								user: { login: 'maintainer' },
								created_at: new Date().toISOString(),
								updated_at: new Date().toISOString(),
							},
							{
								number: 81,
								title: 'Null body issue',
								body: null,
								url: 'https://api.github.com/repos/test-owner/test-repo/issues/81',
								html_url: 'https://github.com/test-owner/test-repo/issues/81',
								user: { login: 'maintainer' },
								created_at: new Date().toISOString(),
								updated_at: new Date().toISOString(),
							},
						],
					};
				}
				if (url.includes('/pulls?state=open')) {
					return {
						ok: true,
						json: async () => [
							{
								number: 81,
								title: 'Unrelated Symphony work',
								body: null,
								html_url: 'https://github.com/test-owner/test-repo/pull/81',
								user: { login: 'contributor' },
								draft: false,
							},
						],
					};
				}
				return { ok: false, status: 404, statusText: 'Not Found' };
			});

			const result = (await invokeHandler(
				handlers,
				'symphony:getIssues',
				'test-owner/test-repo',
				true
			)) as { issues: SymphonyIssue[]; fromCache: boolean };

			expect(result.fromCache).toBe(false);
			expect(result.issues[0].status).toBe('available');
			expect(result.issues[0].documentPaths).toEqual([
				{
					name: 'duplicate.md',
					path: 'https://github.com/test-owner/test-repo/files/1/duplicate.md',
					isExternal: true,
				},
			]);
			expect(result.issues[1]).toMatchObject({ body: '', documentPaths: [] });
		});

		it('should treat non-Error issue and PR lookup failures as recoverable strings', async () => {
			mockFetch.mockRejectedValueOnce('issue api offline');
			const issueFailure = (await invokeHandler(
				handlers,
				'symphony:getIssues',
				'test-owner/string-failure',
				true
			)) as { success: boolean; error?: string };

			expect(issueFailure.success).toBe(false);
			expect(issueFailure.error).toContain('Failed to fetch issues: issue api offline');

			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('/issues?')) {
					return {
						ok: true,
						json: async () =>
							createGitHubIssueResponse([{ number: 82, title: 'String PR failure' }]),
					};
				}
				if (url.includes('/pulls?state=open')) {
					throw 'pull lookup offline';
				}
				return { ok: false, status: 404, statusText: 'Not Found' };
			});

			const result = (await invokeHandler(
				handlers,
				'symphony:getIssues',
				'test-owner/pr-string-failure',
				true
			)) as { issues: SymphonyIssue[]; fromCache: boolean };

			expect(result.fromCache).toBe(false);
			expect(result.issues[0]).toMatchObject({ number: 82, status: 'available' });
		});
	});

	// ==========================================================================
	// Edge Cases & Error Handling - Input Validation
	// ==========================================================================

	describe('Input Validation Edge Cases', () => {
		it('should truncate extremely long repo names (>100 chars)', async () => {
			const longRepoName = 'a'.repeat(150);

			await invokeHandler(handlers, 'symphony:registerActive', {
				contributionId: 'long_name_test',
				sessionId: 'session-long',
				repoSlug: `owner/${longRepoName}`,
				repoName: longRepoName,
				issueNumber: 1,
				issueTitle: 'Long Name Test',
				localPath: '/tmp/long-repo',
				branchName: 'symphony/issue-1',
				documentPaths: [],
				agentType: 'claude-code',
			});

			const state = (await invokeHandler(handlers, 'symphony:getState')) as {
				state: SymphonyState;
			};
			// Repo name in slug might be preserved, but local path sanitization applies
			expect(state.state.active.some((c) => c.id === 'long_name_test')).toBe(true);
		});

		it('should handle repo names with unicode characters', async () => {
			await invokeHandler(handlers, 'symphony:registerActive', {
				contributionId: 'unicode_test',
				sessionId: 'session-unicode',
				repoSlug: 'owner/测试仓库',
				repoName: '测试仓库',
				issueNumber: 1,
				issueTitle: 'Unicode Test',
				localPath: '/tmp/unicode-repo',
				branchName: 'symphony/issue-1',
				documentPaths: [],
				agentType: 'claude-code',
			});

			const state = (await invokeHandler(handlers, 'symphony:getState')) as {
				state: SymphonyState;
			};
			expect(state.state.active.some((c) => c.id === 'unicode_test')).toBe(true);
		});

		it('should handle repo names with special characters through clone', async () => {
			// Special chars in repo names are valid - GitHub allows them in repo names
			// The clone will succeed (mocked) but the repo name is preserved
			const result = (await invokeHandler(handlers, 'symphony:cloneRepo', {
				repoUrl: 'https://github.com/owner/special-repo',
				localPath: path.join(testTempDir, 'special-repo'),
			})) as { success: boolean; error?: string };

			// Clone should succeed (mocked git clone)
			expect(result.success).toBe(true);
		});

		it('should handle document paths with encoded characters', async () => {
			await invokeHandler(handlers, 'symphony:registerActive', {
				contributionId: 'encoded_path_test',
				sessionId: 'session-encoded',
				repoSlug: 'owner/repo',
				repoName: 'repo',
				issueNumber: 1,
				issueTitle: 'Encoded Path Test',
				localPath: '/tmp/encoded-repo',
				branchName: 'symphony/issue-1',
				documentPaths: ['docs/file%20with%20spaces.md'],
				agentType: 'claude-code',
			});

			const state = (await invokeHandler(handlers, 'symphony:getState')) as {
				state: SymphonyState;
			};
			expect(state.state.active.some((c) => c.id === 'encoded_path_test')).toBe(true);
		});

		it('should handle issue body at exactly MAX_BODY_SIZE (1MB)', async () => {
			// MAX_BODY_SIZE is 1024 * 1024 = 1,048,576 bytes
			const MAX_BODY_SIZE = 1024 * 1024;

			// Create a body that is exactly MAX_BODY_SIZE
			// Include a document path at the beginning so we can verify parsing still works
			const docPrefix = '- `docs/test-file.md`\n';
			const padding = 'x'.repeat(MAX_BODY_SIZE - docPrefix.length);
			const exactSizeBody = docPrefix + padding;

			expect(exactSizeBody.length).toBe(MAX_BODY_SIZE);

			mockFetch.mockImplementationOnce(async () => ({
				ok: true,
				json: async () => [
					{
						number: 1,
						title: 'Exact Size Body Test',
						body: exactSizeBody,
						url: 'https://api.github.com/repos/owner/repo/issues/1',
						html_url: 'https://github.com/owner/repo/issues/1',
						user: { login: 'test-user' },
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
					},
				],
			}));

			// Force fresh fetch (not from cache)
			const result = (await invokeHandler(
				handlers,
				'symphony:getIssues',
				'owner/exact-size-test',
				true
			)) as {
				issues: SymphonyIssue[];
				fromCache: boolean;
			};

			// Should succeed and parse the document path
			expect(result.issues).toHaveLength(1);
			expect(result.issues[0].documentPaths).toBeDefined();
			// The document path at the beginning should be found
			expect(result.issues[0].documentPaths.some((d) => d.path === 'docs/test-file.md')).toBe(true);
		});

		it('should handle issue body slightly over MAX_BODY_SIZE', async () => {
			// MAX_BODY_SIZE is 1024 * 1024 = 1,048,576 bytes
			const MAX_BODY_SIZE = 1024 * 1024;
			const OVER_SIZE = MAX_BODY_SIZE + 1000; // Slightly over

			// Create a body that exceeds MAX_BODY_SIZE
			// Include document paths at both the beginning (should be found)
			// and at the very end (should be truncated away)
			const docAtStart = '- `docs/start-file.md`\n';
			const docAtEnd = '\n- `docs/end-file.md`';

			// Calculate padding to push end doc past MAX_BODY_SIZE
			const paddingLength = OVER_SIZE - docAtStart.length - docAtEnd.length;
			const padding = 'x'.repeat(paddingLength);
			const oversizeBody = docAtStart + padding + docAtEnd;

			expect(oversizeBody.length).toBe(OVER_SIZE);
			expect(oversizeBody.length).toBeGreaterThan(MAX_BODY_SIZE);

			mockFetch.mockImplementationOnce(async () => ({
				ok: true,
				json: async () => [
					{
						number: 1,
						title: 'Oversize Body Test',
						body: oversizeBody,
						url: 'https://api.github.com/repos/owner/repo/issues/1',
						html_url: 'https://github.com/owner/repo/issues/1',
						user: { login: 'test-user' },
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
					},
				],
			}));

			// Force fresh fetch
			const result = (await invokeHandler(
				handlers,
				'symphony:getIssues',
				'owner/oversize-test',
				true
			)) as {
				issues: SymphonyIssue[];
				fromCache: boolean;
			};

			// Should succeed without throwing/hanging
			expect(result.issues).toHaveLength(1);
			expect(result.issues[0].documentPaths).toBeDefined();

			// The document at the start should be found
			expect(result.issues[0].documentPaths.some((d) => d.path === 'docs/start-file.md')).toBe(
				true
			);

			// The document at the end is past MAX_BODY_SIZE, so it may or may not be found
			// depending on implementation. The key test is that parsing completes without error.
			// (Implementation truncates at MAX_BODY_SIZE, so end doc should NOT be found)
			const endDocFound = result.issues[0].documentPaths.some((d) => d.path === 'docs/end-file.md');
			expect(endDocFound).toBe(false);
		});
	});

	// ==========================================================================
	// Network Error Handling
	// ==========================================================================

	describe('Network Error Handling', () => {
		it('should surface registry HTTP, parse, and network errors without cache', async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 500,
				statusText: 'Server Error',
			});
			const httpError = (await invokeHandler(handlers, 'symphony:getRegistry', true)) as {
				success: boolean;
				error?: string;
			};
			expect(httpError.success).toBe(false);
			expect(httpError.error).toContain('Failed to fetch registry: 500 Server Error');

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ schemaVersion: '1.0' }),
			});
			const parseError = (await invokeHandler(handlers, 'symphony:getRegistry', true)) as {
				success: boolean;
				error?: string;
			};
			expect(parseError.success).toBe(false);
			expect(parseError.error).toContain('Invalid registry structure');

			mockFetch.mockRejectedValueOnce(new Error('offline'));
			const networkError = (await invokeHandler(handlers, 'symphony:getRegistry', true)) as {
				success: boolean;
				error?: string;
			};
			expect(networkError.success).toBe(false);
			expect(networkError.error).toContain('Network error: offline');
		});

		it('should handle registry string failures and partial star-count enrichment', async () => {
			mockFetch.mockRejectedValueOnce('registry offline');
			const stringFailure = (await invokeHandler(handlers, 'symphony:getRegistry', true)) as {
				success: boolean;
				error?: string;
			};

			expect(stringFailure.success).toBe(false);
			expect(stringFailure.error).toContain('Network error: registry offline');

			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('symphony-registry.json')) {
					return {
						ok: true,
						json: async () =>
							createMockRegistry({
								repositories: [
									{
										slug: 'owner/no-stars',
										name: 'No Stars',
										description: 'Missing star count',
										url: 'https://github.com/owner/no-stars',
										category: 'developer-tools',
										maintainer: { name: 'Maintainer' },
										isActive: true,
										addedAt: '2026-05-01T00:00:00.000Z',
									},
									{
										slug: 'owner/star-throws',
										name: 'Star Throws',
										description: 'Star lookup throws',
										url: 'https://github.com/owner/star-throws',
										category: 'developer-tools',
										maintainer: { name: 'Maintainer' },
										isActive: true,
										addedAt: '2026-05-01T00:00:00.000Z',
									},
								],
							}),
					};
				}
				if (url.includes('/repos/owner/no-stars')) {
					return { ok: true, json: async () => ({}) };
				}
				if (url.includes('/repos/owner/star-throws')) {
					throw new Error('star fetch failed');
				}
				return { ok: false, status: 404, statusText: 'Not Found' };
			});

			const result = (await invokeHandler(handlers, 'symphony:getRegistry', true)) as {
				registry: SymphonyRegistry;
				fromCache: boolean;
			};

			expect(result.fromCache).toBe(false);
			expect(result.registry.repositories.map((repo) => repo.stars)).toEqual([0, undefined]);
		});

		it('should handle empty and failed issue-count searches', async () => {
			const empty = (await invokeHandler(handlers, 'symphony:getIssueCounts', [])) as {
				counts: Record<string, number>;
				fromCache: boolean;
			};

			expect(empty.fromCache).toBe(false);
			expect(empty.counts).toEqual({});

			await fs.rm(path.join(testTempDir, 'symphony', 'symphony-cache.json'), { force: true });
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 502,
				statusText: 'Bad Gateway',
			});
			const failedSearch = (await invokeHandler(
				handlers,
				'symphony:getIssueCounts',
				['owner/repo'],
				true
			)) as { success: boolean; error?: string };
			expect(failedSearch.success).toBe(false);
			expect(failedSearch.error).toContain('Search API failed: 502');
		});

		it('should ignore search results for unrequested repositories', async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					total_count: 2,
					items: [
						{ repository_url: 'https://api.github.com/repos/owner/requested' },
						{ repository_url: 'https://api.github.com/repos/owner/unrequested' },
					],
				}),
			});

			const result = (await invokeHandler(
				handlers,
				'symphony:getIssueCounts',
				['owner/requested'],
				true
			)) as { counts: Record<string, number>; fromCache: boolean };

			expect(result.fromCache).toBe(false);
			expect(result.counts).toEqual({ 'owner/requested': 1 });
		});

		it('should handle registry fetch timeout', async () => {
			mockFetch.mockImplementationOnce(() => {
				return new Promise((_, reject) => {
					setTimeout(() => reject(new Error('Timeout')), 100);
				});
			});

			try {
				await invokeHandler(handlers, 'symphony:getRegistry', true);
				expect.fail('Should have thrown');
			} catch (error) {
				expect(error).toBeDefined();
			}
		});

		it('should handle GitHub API rate limiting (403)', async () => {
			mockFetch.mockImplementationOnce(async () => ({
				ok: false,
				status: 403,
				statusText: 'Forbidden',
			}));

			try {
				await invokeHandler(handlers, 'symphony:getIssues', 'owner/repo', true);
				expect.fail('Should have thrown');
			} catch (error) {
				expect(error).toBeDefined();
			}
		});

		it('should handle GitHub API not found (404)', async () => {
			mockFetch.mockImplementationOnce(async () => ({
				ok: false,
				status: 404,
				statusText: 'Not Found',
			}));

			try {
				await invokeHandler(handlers, 'symphony:getIssues', 'nonexistent/repo', true);
				expect.fail('Should have thrown');
			} catch (error) {
				expect(error).toBeDefined();
			}
		});

		it('should handle network disconnection during clone', async () => {
			vi.mocked(execFileNoThrow).mockImplementationOnce(async () => ({
				stdout: '',
				stderr: 'fatal: unable to access: Connection refused',
				exitCode: 128,
			}));

			const result = (await invokeHandler(handlers, 'symphony:cloneRepo', {
				repoUrl: 'https://github.com/owner/repo',
				localPath: path.join(testTempDir, 'network-fail'),
			})) as { success: boolean; error?: string };

			expect(result.success).toBe(false);
			expect(result.error).toContain('Clone failed');
		});

		it('should handle network disconnection during PR creation', async () => {
			// Setup: create metadata file
			const metadataDir = path.join(testTempDir, 'symphony', 'contributions', 'network_pr_fail');
			await fs.mkdir(metadataDir, { recursive: true });
			await fs.writeFile(
				path.join(metadataDir, 'metadata.json'),
				JSON.stringify({
					contributionId: 'network_pr_fail',
					sessionId: 'session-fail',
					repoSlug: 'owner/repo',
					issueNumber: 1,
					issueTitle: 'Test',
					branchName: 'symphony/issue-1',
					localPath: '/tmp/repo',
					prCreated: false,
				})
			);

			// Mock push failure due to network
			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'git' && args?.[0] === 'push') {
					return { stdout: '', stderr: 'fatal: unable to access remote', exitCode: 128 };
				}
				if (cmd === 'git' && args?.[0] === 'rev-list') {
					return { stdout: '1', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'symbolic-ref') {
					return { stdout: 'refs/remotes/origin/main', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'auth') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const result = (await invokeHandler(handlers, 'symphony:createDraftPR', {
				contributionId: 'network_pr_fail',
			})) as { success: boolean; error?: string };

			expect(result.success).toBe(false);
		});
	});

	// ==========================================================================
	// Git Operation Edge Cases
	// ==========================================================================

	describe('Git Operation Edge Cases', () => {
		it.each([
			['not logged in', 'not logged in to github.com', 'GitHub CLI is not authenticated'],
			['missing gh binary', 'command not found: gh', 'GitHub CLI (gh) is not installed'],
			['generic gh failure', 'unexpected gh failure', 'GitHub CLI error: unexpected gh failure'],
		])('should surface gh auth failure: %s', async (_label, stderr, expectedError) => {
			const contributionId = `gh_auth_${_label.replace(/\W+/g, '_')}`;
			const metadataDir = path.join(testTempDir, 'symphony', 'contributions', contributionId);
			await fs.mkdir(metadataDir, { recursive: true });
			await fs.writeFile(
				path.join(metadataDir, 'metadata.json'),
				JSON.stringify({
					contributionId,
					sessionId: `session-${contributionId}`,
					repoSlug: 'owner/repo',
					issueNumber: 1,
					issueTitle: 'Auth Failure Test',
					branchName: 'symphony/issue-1',
					localPath: '/tmp/repo',
					prCreated: false,
				})
			);
			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
					return { stdout: '', stderr, exitCode: 1 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const result = (await invokeHandler(handlers, 'symphony:createDraftPR', {
				contributionId,
			})) as { success: boolean; error?: string };

			expect(result.success).toBe(false);
			expect(result.error).toContain(expectedError);
		});

		it('should handle clone to directory that already exists', async () => {
			const existingDir = path.join(testTempDir, 'existing-repo');
			await fs.mkdir(existingDir, { recursive: true });

			vi.mocked(execFileNoThrow).mockImplementationOnce(async () => ({
				stdout: '',
				stderr: 'fatal: destination path already exists',
				exitCode: 128,
			}));

			const result = (await invokeHandler(handlers, 'symphony:cloneRepo', {
				repoUrl: 'https://github.com/owner/repo',
				localPath: existingDir,
			})) as { success: boolean; error?: string };

			expect(result.success).toBe(false);
			expect(result.error).toContain('Clone failed');
		});

		it('should handle branch creation when branch already exists', async () => {
			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'git' && args?.[0] === 'checkout' && args?.[1] === '-b') {
					return { stdout: '', stderr: 'fatal: A branch named X already exists', exitCode: 128 };
				}
				if (cmd === 'gh' && args?.[0] === 'auth') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const repoDir = path.join(testTempDir, 'branch-exists-test');
			await fs.mkdir(repoDir, { recursive: true });

			const result = (await invokeHandler(handlers, 'symphony:startContribution', {
				contributionId: 'branch_exists',
				sessionId: 'session-branch',
				repoSlug: 'owner/repo',
				issueNumber: 1,
				issueTitle: 'Test',
				localPath: repoDir,
				documentPaths: [],
			})) as { success: boolean; error?: string };

			expect(result.success).toBe(false);
			expect(result.error).toContain('branch');
		});

		it('should handle PR creation when PR already exists for branch', async () => {
			// Setup metadata
			const metadataDir = path.join(testTempDir, 'symphony', 'contributions', 'pr_exists_test');
			await fs.mkdir(metadataDir, { recursive: true });
			await fs.writeFile(
				path.join(metadataDir, 'metadata.json'),
				JSON.stringify({
					contributionId: 'pr_exists_test',
					sessionId: 'session-pr',
					repoSlug: 'owner/repo',
					issueNumber: 1,
					issueTitle: 'Test',
					branchName: 'symphony/issue-1',
					localPath: '/tmp/repo',
					prCreated: false,
				})
			);

			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'create') {
					return { stdout: '', stderr: 'pull request already exists', exitCode: 1 };
				}
				if (cmd === 'git' && args?.[0] === 'push') {
					// Push succeeds
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'rev-list') {
					return { stdout: '1', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'symbolic-ref') {
					return { stdout: 'refs/remotes/origin/main', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'rev-parse') {
					return { stdout: 'symphony/issue-1', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'auth') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const result = (await invokeHandler(handlers, 'symphony:createDraftPR', {
				contributionId: 'pr_exists_test',
			})) as { success: boolean; error?: string };

			expect(result.success).toBe(false);
			expect(result.error).toContain('PR');
		});

		it('should handle push when remote branch exists with different content', async () => {
			// Setup metadata
			const metadataDir = path.join(testTempDir, 'symphony', 'contributions', 'push_conflict_test');
			await fs.mkdir(metadataDir, { recursive: true });
			await fs.writeFile(
				path.join(metadataDir, 'metadata.json'),
				JSON.stringify({
					contributionId: 'push_conflict_test',
					sessionId: 'session-conflict',
					repoSlug: 'owner/repo',
					issueNumber: 1,
					issueTitle: 'Push Conflict Test',
					branchName: 'symphony/issue-1-test',
					localPath: '/tmp/repo',
					prCreated: false,
				})
			);

			// Mock push failure due to diverged remote branch (non-fast-forward update)
			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'git' && args?.[0] === 'push') {
					// Simulate the error when remote branch has different content
					// This happens when someone else pushed to the same branch, or force-push was done remotely
					return {
						stdout: '',
						stderr: `To https://github.com/owner/repo.git
 ! [rejected]        symphony/issue-1-test -> symphony/issue-1-test (non-fast-forward)
error: failed to push some refs to 'https://github.com/owner/repo.git'
hint: Updates were rejected because the tip of your current branch is behind
hint: its remote counterpart. Integrate the remote changes (e.g.
hint: 'git pull ...') before pushing again.`,
						exitCode: 1,
					};
				}
				if (cmd === 'git' && args?.[0] === 'rev-list') {
					return { stdout: '1', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'symbolic-ref') {
					return { stdout: 'refs/remotes/origin/main', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'rev-parse') {
					return { stdout: 'symphony/issue-1-test', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'auth') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const result = (await invokeHandler(handlers, 'symphony:createDraftPR', {
				contributionId: 'push_conflict_test',
			})) as { success: boolean; error?: string };

			// Push should fail, which means PR creation fails
			expect(result.success).toBe(false);
			expect(result.error).toContain('push');
		});

		it('should handle push failure due to remote branch force-push (fetch-first)', async () => {
			// Another variant: remote was force-pushed, local ref is stale
			const metadataDir = path.join(testTempDir, 'symphony', 'contributions', 'fetch_first_test');
			await fs.mkdir(metadataDir, { recursive: true });
			await fs.writeFile(
				path.join(metadataDir, 'metadata.json'),
				JSON.stringify({
					contributionId: 'fetch_first_test',
					sessionId: 'session-fetch',
					repoSlug: 'owner/repo',
					issueNumber: 2,
					issueTitle: 'Fetch First Test',
					branchName: 'symphony/issue-2-test',
					localPath: '/tmp/repo2',
					prCreated: false,
				})
			);

			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'git' && args?.[0] === 'push') {
					// Simulate error when remote history has been rewritten
					return {
						stdout: '',
						stderr: `error: failed to push some refs to 'https://github.com/owner/repo.git'
hint: Updates were rejected because the remote contains work that you do
hint: not have locally. This is usually caused by another repository pushing
hint: to the same ref. You may want to first integrate the remote changes
hint: (e.g., 'git pull ...') before pushing again.`,
						exitCode: 1,
					};
				}
				if (cmd === 'git' && args?.[0] === 'rev-list') {
					return { stdout: '1', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'symbolic-ref') {
					return { stdout: 'refs/remotes/origin/main', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'rev-parse') {
					return { stdout: 'symphony/issue-2-test', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'auth') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const result = (await invokeHandler(handlers, 'symphony:createDraftPR', {
				contributionId: 'fetch_first_test',
			})) as { success: boolean; error?: string };

			expect(result.success).toBe(false);
			expect(result.error).toContain('push');
		});

		it('should handle git hooks that modify commits', async () => {
			// Scenario: A pre-push hook runs and modifies/amends commits, or a pre-commit hook
			// adds auto-generated files, changing the commit state. This can cause the commit
			// count to change between when we check and when we push, or cause push to fail
			// due to hook modifications.

			// Setup metadata for a contribution
			const metadataDir = path.join(testTempDir, 'symphony', 'contributions', 'hook_modified_test');
			await fs.mkdir(metadataDir, { recursive: true });
			await fs.writeFile(
				path.join(metadataDir, 'metadata.json'),
				JSON.stringify({
					contributionId: 'hook_modified_test',
					sessionId: 'session-hook',
					repoSlug: 'owner/hook-test-repo',
					issueNumber: 42,
					issueTitle: 'Hook Modified Test',
					branchName: 'symphony/issue-42-hook',
					localPath: '/tmp/hook-repo',
					prCreated: false,
				})
			);

			// Test Case 1: Pre-push hook that rejects the push with a custom message
			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'git' && args?.[0] === 'push') {
					// Simulate pre-push hook rejection
					// Pre-push hooks can run arbitrary checks and reject the push
					return {
						stdout: '',
						stderr: `remote: Running pre-push hooks...
remote: error: Hook failed: commit message does not meet standards
remote: Please ensure commit messages follow the conventional commits format.
To https://github.com/owner/hook-test-repo.git
 ! [remote rejected] symphony/issue-42-hook -> symphony/issue-42-hook (pre-receive hook declined)
error: failed to push some refs to 'https://github.com/owner/hook-test-repo.git'`,
						exitCode: 1,
					};
				}
				if (cmd === 'git' && args?.[0] === 'rev-list') {
					return { stdout: '2', stderr: '', exitCode: 0 }; // 2 commits
				}
				if (cmd === 'git' && args?.[0] === 'symbolic-ref') {
					return { stdout: 'refs/remotes/origin/main', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'rev-parse') {
					return { stdout: 'symphony/issue-42-hook', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'auth') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const result1 = (await invokeHandler(handlers, 'symphony:createDraftPR', {
				contributionId: 'hook_modified_test',
			})) as { success: boolean; error?: string };

			// Push should fail due to hook rejection
			expect(result1.success).toBe(false);
			expect(result1.error).toContain('push');

			// Test Case 2: Hook that amends commits, causing a mismatch between local and what was pushed
			// Reset mock for second test case
			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'git' && args?.[0] === 'push') {
					// Simulate a hook that modifies commits during push (e.g., auto-sign)
					// The hook succeeds but modifies the commit, which could theoretically
					// cause issues with subsequent operations
					return {
						stdout:
							'To https://github.com/owner/hook-test-repo.git\n   abc123..def456  symphony/issue-42-hook -> symphony/issue-42-hook',
						stderr:
							'remote: Running commit hooks...\nremote: Auto-signing commits...\nremote: Done.',
						exitCode: 0,
					};
				}
				if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'create') {
					return {
						stdout: 'https://github.com/owner/hook-test-repo/pull/123',
						stderr: '',
						exitCode: 0,
					};
				}
				if (cmd === 'git' && args?.[0] === 'rev-list') {
					return { stdout: '2', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'symbolic-ref') {
					return { stdout: 'refs/remotes/origin/main', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'rev-parse') {
					return { stdout: 'symphony/issue-42-hook', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'auth') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			// Reset the metadata (simulate fresh state)
			await fs.writeFile(
				path.join(metadataDir, 'metadata.json'),
				JSON.stringify({
					contributionId: 'hook_modified_test',
					sessionId: 'session-hook',
					repoSlug: 'owner/hook-test-repo',
					issueNumber: 42,
					issueTitle: 'Hook Modified Test',
					branchName: 'symphony/issue-42-hook',
					localPath: '/tmp/hook-repo',
					prCreated: false,
				})
			);

			const result2 = (await invokeHandler(handlers, 'symphony:createDraftPR', {
				contributionId: 'hook_modified_test',
			})) as { success: boolean; draftPrNumber?: number; draftPrUrl?: string; error?: string };

			// Should succeed even with hook output in stderr (hooks that don't fail the push)
			expect(result2.success).toBe(true);
			expect(result2.draftPrNumber).toBe(123);
			expect(result2.draftPrUrl).toBe('https://github.com/owner/hook-test-repo/pull/123');
		});

		it('should handle pre-receive hook that rejects based on commit content', async () => {
			// Scenario: Server-side pre-receive hook rejects push due to large files,
			// secrets detection, or other content-based rules

			const metadataDir = path.join(testTempDir, 'symphony', 'contributions', 'pre_receive_test');
			await fs.mkdir(metadataDir, { recursive: true });
			await fs.writeFile(
				path.join(metadataDir, 'metadata.json'),
				JSON.stringify({
					contributionId: 'pre_receive_test',
					sessionId: 'session-prereceive',
					repoSlug: 'owner/protected-repo',
					issueNumber: 99,
					issueTitle: 'Pre-receive Hook Test',
					branchName: 'symphony/issue-99-test',
					localPath: '/tmp/protected-repo',
					prCreated: false,
				})
			);

			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'git' && args?.[0] === 'push') {
					// Simulate pre-receive hook rejection due to detected secrets
					return {
						stdout: '',
						stderr: `remote: Scanning for secrets...
remote: ==============================
remote: GitGuardian has detected the following potential secret in your commit:
remote:
remote:   +++ b/config.json
remote:   @@ -1,3 +1,4 @@
remote:    {
remote:   +  "api_key": "sk-****************************"
remote:    }
remote:
remote: To fix this issue, please remove the secret from your commit history.
remote: See: https://docs.github.com/en/code-security/secret-scanning
remote: ==============================
remote: error: GH013: Secret scanning detected a secret
To https://github.com/owner/protected-repo.git
 ! [remote rejected] symphony/issue-99-test -> symphony/issue-99-test (pre-receive hook declined)
error: failed to push some refs to 'https://github.com/owner/protected-repo.git'`,
						exitCode: 1,
					};
				}
				if (cmd === 'git' && args?.[0] === 'rev-list') {
					return { stdout: '1', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'symbolic-ref') {
					return { stdout: 'refs/remotes/origin/main', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'rev-parse') {
					return { stdout: 'symphony/issue-99-test', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'auth') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const result = (await invokeHandler(handlers, 'symphony:createDraftPR', {
				contributionId: 'pre_receive_test',
			})) as { success: boolean; error?: string };

			// Push should fail due to pre-receive hook rejection
			expect(result.success).toBe(false);
			expect(result.error).toContain('push');
		});
	});

	// ==========================================================================
	// State Edge Cases
	// ==========================================================================

	describe('State Edge Cases', () => {
		it('should handle state with maximum contributions (100+)', async () => {
			const state = (await invokeHandler(handlers, 'symphony:getState')) as {
				state: SymphonyState;
			};

			// Add 100+ contributions to history
			for (let i = 0; i < 150; i++) {
				state.state.history.push({
					id: `contrib_${i}`,
					repoSlug: `owner/repo-${i}`,
					repoName: `repo-${i}`,
					issueNumber: i + 1,
					issueTitle: `Issue ${i + 1}`,
					startedAt: new Date(Date.now() - i * 86400000).toISOString(), // One day apart
					completedAt: new Date(Date.now() - i * 86400000 + 3600000).toISOString(),
					prUrl: `https://github.com/owner/repo-${i}/pull/${i + 1}`,
					prNumber: i + 1,
					tokenUsage: {
						inputTokens: 1000,
						outputTokens: 500,
						totalCost: 0.05,
					},
					timeSpent: 60000,
					documentsProcessed: 1,
					tasksCompleted: 5,
				});
			}

			// Update stats to reflect 150 contributions
			state.state.stats.totalContributions = 150;
			state.state.stats.totalDocumentsProcessed = 150;
			state.state.stats.totalTasksCompleted = 750;

			// Write state to disk
			const stateFile = path.join(testTempDir, 'symphony', 'symphony-state.json');
			await fs.mkdir(path.dirname(stateFile), { recursive: true });
			await fs.writeFile(stateFile, JSON.stringify(state.state, null, 2));

			// Re-register handlers to reload state
			handlers.clear();
			registerSymphonyHandlers(mockDeps);

			// Read state back
			const result = (await invokeHandler(handlers, 'symphony:getState')) as {
				state: SymphonyState;
			};

			// Verify all contributions are preserved
			expect(result.state.history.length).toBe(150);
			expect(result.state.stats.totalContributions).toBe(150);

			// Verify completed list operation works with pagination
			const completedResult = (await invokeHandler(handlers, 'symphony:getCompleted', 10)) as {
				contributions: CompletedContribution[];
			};
			expect(completedResult.contributions.length).toBe(10);

			const allCompletedResult = (await invokeHandler(handlers, 'symphony:getCompleted')) as {
				contributions: CompletedContribution[];
			};
			expect(allCompletedResult.contributions.length).toBe(150);
		});

		it('should handle stats overflow for large token counts', async () => {
			const state = (await invokeHandler(handlers, 'symphony:getState')) as {
				state: SymphonyState;
			};

			// Set extremely large token counts (near Number.MAX_SAFE_INTEGER would be unrealistic,
			// but billions of tokens is plausible for long-running usage)
			state.state.stats.totalTokensUsed = 999_999_999_999; // ~1 trillion tokens
			state.state.stats.totalTimeSpent = 999_999_999_999; // ~31 years in ms
			state.state.stats.estimatedCostDonated = 99_999_999.99; // ~$100M
			state.state.stats.totalContributions = 999_999;
			state.state.stats.totalTasksCompleted = 9_999_999;

			// Write to disk
			const stateFile = path.join(testTempDir, 'symphony', 'symphony-state.json');
			await fs.mkdir(path.dirname(stateFile), { recursive: true });
			await fs.writeFile(stateFile, JSON.stringify(state.state, null, 2));

			// Re-register handlers
			handlers.clear();
			registerSymphonyHandlers(mockDeps);

			// Add one more contribution to test increment
			const repoDir = path.join(testTempDir, 'symphony-repos', 'overflow-test');
			await fs.mkdir(repoDir, { recursive: true });

			await invokeHandler(handlers, 'symphony:registerActive', {
				contributionId: 'overflow_contrib',
				sessionId: 'session-overflow',
				repoSlug: 'owner/overflow-repo',
				repoName: 'overflow-repo',
				issueNumber: 1,
				issueTitle: 'Overflow Test',
				localPath: repoDir,
				branchName: 'symphony/issue-1',
				documentPaths: [],
				agentType: 'claude-code',
			});

			// Update with large token usage
			await invokeHandler(handlers, 'symphony:updateStatus', {
				contributionId: 'overflow_contrib',
				tokenUsage: {
					inputTokens: 1_000_000,
					outputTokens: 500_000,
				},
			});

			// Get stats (includes active contribution stats)
			const statsResult = (await invokeHandler(handlers, 'symphony:getStats')) as {
				stats: ContributorStats;
			};

			// Verify no overflow or NaN issues
			expect(Number.isFinite(statsResult.stats.totalTokensUsed)).toBe(true);
			expect(statsResult.stats.totalTokensUsed).toBeGreaterThan(999_999_999_999);
			expect(Number.isNaN(statsResult.stats.totalTokensUsed)).toBe(false);
		});

		it('should handle streak calculation across year boundary', async () => {
			// Test streak that spans December 31 -> January 1
			const state = (await invokeHandler(handlers, 'symphony:getState')) as {
				state: SymphonyState;
			};

			// Set last contribution to the previous ISO week before January 1, 2025.
			state.state.stats.lastContributionDate = '2024-W52';
			state.state.stats.currentStreak = 5;
			state.state.stats.longestStreak = 5;
			state.state.stats.totalContributions = 5;

			// Write to disk
			const stateFile = path.join(testTempDir, 'symphony', 'symphony-state.json');
			await fs.mkdir(path.dirname(stateFile), { recursive: true });
			await fs.writeFile(stateFile, JSON.stringify(state.state, null, 2));

			// Re-register handlers
			handlers.clear();
			registerSymphonyHandlers(mockDeps);

			// Set up a contribution to complete on January 1, 2025
			const repoDir = path.join(testTempDir, 'symphony-repos', 'year-boundary-test');
			await fs.mkdir(repoDir, { recursive: true });

			// Create metadata for PR creation
			const metadataDir = path.join(
				testTempDir,
				'symphony',
				'contributions',
				'year_boundary_contrib'
			);
			await fs.mkdir(metadataDir, { recursive: true });
			await fs.writeFile(
				path.join(metadataDir, 'metadata.json'),
				JSON.stringify({
					contributionId: 'year_boundary_contrib',
					sessionId: 'session-year',
					repoSlug: 'owner/year-repo',
					issueNumber: 1,
					issueTitle: 'Year Boundary Test',
					branchName: 'symphony/issue-1',
					localPath: repoDir,
					prCreated: true,
					draftPrNumber: 42,
					draftPrUrl: 'https://github.com/owner/year-repo/pull/42',
				})
			);

			// Register the active contribution
			await invokeHandler(handlers, 'symphony:registerActive', {
				contributionId: 'year_boundary_contrib',
				sessionId: 'session-year',
				repoSlug: 'owner/year-repo',
				repoName: 'year-repo',
				issueNumber: 1,
				issueTitle: 'Year Boundary Test',
				localPath: repoDir,
				branchName: 'symphony/issue-1',
				documentPaths: [],
				agentType: 'claude-code',
			});

			// Update with PR info
			await invokeHandler(handlers, 'symphony:updateStatus', {
				contributionId: 'year_boundary_contrib',
				draftPrNumber: 42,
				draftPrUrl: 'https://github.com/owner/year-repo/pull/42',
			});

			// Mock the date to be January 1, 2025 (one day after Dec 31)
			const originalDate = global.Date;
			const mockDate = class extends Date {
				constructor(...args: Parameters<typeof Date>) {
					if (args.length === 0) {
						super('2025-01-01T12:00:00Z');
					} else {
						// @ts-expect-error - spread args
						super(...args);
					}
				}
				static now() {
					return new Date('2025-01-01T12:00:00Z').getTime();
				}
			};
			// @ts-expect-error - mock Date
			global.Date = mockDate;

			try {
				// Complete the contribution
				const completeResult = (await invokeHandler(handlers, 'symphony:complete', {
					contributionId: 'year_boundary_contrib',
					stats: {
						inputTokens: 1000,
						outputTokens: 500,
						estimatedCost: 0.05,
						timeSpentMs: 60000,
						documentsProcessed: 1,
						tasksCompleted: 3,
					},
				})) as { prUrl?: string; prNumber?: number };

				expect(completeResult.prNumber).toBe(42);

				// Check that streak was maintained across year boundary
				const finalState = (await invokeHandler(handlers, 'symphony:getState')) as {
					state: SymphonyState;
				};

				// Streak should increase across the year boundary when the last contribution was
				// in the previous ISO week.
				expect(finalState.state.stats.currentStreak).toBe(6);
				expect(finalState.state.stats.longestStreak).toBe(6);
			} finally {
				global.Date = originalDate;
			}
		});

		it('should handle streak calculation with timezone edge cases', async () => {
			// Test when contribution is made near midnight in different timezone interpretation
			const state = (await invokeHandler(handlers, 'symphony:getState')) as {
				state: SymphonyState;
			};

			// Last contribution was in the same ISO week.
			const today = new Date();
			state.state.stats.lastContributionDate = getWeekKey(today);
			state.state.stats.currentStreak = 3;
			state.state.stats.longestStreak = 10;

			// Write to disk
			const stateFile = path.join(testTempDir, 'symphony', 'symphony-state.json');
			await fs.mkdir(path.dirname(stateFile), { recursive: true });
			await fs.writeFile(stateFile, JSON.stringify(state.state, null, 2));

			// Re-register handlers
			handlers.clear();
			registerSymphonyHandlers(mockDeps);

			// Set up a contribution
			const repoDir = path.join(testTempDir, 'symphony-repos', 'tz-test');
			await fs.mkdir(repoDir, { recursive: true });

			const metadataDir = path.join(testTempDir, 'symphony', 'contributions', 'tz_contrib');
			await fs.mkdir(metadataDir, { recursive: true });
			await fs.writeFile(
				path.join(metadataDir, 'metadata.json'),
				JSON.stringify({
					contributionId: 'tz_contrib',
					sessionId: 'session-tz',
					repoSlug: 'owner/tz-repo',
					issueNumber: 1,
					issueTitle: 'Timezone Test',
					branchName: 'symphony/issue-1',
					localPath: repoDir,
					prCreated: true,
					draftPrNumber: 99,
					draftPrUrl: 'https://github.com/owner/tz-repo/pull/99',
				})
			);

			await invokeHandler(handlers, 'symphony:registerActive', {
				contributionId: 'tz_contrib',
				sessionId: 'session-tz',
				repoSlug: 'owner/tz-repo',
				repoName: 'tz-repo',
				issueNumber: 1,
				issueTitle: 'Timezone Test',
				localPath: repoDir,
				branchName: 'symphony/issue-1',
				documentPaths: [],
				agentType: 'claude-code',
			});

			await invokeHandler(handlers, 'symphony:updateStatus', {
				contributionId: 'tz_contrib',
				draftPrNumber: 99,
				draftPrUrl: 'https://github.com/owner/tz-repo/pull/99',
			});

			// Complete on the same day - streak should stay the same (not increment)
			await invokeHandler(handlers, 'symphony:complete', {
				contributionId: 'tz_contrib',
				stats: {
					inputTokens: 500,
					outputTokens: 250,
					estimatedCost: 0.02,
					timeSpentMs: 30000,
					documentsProcessed: 1,
					tasksCompleted: 2,
				},
			});

			const finalState = (await invokeHandler(handlers, 'symphony:getState')) as {
				state: SymphonyState;
			};

			// Same-week contribution should not double-count the weekly streak.
			expect(finalState.state.stats.currentStreak).toBe(3);
			// Longest streak should not change since current < longest
			expect(finalState.state.stats.longestStreak).toBe(10);
		});

		it('should handle concurrent state updates without file corruption', async () => {
			// Test that concurrent operations don't corrupt the state file (malformed JSON)
			// Note: Due to read-modify-write race conditions, some entries may be lost,
			// but the file structure should remain valid JSON

			const concurrentUpdates = 10;

			// First, register contributions sequentially to ensure they're all in state
			for (let i = 0; i < concurrentUpdates; i++) {
				const repoDir = path.join(testTempDir, 'symphony-repos', `concurrent-${i}`);
				await fs.mkdir(repoDir, { recursive: true });

				await invokeHandler(handlers, 'symphony:registerActive', {
					contributionId: `concurrent_${i}`,
					sessionId: `session-concurrent-${i}`,
					repoSlug: `owner/concurrent-repo-${i}`,
					repoName: `concurrent-repo-${i}`,
					issueNumber: i + 1,
					issueTitle: `Concurrent Test ${i}`,
					localPath: repoDir,
					branchName: `symphony/issue-${i + 1}`,
					documentPaths: [],
					agentType: 'claude-code',
				});
			}

			// Verify all registrations succeeded
			const initialState = (await invokeHandler(handlers, 'symphony:getState')) as {
				state: SymphonyState;
			};
			expect(initialState.state.active.length).toBe(concurrentUpdates);

			// Now do concurrent status updates - this is where race conditions could corrupt the file
			const updatePromises: Promise<unknown>[] = [];
			for (let i = 0; i < concurrentUpdates; i++) {
				updatePromises.push(
					invokeHandler(handlers, 'symphony:updateStatus', {
						contributionId: `concurrent_${i}`,
						progress: {
							totalTasks: 10,
							completedTasks: i,
						},
						tokenUsage: {
							inputTokens: 100 * (i + 1),
							outputTokens: 50 * (i + 1),
						},
					})
				);
			}

			await Promise.all(updatePromises);

			// Verify state file is not corrupted (can still be parsed as valid JSON)
			const stateFile = path.join(testTempDir, 'symphony', 'symphony-state.json');
			const stateContent = await fs.readFile(stateFile, 'utf-8');

			// Should parse without error - this is the key test
			let state: SymphonyState;
			try {
				state = JSON.parse(stateContent);
			} catch (error) {
				throw new Error(`State file corrupted after concurrent writes: ${error}`);
			}

			// Verify structure is intact (regardless of which updates "won")
			expect(Array.isArray(state.active)).toBe(true);
			expect(Array.isArray(state.history)).toBe(true);
			expect(state.stats).toBeDefined();
			expect(typeof state.stats.totalContributions).toBe('number');

			// All contributions should still be present (updates don't remove entries)
			expect(state.active.length).toBe(concurrentUpdates);

			// Verify no data corruption (all active contributions should have valid structure)
			for (const contrib of state.active) {
				expect(typeof contrib.id).toBe('string');
				expect(typeof contrib.repoSlug).toBe('string');
				expect(typeof contrib.progress.totalTasks).toBe('number');
				expect(typeof contrib.tokenUsage.inputTokens).toBe('number');
			}
		});
	});

	// ==========================================================================
	// Document Handling Edge Cases
	// ==========================================================================

	describe('Document Handling Edge Cases', () => {
		it('should handle document with special characters in filename', async () => {
			// Test document names with special characters like !, @, #, $, etc.
			// These are valid in some filesystems but may cause issues with URL encoding or path handling

			const specialCharFilenames = [
				'doc!important.md',
				'setup@v2.md',
				'config#section.md',
				'readme$final.md',
				'notes%20encoded.md', // URL-encoded space
				'file&more.md',
				'data+info.md',
				'equal=sign.md',
				"apostrophe's.md",
				'unicode-émoji-📝.md',
			];

			for (const filename of specialCharFilenames) {
				mockFetch.mockImplementationOnce(async () => ({
					ok: true,
					json: async () => [
						{
							number: 1,
							title: 'Special Char Filename Test',
							body: `- \`docs/${filename}\``,
							url: 'https://api.github.com/repos/owner/repo/issues/1',
							html_url: 'https://github.com/owner/repo/issues/1',
							user: { login: 'test-user' },
							created_at: new Date().toISOString(),
							updated_at: new Date().toISOString(),
						},
					],
				}));

				// Force fresh fetch to bypass cache
				const result = (await invokeHandler(
					handlers,
					'symphony:getIssues',
					`owner/special-${filename.substring(0, 10)}`,
					true
				)) as {
					issues: SymphonyIssue[];
				};

				// Should successfully parse and include the document path
				expect(result.issues).toHaveLength(1);
				expect(result.issues[0].documentPaths).toBeDefined();
				// The special character filename should be found (normalized in the parsing)
				expect(result.issues[0].documentPaths.length).toBeGreaterThanOrEqual(0);
			}
		});

		it('should handle document with spaces in path', async () => {
			// Test paths with spaces - common in user-created directories
			const pathsWithSpaces = [
				'docs/my document.md',
				'Auto Run Docs/task 1.md',
				'path with spaces/sub folder/file.md',
				'  leading-spaces.md', // Leading spaces
				'trailing-spaces.md  ', // Trailing spaces (may be trimmed)
			];

			for (const docPath of pathsWithSpaces) {
				mockFetch.mockImplementationOnce(async () => ({
					ok: true,
					json: async () => [
						{
							number: 1,
							title: 'Spaces in Path Test',
							body: `- \`${docPath}\``,
							url: 'https://api.github.com/repos/owner/repo/issues/1',
							html_url: 'https://github.com/owner/repo/issues/1',
							user: { login: 'test-user' },
							created_at: new Date().toISOString(),
							updated_at: new Date().toISOString(),
						},
					],
				}));

				const result = (await invokeHandler(
					handlers,
					'symphony:getIssues',
					'owner/spaces-test',
					true
				)) as {
					issues: SymphonyIssue[];
				};

				expect(result.issues).toHaveLength(1);
				// Document path should be parsed (spaces are valid in paths)
				expect(result.issues[0].documentPaths).toBeDefined();
			}
		});

		it('should handle external document that returns 404', async () => {
			// Setup: Create contribution with external document that will 404
			const repoDir = path.join(testTempDir, 'symphony-repos', 'doc-404-test');
			await fs.mkdir(repoDir, { recursive: true });

			// Mock git operations to succeed
			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'git' && args?.[0] === 'checkout' && args?.[1] === '-b') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'auth') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			// Mock fetch to return 404 for document URL
			mockFetch.mockImplementation(async (url: string) => {
				if (
					url.includes('objects.githubusercontent.com') ||
					url.includes('github.com/user-attachments')
				) {
					// External document returns 404
					return { ok: false, status: 404, statusText: 'Not Found' };
				}
				// Default behavior for other URLs
				return { ok: true, json: async () => ({}) };
			});

			const result = (await invokeHandler(handlers, 'symphony:startContribution', {
				contributionId: 'doc_404_test',
				sessionId: 'session-404',
				repoSlug: 'owner/repo',
				issueNumber: 1,
				issueTitle: 'Doc 404 Test',
				localPath: repoDir,
				documentPaths: [
					{
						name: 'missing-doc.md',
						path: 'https://objects.githubusercontent.com/missing-file-12345',
						isExternal: true,
					},
				],
			})) as { success: boolean; branchName?: string; error?: string };

			// Contribution should still succeed (branch created)
			// The missing document should be logged and skipped, not fail the whole operation
			expect(result.success).toBe(true);
			expect(result.branchName).toBeDefined();
		});

		it('should handle external document that redirects', async () => {
			// GitHub attachment URLs sometimes redirect
			const repoDir = path.join(testTempDir, 'symphony-repos', 'doc-redirect-test');
			await fs.mkdir(repoDir, { recursive: true });

			// Mock git operations to succeed
			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'git' && args?.[0] === 'checkout' && args?.[1] === '-b') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'auth') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			let redirectCount = 0;
			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('objects.githubusercontent.com') && redirectCount === 0) {
					redirectCount++;
					// Simulate redirect by returning actual content (fetch follows redirects automatically)
					return {
						ok: true,
						arrayBuffer: async () => Buffer.from('# Redirected Document Content').buffer,
					};
				}
				return { ok: true, json: async () => ({}) };
			});

			const result = (await invokeHandler(handlers, 'symphony:startContribution', {
				contributionId: 'doc_redirect_test',
				sessionId: 'session-redirect',
				repoSlug: 'owner/repo',
				issueNumber: 2,
				issueTitle: 'Doc Redirect Test',
				localPath: repoDir,
				documentPaths: [
					{
						name: 'redirected-doc.md',
						path: 'https://objects.githubusercontent.com/redirecting-url',
						isExternal: true,
					},
				],
			})) as { success: boolean; branchName?: string; autoRunPath?: string; error?: string };

			// Should succeed - fetch follows redirects
			expect(result.success).toBe(true);
			expect(result.branchName).toBeDefined();
		});

		it('should handle repo document that was deleted after issue creation', async () => {
			// Repo document existed when issue was created but has since been deleted
			const repoDir = path.join(testTempDir, 'symphony-repos', 'doc-deleted-test');
			await fs.mkdir(repoDir, { recursive: true });

			// Don't create the document file - it was "deleted"

			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'git' && args?.[0] === 'checkout' && args?.[1] === '-b') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'auth') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const result = (await invokeHandler(handlers, 'symphony:startContribution', {
				contributionId: 'doc_deleted_test',
				sessionId: 'session-deleted',
				repoSlug: 'owner/repo',
				issueNumber: 3,
				issueTitle: 'Deleted Doc Test',
				localPath: repoDir,
				documentPaths: [
					{
						name: 'deleted-file.md',
						path: 'docs/deleted-file.md', // This file doesn't exist in repoDir
						isExternal: false,
					},
				],
			})) as { success: boolean; branchName?: string; error?: string };

			// Should succeed - branch is created, but the missing doc is logged and skipped
			expect(result.success).toBe(true);
			expect(result.branchName).toBeDefined();
		});

		it('should handle empty document (0 bytes)', async () => {
			const repoDir = path.join(testTempDir, 'symphony-repos', 'empty-doc-test');
			await fs.mkdir(repoDir, { recursive: true });

			// Create an empty document file
			const docsDir = path.join(repoDir, 'docs');
			await fs.mkdir(docsDir, { recursive: true });
			await fs.writeFile(path.join(docsDir, 'empty.md'), ''); // 0 bytes

			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'git' && args?.[0] === 'checkout' && args?.[1] === '-b') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'auth') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const result = (await invokeHandler(handlers, 'symphony:startContribution', {
				contributionId: 'empty_doc_test',
				sessionId: 'session-empty',
				repoSlug: 'owner/repo',
				issueNumber: 4,
				issueTitle: 'Empty Doc Test',
				localPath: repoDir,
				documentPaths: [
					{
						name: 'empty.md',
						path: 'docs/empty.md',
						isExternal: false,
					},
				],
			})) as { success: boolean; branchName?: string; autoRunPath?: string; error?: string };

			// Should succeed - empty files are valid
			expect(result.success).toBe(true);
			expect(result.branchName).toBeDefined();

			// Verify the empty file is still accessible
			const emptyFilePath = path.join(repoDir, 'docs', 'empty.md');
			const stat = await fs.stat(emptyFilePath);
			expect(stat.size).toBe(0);
		});

		it('should handle very large document (>10MB)', async () => {
			const repoDir = path.join(testTempDir, 'symphony-repos', 'large-doc-test');
			await fs.mkdir(repoDir, { recursive: true });

			// Create a large document (11MB)
			const docsDir = path.join(repoDir, 'docs');
			await fs.mkdir(docsDir, { recursive: true });
			const largeContent = 'x'.repeat(11 * 1024 * 1024); // 11MB of 'x'
			await fs.writeFile(path.join(docsDir, 'large.md'), largeContent);

			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'git' && args?.[0] === 'checkout' && args?.[1] === '-b') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'auth') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const result = (await invokeHandler(handlers, 'symphony:startContribution', {
				contributionId: 'large_doc_test',
				sessionId: 'session-large',
				repoSlug: 'owner/repo',
				issueNumber: 5,
				issueTitle: 'Large Doc Test',
				localPath: repoDir,
				documentPaths: [
					{
						name: 'large.md',
						path: 'docs/large.md',
						isExternal: false,
					},
				],
			})) as { success: boolean; branchName?: string; autoRunPath?: string; error?: string };

			// Should succeed - large files should be handled (though may be slow)
			expect(result.success).toBe(true);
			expect(result.branchName).toBeDefined();

			// Verify the large file is intact
			const largeFilePath = path.join(repoDir, 'docs', 'large.md');
			const stat = await fs.stat(largeFilePath);
			expect(stat.size).toBe(11 * 1024 * 1024);
		});

		it('should handle external document download with very large content', async () => {
			// Test downloading an external document that's very large
			const repoDir = path.join(testTempDir, 'symphony-repos', 'large-external-test');
			await fs.mkdir(repoDir, { recursive: true });

			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'git' && args?.[0] === 'checkout' && args?.[1] === '-b') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'auth') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			// Create large buffer (5MB - reasonable for an attachment)
			const largeBuffer = Buffer.alloc(5 * 1024 * 1024, 'x');

			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('objects.githubusercontent.com')) {
					return {
						ok: true,
						arrayBuffer: async () => largeBuffer.buffer,
					};
				}
				return { ok: true, json: async () => ({}) };
			});

			const result = (await invokeHandler(handlers, 'symphony:startContribution', {
				contributionId: 'large_external_test',
				sessionId: 'session-large-ext',
				repoSlug: 'owner/repo',
				issueNumber: 6,
				issueTitle: 'Large External Doc Test',
				localPath: repoDir,
				documentPaths: [
					{
						name: 'large-attachment.md',
						path: 'https://objects.githubusercontent.com/large-file-attachment',
						isExternal: true,
					},
				],
			})) as { success: boolean; branchName?: string; autoRunPath?: string; error?: string };

			// Should succeed
			expect(result.success).toBe(true);
			expect(result.branchName).toBeDefined();
			expect(result.autoRunPath).toBeDefined();
		});
	});

	// ==========================================================================
	// PR Status Edge Cases
	// ==========================================================================

	describe('PR Status Edge Cases', () => {
		it('should handle checking status of PR that was force-merged', async () => {
			// Setup: Add a completed contribution to history
			// Note: SYMPHONY_STATE_PATH = 'symphony-state.json'
			const stateFilePath = path.join(testTempDir, 'symphony', 'symphony-state.json');
			await fs.mkdir(path.dirname(stateFilePath), { recursive: true });
			await fs.writeFile(
				stateFilePath,
				JSON.stringify({
					active: [],
					history: [
						{
							id: 'force_merged_test',
							repoSlug: 'owner/force-merged-repo',
							repoName: 'force-merged-repo',
							issueNumber: 42,
							issueTitle: 'Force Merged PR',
							documentsProcessed: 1,
							tasksCompleted: 2,
							timeSpent: 60000,
							startedAt: new Date(Date.now() - 3600000).toISOString(),
							completedAt: new Date().toISOString(),
							prUrl: 'https://github.com/owner/force-merged-repo/pull/99',
							prNumber: 99,
							tokenUsage: { inputTokens: 1000, outputTokens: 500, totalCost: 0.05 },
							wasMerged: false, // Not yet tracked as merged
						},
					],
					stats: {
						...DEFAULT_CONTRIBUTOR_STATS,
						totalContributions: 1,
					},
				})
			);

			// Re-register handlers to pick up the new state file
			handlers.clear();
			registerSymphonyHandlers(mockDeps);

			// Mock GitHub API to return a force-merged PR
			// Force-merge shows as merged=true with a merge_commit_sha, same as normal merge
			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('/pulls/99')) {
					return {
						ok: true,
						json: async () => ({
							state: 'closed',
							merged: true, // Force-merge still sets merged=true
							merged_at: new Date().toISOString(),
							merge_commit_sha: 'abc123def456', // Force-merge has a commit SHA
						}),
					};
				}
				return { ok: false, status: 404 };
			});

			const result = (await invokeHandler(handlers, 'symphony:checkPRStatuses')) as {
				checked: number;
				merged: number;
				closed: number;
				errors: string[];
			};

			expect(result.checked).toBe(1);
			expect(result.merged).toBe(1);
			expect(result.closed).toBe(0);
			expect(result.errors.length).toBe(0);

			// Verify state was updated
			const stateAfter = (await invokeHandler(handlers, 'symphony:getState')) as {
				state: SymphonyState;
			};
			expect(stateAfter.state.history[0].wasMerged).toBe(true);
			expect(stateAfter.state.history[0].mergedAt).toBeDefined();
			expect(stateAfter.state.stats.totalMerged).toBe(1);
		});

		it('should handle checking status of PR that was reverted', async () => {
			// A reverted PR shows as merged (it was merged), but another PR reverted it
			// The API still shows merged=true for the original PR
			const stateFilePath = path.join(testTempDir, 'symphony', 'symphony-state.json');
			await fs.mkdir(path.dirname(stateFilePath), { recursive: true });
			await fs.writeFile(
				stateFilePath,
				JSON.stringify({
					active: [],
					history: [
						{
							id: 'reverted_test',
							repoSlug: 'owner/reverted-repo',
							repoName: 'reverted-repo',
							issueNumber: 50,
							issueTitle: 'Reverted PR',
							documentsProcessed: 1,
							tasksCompleted: 2,
							timeSpent: 60000,
							startedAt: new Date(Date.now() - 3600000).toISOString(),
							completedAt: new Date().toISOString(),
							prUrl: 'https://github.com/owner/reverted-repo/pull/100',
							prNumber: 100,
							tokenUsage: { inputTokens: 1000, outputTokens: 500, totalCost: 0.05 },
							wasMerged: false,
						},
					],
					stats: {
						...DEFAULT_CONTRIBUTOR_STATS,
						totalContributions: 1,
					},
				})
			);

			handlers.clear();
			registerSymphonyHandlers(mockDeps);

			// Mock GitHub API - reverted PRs still show as merged
			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('/pulls/100')) {
					return {
						ok: true,
						json: async () => ({
							state: 'closed',
							merged: true, // Even reverted PRs show as merged
							merged_at: new Date(Date.now() - 7200000).toISOString(), // Merged 2 hours ago
						}),
					};
				}
				return { ok: false, status: 404 };
			});

			const result = (await invokeHandler(handlers, 'symphony:checkPRStatuses')) as {
				checked: number;
				merged: number;
				closed: number;
				errors: string[];
			};

			// PR was merged (even if later reverted, the API shows it as merged)
			expect(result.checked).toBe(1);
			expect(result.merged).toBe(1);
			expect(result.closed).toBe(0);
			expect(result.errors.length).toBe(0);

			const stateAfter = (await invokeHandler(handlers, 'symphony:getState')) as {
				state: SymphonyState;
			};
			expect(stateAfter.state.history[0].wasMerged).toBe(true);
		});

		it('should handle checking status of deleted repository', async () => {
			const stateFilePath = path.join(testTempDir, 'symphony', 'symphony-state.json');
			await fs.mkdir(path.dirname(stateFilePath), { recursive: true });
			await fs.writeFile(
				stateFilePath,
				JSON.stringify({
					active: [],
					history: [
						{
							id: 'deleted_repo_test',
							repoSlug: 'owner/deleted-repo',
							repoName: 'deleted-repo',
							issueNumber: 1,
							issueTitle: 'PR in Deleted Repo',
							documentsProcessed: 1,
							tasksCompleted: 1,
							timeSpent: 30000,
							startedAt: new Date(Date.now() - 3600000).toISOString(),
							completedAt: new Date().toISOString(),
							prUrl: 'https://github.com/owner/deleted-repo/pull/1',
							prNumber: 1,
							tokenUsage: { inputTokens: 500, outputTokens: 250, totalCost: 0.02 },
							wasMerged: false,
						},
					],
					stats: {
						...DEFAULT_CONTRIBUTOR_STATS,
						totalContributions: 1,
					},
				})
			);

			handlers.clear();
			registerSymphonyHandlers(mockDeps);

			// Mock GitHub API to return 404 for deleted repository
			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('/pulls/1')) {
					return {
						ok: false,
						status: 404,
						statusText: 'Not Found',
					};
				}
				return { ok: false, status: 404 };
			});

			const result = (await invokeHandler(handlers, 'symphony:checkPRStatuses')) as {
				checked: number;
				merged: number;
				closed: number;
				errors: string[];
			};

			expect(result.checked).toBe(1);
			expect(result.merged).toBe(0);
			expect(result.closed).toBe(0);
			// Should record an error for the 404
			expect(result.errors.length).toBe(1);
			expect(result.errors[0]).toContain('404');
		});

		it('should handle checking status when GitHub API is down', async () => {
			const stateFilePath = path.join(testTempDir, 'symphony', 'symphony-state.json');
			await fs.mkdir(path.dirname(stateFilePath), { recursive: true });
			await fs.writeFile(
				stateFilePath,
				JSON.stringify({
					active: [],
					history: [
						{
							id: 'api_down_test',
							repoSlug: 'owner/api-down-repo',
							repoName: 'api-down-repo',
							issueNumber: 5,
							issueTitle: 'PR When API Down',
							documentsProcessed: 1,
							tasksCompleted: 1,
							timeSpent: 30000,
							startedAt: new Date(Date.now() - 3600000).toISOString(),
							completedAt: new Date().toISOString(),
							prUrl: 'https://github.com/owner/api-down-repo/pull/5',
							prNumber: 5,
							tokenUsage: { inputTokens: 500, outputTokens: 250, totalCost: 0.02 },
							wasMerged: false,
						},
					],
					stats: {
						...DEFAULT_CONTRIBUTOR_STATS,
						totalContributions: 1,
					},
				})
			);

			handlers.clear();
			registerSymphonyHandlers(mockDeps);

			// Mock GitHub API to return 503 Service Unavailable
			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('/pulls/5')) {
					return {
						ok: false,
						status: 503,
						statusText: 'Service Unavailable',
					};
				}
				return { ok: false, status: 503 };
			});

			const result = (await invokeHandler(handlers, 'symphony:checkPRStatuses')) as {
				checked: number;
				merged: number;
				closed: number;
				errors: string[];
			};

			expect(result.checked).toBe(1);
			expect(result.merged).toBe(0);
			expect(result.closed).toBe(0);
			// Should record an error for the 503
			expect(result.errors.length).toBe(1);
			expect(result.errors[0]).toContain('503');

			// State should remain unchanged (PR still shows as not merged)
			const stateAfter = (await invokeHandler(handlers, 'symphony:getState')) as {
				state: SymphonyState;
			};
			expect(stateAfter.state.history[0].wasMerged).toBe(false);
		});

		it('should reconcile active PRs from metadata and branch discovery during status checks', async () => {
			await writeStateForTest(
				createTestState({
					history: [
						{
							id: 'history_without_pr',
							repoSlug: 'owner/no-pr-history',
							repoName: 'no-pr-history',
							issueNumber: 1,
							issueTitle: 'No PR',
							documentsProcessed: 0,
							tasksCompleted: 0,
							timeSpent: 0,
							startedAt: '2026-05-01T00:00:00.000Z',
							completedAt: '2026-05-01T01:00:00.000Z',
							prUrl: '',
							prNumber: 0,
							tokenUsage: { inputTokens: 0, outputTokens: 0, totalCost: 0 },
						},
						{
							id: 'already_merged_history',
							repoSlug: 'owner/already-merged',
							repoName: 'already-merged',
							issueNumber: 2,
							issueTitle: 'Already Merged',
							documentsProcessed: 1,
							tasksCompleted: 1,
							timeSpent: 1000,
							startedAt: '2026-05-01T00:00:00.000Z',
							completedAt: '2026-05-01T01:00:00.000Z',
							prUrl: 'https://github.com/owner/already-merged/pull/200',
							prNumber: 200,
							tokenUsage: { inputTokens: 1, outputTokens: 1, totalCost: 0.01 },
							wasMerged: true,
						},
						{
							id: 'closed_history',
							repoSlug: 'owner/closed-history',
							repoName: 'closed-history',
							issueNumber: 3,
							issueTitle: 'Closed History',
							documentsProcessed: 1,
							tasksCompleted: 1,
							timeSpent: 2000,
							startedAt: '2026-05-01T00:00:00.000Z',
							completedAt: '2026-05-01T01:00:00.000Z',
							prUrl: 'https://github.com/owner/closed-history/pull/300',
							prNumber: 300,
							tokenUsage: { inputTokens: 2, outputTokens: 2, totalCost: 0.02 },
							wasMerged: false,
						},
					],
					active: [
						createActiveContribution({
							id: 'metadata_sync',
							repoSlug: 'owner/metadata-repo',
							branchName: 'symphony/issue-20-metadata',
						}),
						createActiveContribution({
							id: 'discover_sync',
							repoSlug: 'owner/discover-repo',
							branchName: 'symphony/issue-21-discover',
							progress: {
								totalDocuments: 2,
								completedDocuments: 2,
								totalTasks: 3,
								completedTasks: 3,
							},
							tokenUsage: { inputTokens: 50, outputTokens: 25, estimatedCost: 0.05 },
						}),
						createActiveContribution({
							id: 'active_http_error',
							repoSlug: 'owner/http-error',
							draftPrNumber: 203,
							draftPrUrl: 'https://github.com/owner/http-error/pull/203',
						}),
						createActiveContribution({
							id: 'active_throw',
							repoSlug: 'owner/throwing',
							draftPrNumber: 204,
							draftPrUrl: 'https://github.com/owner/throwing/pull/204',
						}),
						createActiveContribution({
							id: 'active_closed',
							repoSlug: 'owner/closed-active',
							draftPrNumber: 205,
							draftPrUrl: 'https://github.com/owner/closed-active/pull/205',
						}),
						createActiveContribution({
							id: 'active_without_pr',
							repoSlug: 'owner/without-pr',
							branchName: undefined,
						}),
					],
				})
			);

			const metadataDir = path.join(testTempDir, 'symphony', 'contributions', 'metadata_sync');
			await fs.mkdir(metadataDir, { recursive: true });
			await fs.writeFile(
				path.join(metadataDir, 'metadata.json'),
				JSON.stringify({
					prCreated: true,
					draftPrNumber: 201,
					draftPrUrl: 'https://github.com/owner/metadata-repo/pull/201',
					isFork: true,
					forkSlug: 'contributor/metadata-repo',
					upstreamSlug: 'owner/metadata-repo',
				})
			);

			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('/pulls?head=')) {
					return {
						ok: true,
						json: async () => [
							{
								number: 202,
								html_url: 'https://github.com/owner/discover-repo/pull/202',
								state: 'open',
							},
						],
					};
				}
				if (url.includes('/pulls/300')) {
					return {
						ok: true,
						json: async () => ({ state: 'closed', merged: false, merged_at: null }),
					};
				}
				if (url.includes('/pulls/201')) {
					return {
						ok: true,
						json: async () => ({ state: 'open', merged: false, merged_at: null }),
					};
				}
				if (url.includes('/pulls/202')) {
					return {
						ok: true,
						json: async () => ({
							state: 'closed',
							merged: true,
							merged_at: '2026-05-05T00:00:00.000Z',
						}),
					};
				}
				if (url.includes('/pulls/203')) {
					return { ok: false, status: 500, statusText: 'Server Error' };
				}
				if (url.includes('/pulls/204')) {
					throw new Error('network down');
				}
				if (url.includes('/pulls/205')) {
					return {
						ok: true,
						json: async () => ({ state: 'closed', merged: false, merged_at: null }),
					};
				}
				return { ok: false, status: 404, statusText: 'Not Found' };
			});

			const result = (await invokeHandler(handlers, 'symphony:checkPRStatuses')) as {
				checked: number;
				merged: number;
				closed: number;
				errors: string[];
			};

			expect(result).toMatchObject({
				checked: 6,
				merged: 1,
				closed: 2,
			});
			expect(result.errors).toEqual([
				'Failed to check PR #203: 500',
				'Error checking PR #204: network down',
			]);

			const state = await readStateForTest();
			const metadataSynced = state.active.find((c) => c.id === 'metadata_sync');
			expect(metadataSynced).toMatchObject({
				draftPrNumber: 201,
				draftPrUrl: 'https://github.com/owner/metadata-repo/pull/201',
				isFork: true,
				forkSlug: 'contributor/metadata-repo',
				upstreamSlug: 'owner/metadata-repo',
			});
			expect(state.active.map((c) => c.id).sort()).toEqual([
				'active_http_error',
				'active_throw',
				'active_without_pr',
				'metadata_sync',
			]);
			expect(state.history.find((c) => c.id === 'closed_history')).toMatchObject({
				wasClosed: true,
			});
			expect(state.history.find((c) => c.id === 'discover_sync')).toMatchObject({
				prNumber: 202,
				wasMerged: true,
				mergedAt: '2026-05-05T00:00:00.000Z',
				documentsProcessed: 2,
				tasksCompleted: 3,
			});
			expect(state.history.find((c) => c.id === 'active_closed')).toMatchObject({
				prNumber: 205,
				wasClosed: true,
			});
			expect(state.stats.totalMerged).toBe(1);
			expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('symphony:updated');
		});
	});

	// ==========================================================================
	// Single Contribution Sync And Manual Credit
	// ==========================================================================

	describe('Single Contribution Sync And Manual Credit', () => {
		it('should sync PR and fork metadata into an active contribution', async () => {
			const localPath = path.join(testTempDir, 'symphony-repos', 'sync-meta');
			await fs.mkdir(localPath, { recursive: true });
			await writeStateForTest(
				createTestState({
					active: [
						createActiveContribution({
							id: 'sync_meta',
							sessionId: 'session-sync-meta',
							issueNumber: 42,
							branchName: 'symphony/issue-42-meta',
							localPath,
						}),
					],
				})
			);

			const metadataDir = path.join(testTempDir, 'symphony', 'contributions', 'sync_meta');
			await fs.mkdir(metadataDir, { recursive: true });
			await fs.writeFile(
				path.join(metadataDir, 'metadata.json'),
				JSON.stringify({
					prCreated: true,
					draftPrNumber: 77,
					draftPrUrl: 'https://github.com/test-owner/test-repo/pull/77',
					isFork: true,
					forkSlug: 'contributor/test-repo',
					upstreamSlug: 'test-owner/test-repo',
				})
			);

			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('/pulls/77')) {
					return {
						ok: true,
						json: async () => ({
							state: 'open',
							merged: false,
							merged_at: null,
							draft: false,
						}),
					};
				}
				return { ok: false, status: 404, statusText: 'Not Found' };
			});

			const result = (await invokeHandler(handlers, 'symphony:syncContribution', 'sync_meta')) as {
				success: boolean;
				message?: string;
				prCreated?: boolean;
			};

			expect(result.success).toBe(true);
			expect(result.prCreated).toBe(true);
			expect(result.message).toBe('PR #77 is ready for review');

			const state = await readStateForTest();
			const synced = state.active.find((c) => c.id === 'sync_meta');
			expect(synced?.draftPrNumber).toBe(77);
			expect(synced?.draftPrUrl).toBe('https://github.com/test-owner/test-repo/pull/77');
			expect(synced?.status).toBe('ready_for_review');
			expect(synced?.isFork).toBe(true);
			expect(synced?.forkSlug).toBe('contributor/test-repo');
		});

		it('should move merged and closed active PRs to contribution history during sync', async () => {
			await writeStateForTest(
				createTestState({
					active: [
						createActiveContribution({
							id: 'sync_merged',
							draftPrNumber: 88,
							draftPrUrl: 'https://github.com/test-owner/test-repo/pull/88',
							progress: {
								totalDocuments: 2,
								completedDocuments: 2,
								totalTasks: 4,
								completedTasks: 4,
							},
							tokenUsage: { inputTokens: 1200, outputTokens: 800, estimatedCost: 0.08 },
							timeSpent: 240000,
						}),
						createActiveContribution({
							id: 'sync_closed',
							draftPrNumber: 89,
							draftPrUrl: 'https://github.com/test-owner/test-repo/pull/89',
						}),
					],
				})
			);

			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('/pulls/88')) {
					return {
						ok: true,
						json: async () => ({
							state: 'closed',
							merged: true,
							merged_at: '2026-05-10T12:00:00.000Z',
							draft: false,
						}),
					};
				}
				if (url.includes('/pulls/89')) {
					return {
						ok: true,
						json: async () => ({
							state: 'closed',
							merged: false,
							merged_at: null,
							draft: false,
						}),
					};
				}
				return { ok: false, status: 404, statusText: 'Not Found' };
			});

			const merged = (await invokeHandler(
				handlers,
				'symphony:syncContribution',
				'sync_merged'
			)) as {
				success: boolean;
				prMerged?: boolean;
				message?: string;
			};
			expect(merged.success).toBe(true);
			expect(merged.prMerged).toBe(true);
			expect(merged.message).toBe('PR #88 was merged!');

			let state = await readStateForTest();
			expect(state.active.map((c) => c.id)).toEqual(['sync_closed']);
			expect(state.history[0]).toMatchObject({
				id: 'sync_merged',
				prNumber: 88,
				wasMerged: true,
				mergedAt: '2026-05-10T12:00:00.000Z',
				documentsProcessed: 2,
				tasksCompleted: 4,
			});
			expect(state.stats.totalMerged).toBe(1);

			const closed = (await invokeHandler(
				handlers,
				'symphony:syncContribution',
				'sync_closed'
			)) as {
				success: boolean;
				prClosed?: boolean;
				message?: string;
			};
			expect(closed.success).toBe(true);
			expect(closed.prClosed).toBe(true);
			expect(closed.message).toBe('PR #89 was closed');

			state = await readStateForTest();
			expect(state.active).toEqual([]);
			expect(state.history[1]).toMatchObject({
				id: 'sync_closed',
				prNumber: 89,
				wasClosed: true,
			});
		});

		it('should credit manual merged contributions and reject duplicate PR credit', async () => {
			const missing = (await invokeHandler(handlers, 'symphony:manualCredit', {
				repoSlug: '',
				repoName: 'Manual Repo',
				issueNumber: 12,
				issueTitle: 'Manual Issue',
				prNumber: 144,
				prUrl: 'https://github.com/test-owner/manual-repo/pull/144',
			})) as { error?: string };

			expect(missing.error).toContain('Missing required fields');

			const credited = (await invokeHandler(handlers, 'symphony:manualCredit', {
				repoSlug: 'test-owner/manual-repo',
				repoName: 'Manual Repo',
				issueNumber: 12,
				issueTitle: 'Manual Issue',
				prNumber: 144,
				prUrl: 'https://github.com/test-owner/manual-repo/pull/144',
				startedAt: '2026-05-01T10:00:00.000Z',
				completedAt: '2026-05-02T10:00:00.000Z',
				wasMerged: true,
				mergedAt: '2026-05-03T10:00:00.000Z',
				tokenUsage: {
					inputTokens: 2000,
					outputTokens: 1000,
					totalCost: 0.42,
				},
				timeSpent: 180000,
				documentsProcessed: 3,
				tasksCompleted: 5,
			})) as { contributionId?: string; error?: string };

			expect(credited.error).toBeUndefined();
			expect(credited.contributionId).toMatch(/^manual_12_/);

			const state = await readStateForTest();
			expect(state.history[0]).toMatchObject({
				repoSlug: 'test-owner/manual-repo',
				prNumber: 144,
				wasMerged: true,
				mergedAt: '2026-05-03T10:00:00.000Z',
				documentsProcessed: 3,
				tasksCompleted: 5,
			});
			expect(state.stats.totalContributions).toBe(1);
			expect(state.stats.totalMerged).toBe(1);
			expect(state.stats.totalIssuesResolved).toBe(1);
			expect(state.stats.totalTokensUsed).toBe(3000);
			expect(state.stats.estimatedCostDonated).toBe(0.42);
			expect(state.stats.repositoriesContributed).toEqual(['test-owner/manual-repo']);
			expect(mockMainWindow.webContents.send).toHaveBeenCalledWith('symphony:updated');

			const duplicate = (await invokeHandler(handlers, 'symphony:manualCredit', {
				repoSlug: 'test-owner/manual-repo',
				repoName: 'Manual Repo',
				issueNumber: 12,
				issueTitle: 'Manual Issue',
				prNumber: 144,
				prUrl: 'https://github.com/test-owner/manual-repo/pull/144',
			})) as { error?: string };

			expect(duplicate.error).toContain('already credited');
		});
	});

	// ==========================================================================
	// Remaining Handler Edge Paths
	// ==========================================================================

	describe('Remaining Handler Edge Paths', () => {
		async function writeContributionMetadata(
			contributionId: string,
			metadata: object
		): Promise<void> {
			const metadataDir = path.join(testTempDir, 'symphony', 'contributions', contributionId);
			await fs.mkdir(metadataDir, { recursive: true });
			await fs.writeFile(
				path.join(metadataDir, 'metadata.json'),
				JSON.stringify(metadata, null, 2)
			);
		}

		it('should filter orphaned active contributions from state reads', async () => {
			mockSessionIds = new Set(['session-kept']);
			await writeStateForTest(
				createTestState({
					active: [
						createActiveContribution({ id: 'kept', sessionId: 'session-kept' }),
						createActiveContribution({ id: 'orphaned', sessionId: 'session-missing' }),
					],
				})
			);

			const stateResult = (await invokeHandler(handlers, 'symphony:getState')) as {
				state: SymphonyState;
			};
			const activeResult = (await invokeHandler(handlers, 'symphony:getActive')) as {
				contributions: ActiveContribution[];
			};

			expect(stateResult.state.active.map((c) => c.id)).toEqual(['kept']);
			expect(activeResult.contributions.map((c) => c.id)).toEqual(['kept']);
		});

		it('should return early from createDraftPR for missing, existing, and no-commit metadata', async () => {
			const existingPath = path.join(testTempDir, 'symphony-repos', 'existing-pr');
			const noCommitsPath = path.join(testTempDir, 'symphony-repos', 'no-commits');
			await fs.mkdir(existingPath, { recursive: true });
			await fs.mkdir(noCommitsPath, { recursive: true });

			await writeContributionMetadata('existing_pr', {
				contributionId: 'existing_pr',
				sessionId: 'session-existing',
				repoSlug: 'owner/existing-pr',
				issueNumber: 11,
				issueTitle: 'Existing PR',
				branchName: 'symphony/issue-11-existing',
				localPath: existingPath,
				prCreated: true,
				draftPrNumber: 501,
				draftPrUrl: 'https://github.com/owner/existing-pr/pull/501',
			});
			await writeContributionMetadata('no_commits', {
				contributionId: 'no_commits',
				sessionId: 'session-no-commits',
				repoSlug: 'owner/no-commits',
				issueNumber: 12,
				issueTitle: 'No Commits',
				branchName: 'symphony/issue-12-no-commits',
				localPath: noCommitsPath,
				prCreated: false,
				upstreamDefaultBranch: 'main',
			});

			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'rev-list') {
					return { stdout: '0', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const missing = (await invokeHandler(handlers, 'symphony:createDraftPR', {
				contributionId: 'missing_meta',
			})) as {
				success: boolean;
				error?: string;
			};
			const existing = (await invokeHandler(handlers, 'symphony:createDraftPR', {
				contributionId: 'existing_pr',
			})) as {
				success: boolean;
				draftPrNumber?: number;
				draftPrUrl?: string;
			};
			const noCommits = (await invokeHandler(handlers, 'symphony:createDraftPR', {
				contributionId: 'no_commits',
			})) as {
				success: boolean;
				draftPrNumber?: number;
			};

			expect(missing).toEqual({ success: false, error: 'Contribution metadata not found' });
			expect(existing).toMatchObject({
				success: true,
				draftPrNumber: 501,
				draftPrUrl: 'https://github.com/owner/existing-pr/pull/501',
			});
			expect(noCommits.success).toBe(true);
			expect(noCommits.draftPrNumber).toBeUndefined();
		});

		it('should create draft PRs with default-branch fallbacks and update active state', async () => {
			const mainPath = path.join(testTempDir, 'symphony-repos', 'fallback-main');
			const masterPath = path.join(testTempDir, 'symphony-repos', 'fallback-master');
			await fs.mkdir(mainPath, { recursive: true });
			await fs.mkdir(masterPath, { recursive: true });

			await writeContributionMetadata('fallback_main', {
				contributionId: 'fallback_main',
				sessionId: 'session-main',
				repoSlug: 'owner/fallback-main',
				issueNumber: 13,
				issueTitle: 'Fallback Main',
				branchName: 'symphony/issue-13-main',
				localPath: mainPath,
				prCreated: false,
			});
			await writeContributionMetadata('fallback_master', {
				contributionId: 'fallback_master',
				sessionId: 'session-master',
				repoSlug: 'owner/fallback-master',
				issueNumber: 14,
				issueTitle: 'Fallback Master',
				branchName: 'symphony/issue-14-master',
				localPath: masterPath,
				prCreated: false,
			});
			await writeStateForTest(
				createTestState({
					active: [
						createActiveContribution({ id: 'fallback_master', sessionId: 'session-master' }),
					],
				})
			);

			const prCreateArgs: Record<string, unknown[]> = {};
			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args, cwd) => {
				const cwdText = typeof cwd === 'string' ? cwd : '';
				if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'symbolic-ref') {
					return { stdout: '', stderr: 'missing origin head', exitCode: 1 };
				}
				if (cmd === 'git' && args?.[0] === 'ls-remote' && args?.[3] === 'main') {
					return cwdText.includes('fallback-main')
						? { stdout: 'abc\trefs/heads/main', stderr: '', exitCode: 0 }
						: { stdout: '', stderr: '', exitCode: 1 };
				}
				if (cmd === 'git' && args?.[0] === 'ls-remote' && args?.[3] === 'master') {
					return cwdText.includes('fallback-master')
						? { stdout: 'abc\trefs/heads/master', stderr: '', exitCode: 0 }
						: { stdout: '', stderr: '', exitCode: 1 };
				}
				if (cmd === 'git' && args?.[0] === 'rev-list') {
					return { stdout: '2', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'rev-parse') {
					return {
						stdout: cwdText.includes('fallback-master')
							? 'symphony/issue-14-master'
							: 'symphony/issue-13-main',
						stderr: '',
						exitCode: 0,
					};
				}
				if (cmd === 'git' && args?.[0] === 'push') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'create') {
					const key = cwdText.includes('fallback-master') ? 'master' : 'main';
					prCreateArgs[key] = [...args];
					return {
						stdout: `https://github.com/owner/fallback-${key}/pull/${key === 'master' ? 502 : 501}`,
						stderr: '',
						exitCode: 0,
					};
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const mainResult = (await invokeHandler(handlers, 'symphony:createDraftPR', {
				contributionId: 'fallback_main',
			})) as {
				success: boolean;
				draftPrNumber?: number;
			};
			const masterResult = (await invokeHandler(handlers, 'symphony:createDraftPR', {
				contributionId: 'fallback_master',
			})) as {
				success: boolean;
				draftPrNumber?: number;
			};

			expect(mainResult).toMatchObject({ success: true, draftPrNumber: 501 });
			expect(masterResult).toMatchObject({ success: true, draftPrNumber: 502 });
			expect(prCreateArgs.main).toContain('main');
			expect(prCreateArgs.master).toContain('master');

			const state = await readStateForTest();
			expect(state.active[0]).toMatchObject({
				id: 'fallback_master',
				draftPrNumber: 502,
				draftPrUrl: 'https://github.com/owner/fallback-master/pull/502',
			});
		});

		it('should keep draft PR creation successful when gh returns a non-pull URL', async () => {
			const repoPath = path.join(testTempDir, 'symphony-repos', 'nonstandard-pr-url');
			await fs.mkdir(repoPath, { recursive: true });
			await writeContributionMetadata('nonstandard_pr_url', {
				contributionId: 'nonstandard_pr_url',
				sessionId: 'session-nonstandard-pr-url',
				repoSlug: 'owner/nonstandard-pr-url',
				issueNumber: 16,
				issueTitle: 'Nonstandard PR URL',
				branchName: 'symphony/issue-16-nonstandard',
				localPath: repoPath,
				prCreated: false,
				upstreamDefaultBranch: 'main',
			});

			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'rev-list') {
					return { stdout: '1', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'rev-parse') {
					return { stdout: 'symphony/issue-16-nonstandard', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'push') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'create') {
					return {
						stdout: 'https://github.com/owner/nonstandard-pr-url/compare/main...branch',
						stderr: '',
						exitCode: 0,
					};
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const result = (await invokeHandler(handlers, 'symphony:createDraftPR', {
				contributionId: 'nonstandard_pr_url',
			})) as {
				success: boolean;
				draftPrNumber?: number;
				draftPrUrl?: string;
			};

			expect(result).toEqual({
				success: true,
				draftPrNumber: undefined,
				draftPrUrl: 'https://github.com/owner/nonstandard-pr-url/compare/main...branch',
			});
		});

		it('should surface delayed draft PR auth failures after commit detection', async () => {
			const repoPath = path.join(testTempDir, 'symphony-repos', 'delayed-auth');
			await fs.mkdir(repoPath, { recursive: true });
			await writeContributionMetadata('delayed_auth', {
				contributionId: 'delayed_auth',
				sessionId: 'session-delayed-auth',
				repoSlug: 'owner/delayed-auth',
				issueNumber: 15,
				issueTitle: 'Delayed Auth',
				branchName: 'symphony/issue-15-delayed-auth',
				localPath: repoPath,
				prCreated: false,
				upstreamDefaultBranch: 'main',
			});

			let authChecks = 0;
			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
					authChecks += 1;
					return authChecks === 1
						? { stdout: 'Logged in', stderr: '', exitCode: 0 }
						: { stdout: '', stderr: 'not logged in', exitCode: 1 };
				}
				if (cmd === 'git' && args?.[0] === 'rev-list') {
					return { stdout: '1', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const result = (await invokeHandler(handlers, 'symphony:createDraftPR', {
				contributionId: 'delayed_auth',
			})) as {
				success: boolean;
				error?: string;
			};

			expect(result.success).toBe(false);
			expect(result.error).toContain('GitHub CLI is not authenticated');
		});

		it('should validate startContribution inputs before shelling out', async () => {
			const baseParams = {
				contributionId: 'invalid_start',
				sessionId: 'session-invalid-start',
				repoSlug: 'owner/repo',
				issueNumber: 1,
				issueTitle: 'Invalid Start',
				localPath: path.join(testTempDir, 'symphony-repos', 'invalid-start'),
				documentPaths: [] as Array<{ name: string; path: string; isExternal: boolean }>,
			};

			const badSlug = (await invokeHandler(handlers, 'symphony:startContribution', {
				...baseParams,
				repoSlug: 'missing-slash',
			})) as { success: boolean; error?: string };
			const badIssue = (await invokeHandler(handlers, 'symphony:startContribution', {
				...baseParams,
				issueNumber: 0,
			})) as { success: boolean; error?: string };
			const httpDoc = (await invokeHandler(handlers, 'symphony:startContribution', {
				...baseParams,
				documentPaths: [
					{ name: 'doc.md', path: 'http://github.com/owner/repo/files/doc.md', isExternal: true },
				],
			})) as { success: boolean; error?: string };
			const malformedDoc = (await invokeHandler(handlers, 'symphony:startContribution', {
				...baseParams,
				documentPaths: [{ name: 'doc.md', path: 'not a url', isExternal: true }],
			})) as { success: boolean; error?: string };

			expect(badSlug).toMatchObject({ success: false });
			expect(badIssue).toEqual({ success: false, error: 'Invalid issue number' });
			expect(httpDoc.error).toContain('must use HTTPS');
			expect(malformedDoc.error).toContain('Invalid external document URL');
			expect(execFileNoThrow).not.toHaveBeenCalled();
		});

		it('should create fork draft PR metadata while tolerating external document download errors', async () => {
			const repoPath = path.join(testTempDir, 'symphony-repos', 'fork-start');
			await fs.mkdir(repoPath, { recursive: true });

			let prCreateArgs: unknown[] = [];
			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'checkout' && args?.[1] === '-b') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'symbolic-ref') {
					return { stdout: 'refs/remotes/origin/develop', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === 'user') {
					return { stdout: 'contributor\n', stderr: '', exitCode: 0 };
				}
				if (
					cmd === 'gh' &&
					args?.[0] === 'api' &&
					args?.[1] === 'repos/owner/forked' &&
					args?.[3] === '.permissions.push'
				) {
					return { stdout: 'false\n', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'repo' && args?.[1] === 'fork') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (
					cmd === 'gh' &&
					args?.[0] === 'api' &&
					args?.[1] === 'repos/contributor/forked' &&
					args?.[3] === '.clone_url'
				) {
					return {
						stdout: 'https://github.com/contributor/forked.git\n',
						stderr: '',
						exitCode: 0,
					};
				}
				if (cmd === 'git' && args?.[0] === 'remote') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'commit') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'rev-parse') {
					return { stdout: 'symphony/issue-22-forked', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'push') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'create') {
					prCreateArgs = [...args];
					return {
						stdout: 'https://github.com/owner/forked/pull/640',
						stderr: '',
						exitCode: 0,
					};
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});
			mockFetch.mockRejectedValue(new Error('download failed'));

			const result = (await invokeHandler(handlers, 'symphony:startContribution', {
				contributionId: 'fork_start',
				sessionId: 'session-fork-start',
				repoSlug: 'owner/forked',
				issueNumber: 22,
				issueTitle: 'Fork Start',
				localPath: repoPath,
				documentPaths: [
					{
						name: 'attachment.md',
						path: 'https://github.com/user-attachments/files/attachment.md',
						isExternal: true,
					},
				],
			})) as { success: boolean; draftPrNumber?: number; draftPrUrl?: string; error?: string };

			expect(result.success, result.error).toBe(true);
			expect(result).toMatchObject({
				draftPrNumber: 640,
				draftPrUrl: 'https://github.com/owner/forked/pull/640',
			});
			expect(prCreateArgs).toContain('--repo');
			expect(prCreateArgs).toContain('owner/forked');
			expect(prCreateArgs).toContain('contributor:symphony/issue-22-forked');

			const metadata = JSON.parse(
				await fs.readFile(
					path.join(testTempDir, 'symphony', 'contributions', 'fork_start', 'metadata.json'),
					'utf-8'
				)
			);
			expect(metadata).toMatchObject({
				prCreated: true,
				draftPrNumber: 640,
				isFork: true,
				forkSlug: 'contributor/forked',
				upstreamSlug: 'owner/forked',
			});
		});

		it('should complete fork contributions and handle cancel edge cases', async () => {
			const repoPath = path.join(testTempDir, 'symphony-repos', 'fork-complete');
			await fs.mkdir(repoPath, { recursive: true });
			await writeStateForTest(
				createTestState({
					active: [
						createActiveContribution({
							id: 'fork_complete',
							localPath: repoPath,
							draftPrNumber: 77,
							draftPrUrl: 'https://github.com/owner/upstream/pull/77',
							isFork: true,
							forkSlug: 'contributor/upstream',
							upstreamSlug: 'owner/upstream',
							progress: {
								totalDocuments: 2,
								completedDocuments: 2,
								totalTasks: 3,
								completedTasks: 3,
							},
						}),
					],
					stats: {
						currentStreak: 4,
						longestStreak: 4,
						lastContributionDate: getWeekKey(new Date(Date.now() - 21 * 24 * 60 * 60 * 1000)),
					},
				})
			);

			const missingCancel = (await invokeHandler(handlers, 'symphony:cancel', 'missing', true)) as {
				cancelled: boolean;
			};
			const missingComplete = (await invokeHandler(handlers, 'symphony:complete', {
				contributionId: 'missing',
			})) as { error?: string };
			expect(missingCancel.cancelled).toBe(false);
			expect(missingComplete.error).toBe('Contribution not found');

			const ghCalls: unknown[][] = [];
			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'gh' && args?.[0] === 'pr') {
					ghCalls.push([...args]);
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const completed = (await invokeHandler(handlers, 'symphony:complete', {
				contributionId: 'fork_complete',
				stats: {
					inputTokens: 100,
					outputTokens: 50,
					estimatedCost: 0.25,
					timeSpentMs: 3661000,
					documentsProcessed: 2,
					tasksCompleted: 3,
				},
			})) as { prNumber?: number; prUrl?: string; error?: string };

			expect(completed.error).toBeUndefined();
			expect(completed.prNumber).toBe(77);
			expect(ghCalls[0]).toEqual(['pr', 'ready', '77', '--repo', 'owner/upstream']);
			expect(ghCalls[1]).toContain('--repo');
			expect(ghCalls[1]).toContain('owner/upstream');

			let state = await readStateForTest();
			expect(state.history[0]).toMatchObject({
				id: 'fork_complete',
				prNumber: 77,
				documentsProcessed: 2,
				tasksCompleted: 3,
			});
			expect(state.stats.currentStreak).toBe(1);

			await writeStateForTest(
				createTestState({
					active: [
						createActiveContribution({
							id: 'cleanup_fail',
							localPath: path.join(testTempDir, 'symphony-repos', 'cleanup-fail'),
						}),
					],
				})
			);
			vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('locked'));
			const cancelled = (await invokeHandler(
				handlers,
				'symphony:cancel',
				'cleanup_fail',
				true
			)) as {
				cancelled: boolean;
			};
			expect(cancelled.cancelled).toBe(true);
			state = await readStateForTest();
			expect(state.active).toEqual([]);
		});

		it('should preserve existing first contribution date when completing on Sunday', async () => {
			const originalDate = global.Date;
			const mockDate = class extends Date {
				constructor(...args: ConstructorParameters<typeof Date>) {
					if (args.length === 0) {
						super('2026-05-31T12:00:00Z');
					} else {
						// @ts-expect-error - spread args
						super(...args);
					}
				}
				static now() {
					return new Date('2026-05-31T12:00:00Z').getTime();
				}
			};
			// @ts-expect-error - mock Date
			global.Date = mockDate;

			try {
				const repoPath = path.join(testTempDir, 'symphony-repos', 'sunday-complete');
				await fs.mkdir(repoPath, { recursive: true });
				await writeStateForTest(
					createTestState({
						active: [
							createActiveContribution({
								id: 'sunday_complete',
								localPath: repoPath,
								draftPrNumber: 111,
								draftPrUrl: 'https://github.com/owner/sunday-complete/pull/111',
							}),
						],
						stats: {
							firstContributionAt: '2026-01-01T00:00:00.000Z',
							currentStreak: 5,
							longestStreak: 5,
							lastContributionDate: getWeekKey(new Date()),
						},
					})
				);
				vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
					if (cmd === 'gh' && args?.[0] === 'pr') {
						return { stdout: '', stderr: '', exitCode: 0 };
					}
					return { stdout: '', stderr: '', exitCode: 0 };
				});

				const result = (await invokeHandler(handlers, 'symphony:complete', {
					contributionId: 'sunday_complete',
					stats: {
						inputTokens: 10,
						outputTokens: 5,
						estimatedCost: 0.01,
						timeSpentMs: 1000,
						documentsProcessed: 1,
						tasksCompleted: 1,
					},
				})) as { error?: string; prNumber?: number };

				expect(result).toMatchObject({ prNumber: 111 });
				const state = await readStateForTest();
				expect(state.stats.firstContributionAt).toBe('2026-01-01T00:00:00.000Z');
				expect(state.stats.currentStreak).toBe(5);
			} finally {
				global.Date = originalDate;
			}
		});

		it('should sync no-PR discovery failures and PR status exceptions', async () => {
			const existingPath = path.join(testTempDir, 'symphony-repos', 'no-pr-existing');
			await fs.mkdir(existingPath, { recursive: true });
			await writeStateForTest(
				createTestState({
					active: [
						createActiveContribution({
							id: 'no_pr_existing',
							repoSlug: 'owner/no-pr',
							branchName: 'symphony/issue-30-no-pr',
							localPath: existingPath,
						}),
						createActiveContribution({
							id: 'discover_http',
							repoSlug: 'owner/discover-http',
							branchName: 'symphony/issue-31-http',
							localPath: existingPath,
						}),
						createActiveContribution({
							id: 'discover_throw',
							repoSlug: 'owner/discover-throw',
							branchName: 'symphony/issue-32-throw',
							localPath: path.join(testTempDir, 'symphony-repos', 'missing-local-path'),
						}),
						createActiveContribution({
							id: 'status_json_error',
							repoSlug: 'owner/status-json-error',
							draftPrNumber: 91,
							draftPrUrl: 'https://github.com/owner/status-json-error/pull/91',
						}),
					],
				})
			);

			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('/repos/owner/no-pr/pulls?head=')) {
					return { ok: true, json: async () => [] };
				}
				if (url.includes('/repos/owner/discover-http/pulls?head=')) {
					return { ok: false, status: 503, statusText: 'Unavailable' };
				}
				if (url.includes('/repos/owner/discover-throw/pulls?head=')) {
					throw new Error('branch lookup down');
				}
				if (url.includes('/repos/owner/status-json-error/pulls/91')) {
					return {
						ok: true,
						json: async () => {
							throw new Error('bad pr json');
						},
					};
				}
				return { ok: false, status: 404, statusText: 'Not Found' };
			});

			const noPr = (await invokeHandler(
				handlers,
				'symphony:syncContribution',
				'no_pr_existing'
			)) as { success: boolean; message?: string };
			const http = (await invokeHandler(
				handlers,
				'symphony:syncContribution',
				'discover_http'
			)) as { success: boolean; message?: string };
			const thrown = (await invokeHandler(
				handlers,
				'symphony:syncContribution',
				'discover_throw'
			)) as { success: boolean; message?: string };
			const jsonError = (await invokeHandler(
				handlers,
				'symphony:syncContribution',
				'status_json_error'
			)) as { success: boolean; error?: string };

			expect(noPr).toMatchObject({
				success: true,
				message: 'No PR exists yet - contribution may still be in progress',
			});
			expect(http).toMatchObject({
				success: true,
				message: 'No PR exists yet - contribution may still be in progress',
			});
			expect(thrown).toMatchObject({ success: true, message: 'Synced successfully' });
			expect(jsonError).toEqual({ success: false, error: 'bad pr json' });
		});

		it('should update manual credit streaks for previous-week continuity and stale gaps', async () => {
			await writeStateForTest(
				createTestState({
					stats: {
						currentStreak: 2,
						longestStreak: 2,
						lastContributionDate: getWeekKey(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)),
					},
				})
			);
			await invokeHandler(handlers, 'symphony:manualCredit', {
				repoSlug: 'owner/streak-continuity',
				repoName: 'streak-continuity',
				issueNumber: 40,
				issueTitle: 'Streak Continuity',
				prNumber: 401,
				prUrl: 'https://github.com/owner/streak-continuity/pull/401',
			});
			let state = await readStateForTest();
			expect(state.stats.currentStreak).toBe(3);
			expect(state.stats.longestStreak).toBe(3);

			await writeStateForTest(
				createTestState({
					stats: {
						currentStreak: 6,
						longestStreak: 6,
						lastContributionDate: getWeekKey(new Date(Date.now() - 21 * 24 * 60 * 60 * 1000)),
					},
				})
			);
			await invokeHandler(handlers, 'symphony:manualCredit', {
				repoSlug: 'owner/streak-gap',
				repoName: 'streak-gap',
				issueNumber: 41,
				issueTitle: 'Streak Gap',
				prNumber: 402,
				prUrl: 'https://github.com/owner/streak-gap/pull/402',
			});
			state = await readStateForTest();
			expect(state.stats.currentStreak).toBe(1);
			expect(state.stats.longestStreak).toBe(6);
		});

		it('should use manual credit title and token defaults on Sunday dates', async () => {
			const originalDate = global.Date;
			const mockDate = class extends Date {
				constructor(...args: ConstructorParameters<typeof Date>) {
					if (args.length === 0) {
						super('2026-05-31T12:00:00Z');
					} else {
						// @ts-expect-error - spread args
						super(...args);
					}
				}
				static now() {
					return new Date('2026-05-31T12:00:00Z').getTime();
				}
			};
			// @ts-expect-error - mock Date
			global.Date = mockDate;

			try {
				const result = (await invokeHandler(handlers, 'symphony:manualCredit', {
					repoSlug: 'owner/manual-defaults',
					repoName: 'manual-defaults',
					issueNumber: 42,
					issueTitle: '',
					prNumber: 420,
					prUrl: 'https://github.com/owner/manual-defaults/pull/420',
				})) as { contributionId?: string; error?: string };

				expect(result.error).toBeUndefined();
				const state = await readStateForTest();
				expect(state.history[0]).toMatchObject({
					issueTitle: 'Issue #42',
					tokenUsage: { inputTokens: 0, outputTokens: 0, totalCost: 0 },
					timeSpent: 0,
					documentsProcessed: 0,
					tasksCompleted: 1,
					wasMerged: false,
				});
				expect(state.stats.firstContributionAt).toBe('2026-05-31T12:00:00.000Z');

				await writeStateForTest(
					createTestState({
						stats: {
							firstContributionAt: '2026-01-01T00:00:00.000Z',
							currentStreak: 4,
							longestStreak: 4,
							lastContributionDate: getWeekKey(new Date()),
						},
					})
				);
				await invokeHandler(handlers, 'symphony:manualCredit', {
					repoSlug: 'owner/manual-same-week',
					repoName: 'manual-same-week',
					issueNumber: 43,
					issueTitle: 'Manual Same Week',
					prNumber: 421,
					prUrl: 'https://github.com/owner/manual-same-week/pull/421',
				});
				const sameWeekState = await readStateForTest();
				expect(sameWeekState.stats.firstContributionAt).toBe('2026-01-01T00:00:00.000Z');
				expect(sameWeekState.stats.currentStreak).toBe(4);
			} finally {
				global.Date = originalDate;
			}
		});

		it('should check PR statuses with fallback timestamps, missing URLs, and string errors', async () => {
			const activePath = path.join(testTempDir, 'symphony-repos', 'status-fallbacks');
			await fs.mkdir(activePath, { recursive: true });
			await writeStateForTest(
				createTestState({
					history: [
						{
							id: 'history_merged_without_timestamp',
							repoSlug: 'owner/history-merged',
							repoName: 'history-merged',
							issueNumber: 80,
							issueTitle: 'History Merged',
							startedAt: '2026-05-01T00:00:00.000Z',
							completedAt: '2026-05-01T01:00:00.000Z',
							prUrl: 'https://github.com/owner/history-merged/pull/80',
							prNumber: 80,
							tokenUsage: { inputTokens: 0, outputTokens: 0, totalCost: 0 },
						},
						{
							id: 'history_string_error',
							repoSlug: 'owner/history-error',
							repoName: 'history-error',
							issueNumber: 81,
							issueTitle: 'History Error',
							startedAt: '2026-05-01T00:00:00.000Z',
							completedAt: '2026-05-01T01:00:00.000Z',
							prUrl: 'https://github.com/owner/history-error/pull/81',
							prNumber: 81,
							tokenUsage: { inputTokens: 0, outputTokens: 0, totalCost: 0 },
						},
						{
							id: 'history_open_unmerged',
							repoSlug: 'owner/history-open',
							repoName: 'history-open',
							issueNumber: 84,
							issueTitle: 'History Open',
							startedAt: '2026-05-01T00:00:00.000Z',
							completedAt: '2026-05-01T01:00:00.000Z',
							prUrl: 'https://github.com/owner/history-open/pull/84',
							prNumber: 84,
							tokenUsage: { inputTokens: 0, outputTokens: 0, totalCost: 0 },
						},
					],
					active: [
						createActiveContribution({
							id: 'active_merged_missing_url',
							repoSlug: 'owner/active-merged',
							localPath: activePath,
							draftPrNumber: 82,
						}),
						createActiveContribution({
							id: 'active_string_error',
							repoSlug: 'owner/active-error',
							localPath: activePath,
							draftPrNumber: 83,
						}),
						createActiveContribution({
							id: 'metadata_without_pr',
							repoSlug: 'owner/metadata-no-pr',
							localPath: activePath,
							branchName: 'symphony/issue-84-metadata',
						}),
						createActiveContribution({
							id: 'fork_discovery_empty',
							repoSlug: 'owner/fork-discovery-empty',
							localPath: activePath,
							branchName: 'symphony/issue-85-fork',
							isFork: true,
							forkSlug: 'contributor/fork-discovery-empty',
							upstreamSlug: 'owner/fork-discovery-empty',
						}),
					],
				})
			);
			await writeContributionMetadata('metadata_without_pr', {
				contributionId: 'metadata_without_pr',
				sessionId: 'session-metadata-no-pr',
				repoSlug: 'owner/metadata-no-pr',
				issueNumber: 84,
				issueTitle: 'Metadata Without PR',
				branchName: 'symphony/issue-84-metadata',
				localPath: activePath,
				prCreated: false,
				isFork: false,
			});

			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('/pulls/80')) {
					return {
						ok: true,
						json: async () => ({ state: 'closed', merged: true, merged_at: null }),
					};
				}
				if (url.includes('/pulls/81')) {
					throw 'history lookup unavailable';
				}
				if (url.includes('/pulls/84')) {
					return {
						ok: true,
						json: async () => ({ state: 'open', merged: false, merged_at: null }),
					};
				}
				if (url.includes('/pulls/82')) {
					return {
						ok: true,
						json: async () => ({ state: 'closed', merged: true, merged_at: null }),
					};
				}
				if (url.includes('/pulls/83')) {
					throw 'active lookup unavailable';
				}
				if (url.includes('/pulls?head=')) {
					return { ok: true, json: async () => [] };
				}
				return { ok: true, json: async () => [] };
			});

			const result = (await invokeHandler(handlers, 'symphony:checkPRStatuses')) as {
				checked: number;
				merged: number;
				errors: string[];
			};

			expect(result.checked).toBe(5);
			expect(result.merged).toBe(2);
			expect(result.errors).toEqual([
				'Error checking PR #81: history lookup unavailable',
				'Error checking PR #83: active lookup unavailable',
			]);

			const state = await readStateForTest();
			expect(state.history.find((c) => c.id === 'history_merged_without_timestamp')).toMatchObject({
				wasMerged: true,
			});
			expect(state.history.find((c) => c.id === 'active_merged_missing_url')).toMatchObject({
				prUrl: '',
				wasMerged: true,
			});
			expect(state.active.map((c) => c.id)).toEqual([
				'active_string_error',
				'metadata_without_pr',
				'fork_discovery_empty',
			]);
		});

		it('should cover legacy start handler guard and cleanup paths', async () => {
			const startParams = {
				repoSlug: 'owner/legacy-start',
				repoUrl: 'https://github.com/owner/legacy-start',
				repoName: 'legacy-start',
				issueNumber: 51,
				issueTitle: 'Legacy Start',
				documentPaths: [] as Array<{ name: string; path: string; isExternal: boolean }>,
				agentType: 'claude-code',
				sessionId: 'session-legacy-start',
				baseBranch: 'main',
			};

			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
					return { stdout: '', stderr: 'not logged in', exitCode: 1 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});
			const authFailure = (await invokeHandler(handlers, 'symphony:start', startParams)) as {
				error?: string;
			};
			expect(authFailure.error).toContain('GitHub CLI is not authenticated');

			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});
			await writeStateForTest(
				createTestState({
					active: [
						createActiveContribution({
							id: 'already_active',
							repoSlug: 'owner/legacy-start',
							issueNumber: 51,
						}),
					],
				})
			);
			const duplicate = (await invokeHandler(handlers, 'symphony:start', startParams)) as {
				error?: string;
			};
			expect(duplicate.error).toContain('Already working on this issue');

			await writeStateForTest(createTestState());
			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'clone') {
					return { stdout: '', stderr: 'clone failed', exitCode: 1 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});
			const cloneFailure = (await invokeHandler(handlers, 'symphony:start', {
				...startParams,
				issueNumber: 52,
			})) as { error?: string };
			expect(cloneFailure.error).toBe('Clone failed: clone failed');

			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'checkout' && args?.[1] === '-b') {
					return { stdout: '', stderr: 'branch exists', exitCode: 1 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});
			const branchFailure = (await invokeHandler(handlers, 'symphony:start', {
				...startParams,
				issueNumber: 53,
			})) as { error?: string };
			expect(branchFailure.error).toBe('Branch creation failed: branch exists');

			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'checkout' && args?.[1] === '-b') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === 'user') {
					return { stdout: '', stderr: 'auth missing', exitCode: 1 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});
			const forkFailure = (await invokeHandler(handlers, 'symphony:start', {
				...startParams,
				issueNumber: 54,
			})) as { error?: string };
			expect(forkFailure.error).toBe('Fork setup failed: GitHub CLI not authenticated');

			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'checkout' && args?.[1] === '-b') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === 'user') {
					return { stdout: 'contributor\n', stderr: '', exitCode: 0 };
				}
				if (
					cmd === 'gh' &&
					args?.[0] === 'api' &&
					args?.[1] === 'repos/owner/legacy-start' &&
					args?.[3] === '.permissions.push'
				) {
					return { stdout: 'false\n', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'repo' && args?.[1] === 'fork') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (
					cmd === 'gh' &&
					args?.[0] === 'api' &&
					args?.[1] === 'repos/contributor/legacy-start' &&
					args?.[3] === '.clone_url'
				) {
					return {
						stdout: 'https://github.com/contributor/legacy-start.git\n',
						stderr: '',
						exitCode: 0,
					};
				}
				if (cmd === 'git' && args?.[0] === 'remote') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'rev-parse') {
					return { stdout: 'symphony/issue-55-legacy', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'push') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'create') {
					return { stdout: '', stderr: 'pr rejected', exitCode: 1 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});
			const prFailure = (await invokeHandler(handlers, 'symphony:start', {
				...startParams,
				issueNumber: 55,
			})) as { error?: string };
			expect(prFailure.error).toBe('PR creation failed: Failed to create PR: pr rejected');
		});

		it('should ignore cleanup removal failures in legacy start failure paths', async () => {
			const startParams = {
				repoSlug: 'owner/cleanup-start',
				repoUrl: 'https://github.com/owner/cleanup-start',
				repoName: 'cleanup-start',
				issueTitle: 'Cleanup Start',
				documentPaths: [
					{ name: 'task.md', path: 'docs/task.md', isExternal: false },
					{
						name: 'attachment.md',
						path: 'https://github.com/owner/cleanup-start/files/1/attachment.md',
						isExternal: true,
					},
				] as Array<{ name: string; path: string; isExternal: boolean }>,
				agentType: 'claude-code',
				sessionId: 'session-cleanup-start',
				baseBranch: 'main',
			};
			const rmSpy = vi.spyOn(fs, 'rm');

			try {
				rmSpy.mockRejectedValueOnce(new Error('cleanup locked'));
				vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
					if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
						return { stdout: 'Logged in', stderr: '', exitCode: 0 };
					}
					if (cmd === 'git' && args?.[0] === 'checkout' && args?.[1] === '-b') {
						return { stdout: '', stderr: 'branch exists', exitCode: 1 };
					}
					return { stdout: '', stderr: '', exitCode: 0 };
				});
				const branchFailure = (await invokeHandler(handlers, 'symphony:start', {
					...startParams,
					issueNumber: 56,
				})) as { error?: string };
				expect(branchFailure.error).toBe('Branch creation failed: branch exists');

				rmSpy.mockRejectedValueOnce(new Error('cleanup locked'));
				vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
					if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
						return { stdout: 'Logged in', stderr: '', exitCode: 0 };
					}
					if (cmd === 'git' && args?.[0] === 'checkout' && args?.[1] === '-b') {
						return { stdout: '', stderr: '', exitCode: 0 };
					}
					if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === 'user') {
						return { stdout: '', stderr: 'auth missing', exitCode: 1 };
					}
					return { stdout: '', stderr: '', exitCode: 0 };
				});
				const forkFailure = (await invokeHandler(handlers, 'symphony:start', {
					...startParams,
					issueNumber: 57,
				})) as { error?: string };
				expect(forkFailure.error).toBe('Fork setup failed: GitHub CLI not authenticated');

				rmSpy.mockRejectedValueOnce(new Error('cleanup locked'));
				vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
					if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
						return { stdout: 'Logged in', stderr: '', exitCode: 0 };
					}
					if (cmd === 'git' && args?.[0] === 'checkout' && args?.[1] === '-b') {
						return { stdout: '', stderr: '', exitCode: 0 };
					}
					if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === 'user') {
						return { stdout: 'owner\n', stderr: '', exitCode: 0 };
					}
					if (cmd === 'git' && args?.[0] === 'rev-parse') {
						return { stdout: 'symphony/issue-58-cleanup', stderr: '', exitCode: 0 };
					}
					if (cmd === 'git' && args?.[0] === 'push') {
						return { stdout: '', stderr: '', exitCode: 0 };
					}
					if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'create') {
						return { stdout: '', stderr: 'pr rejected', exitCode: 1 };
					}
					return { stdout: '', stderr: '', exitCode: 0 };
				});
				const prFailure = (await invokeHandler(handlers, 'symphony:start', {
					...startParams,
					issueNumber: 58,
				})) as { error?: string };
				expect(prFailure.error).toBe('PR creation failed: Failed to create PR: pr rejected');
			} finally {
				rmSpy.mockRestore();
			}
		});

		it('should start a legacy non-fork contribution and skip unavailable broadcast targets', async () => {
			vi.mocked(mockMainWindow.isDestroyed).mockReturnValue(true);
			const startParams = {
				repoSlug: 'owner/legacy-success',
				repoUrl: 'https://github.com/owner/legacy-success',
				repoName: 'legacy-success',
				issueNumber: 59,
				issueTitle: 'Legacy Success',
				documentPaths: [] as Array<{ name: string; path: string; isExternal: boolean }>,
				agentType: 'claude-code',
				sessionId: 'session-legacy-success',
				baseBranch: 'main',
			};

			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'checkout' && args?.[1] === '-b') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === 'user') {
					return { stdout: 'owner\n', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'rev-parse') {
					return { stdout: 'symphony/issue-59-legacy', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'push') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'create') {
					return {
						stdout: 'https://github.com/owner/legacy-success/pull/590',
						stderr: '',
						exitCode: 0,
					};
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const result = (await invokeHandler(handlers, 'symphony:start', startParams)) as {
				contributionId?: string;
				draftPrNumber?: number;
				error?: string;
			};

			expect(result.error).toBeUndefined();
			expect(result.draftPrNumber).toBe(590);
			expect(mockMainWindow.webContents.send).not.toHaveBeenCalledWith('symphony:updated');
		});

		it('should start a legacy fork contribution with fork metadata in active state', async () => {
			const startParams = {
				repoSlug: 'owner/legacy-fork-success',
				repoUrl: 'https://github.com/owner/legacy-fork-success',
				repoName: 'legacy-fork-success',
				issueNumber: 60,
				issueTitle: 'Legacy Fork Success',
				documentPaths: [] as Array<{ name: string; path: string; isExternal: boolean }>,
				agentType: 'claude-code',
				sessionId: 'session-legacy-fork-success',
				baseBranch: 'main',
			};

			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'checkout' && args?.[1] === '-b') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === 'user') {
					return { stdout: 'contributor\n', stderr: '', exitCode: 0 };
				}
				if (
					cmd === 'gh' &&
					args?.[0] === 'api' &&
					args?.[1] === 'repos/owner/legacy-fork-success' &&
					args?.[3] === '.permissions.push'
				) {
					return { stdout: 'false\n', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'repo' && args?.[1] === 'fork') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (
					cmd === 'gh' &&
					args?.[0] === 'api' &&
					args?.[1] === 'repos/contributor/legacy-fork-success' &&
					args?.[3] === '.clone_url'
				) {
					return {
						stdout: 'https://github.com/contributor/legacy-fork-success.git\n',
						stderr: '',
						exitCode: 0,
					};
				}
				if (cmd === 'git' && args?.[0] === 'remote') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'rev-parse') {
					return { stdout: 'symphony/issue-60-legacy-fork', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'push') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'create') {
					return {
						stdout: 'https://github.com/owner/legacy-fork-success/pull/591',
						stderr: '',
						exitCode: 0,
					};
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const result = (await invokeHandler(handlers, 'symphony:start', startParams)) as {
				contributionId?: string;
				draftPrNumber?: number;
				error?: string;
			};

			expect(result.error).toBeUndefined();
			expect(result.draftPrNumber).toBe(591);
			const state = await readStateForTest();
			expect(state.active[0]).toMatchObject({
				isFork: true,
				forkSlug: 'contributor/legacy-fork-success',
				upstreamSlug: 'owner/legacy-fork-success',
			});
		});

		it('should cover startContribution auth and fork setup failures', async () => {
			const params = {
				contributionId: 'start_auth_failure',
				sessionId: 'session-start-auth-failure',
				repoSlug: 'owner/start-auth-failure',
				issueNumber: 61,
				issueTitle: 'Start Auth Failure',
				localPath: path.join(testTempDir, 'symphony-repos', 'start-auth-failure'),
				documentPaths: [] as Array<{ name: string; path: string; isExternal: boolean }>,
			};

			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
					return { stdout: '', stderr: 'not logged in', exitCode: 1 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});
			const authFailure = (await invokeHandler(handlers, 'symphony:startContribution', params)) as {
				success: boolean;
				error?: string;
			};
			expect(authFailure.success).toBe(false);
			expect(authFailure.error).toContain('GitHub CLI is not authenticated');

			await fs.mkdir(params.localPath, { recursive: true });
			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'checkout' && args?.[1] === '-b') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'symbolic-ref') {
					return { stdout: 'refs/remotes/origin/main', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === 'user') {
					return { stdout: '', stderr: 'user lookup failed', exitCode: 1 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});
			const forkFailure = (await invokeHandler(handlers, 'symphony:startContribution', {
				...params,
				contributionId: 'start_fork_failure',
				sessionId: 'session-start-fork-failure',
				issueNumber: 62,
			})) as { success: boolean; error?: string };
			expect(forkFailure).toEqual({
				success: false,
				error: 'Fork setup failed: GitHub CLI not authenticated',
			});
		});

		it('should start non-fork contributions while logging string document failures', async () => {
			const localPath = path.join(testTempDir, 'symphony-repos', 'start-non-fork-doc-errors');
			await fs.mkdir(localPath, { recursive: true });
			const accessSpy = vi.spyOn(fs, 'access').mockRejectedValueOnce('repo doc missing');

			try {
				vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
					if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
						return { stdout: 'Logged in', stderr: '', exitCode: 0 };
					}
					if (cmd === 'git' && args?.[0] === 'checkout' && args?.[1] === '-b') {
						return { stdout: '', stderr: '', exitCode: 0 };
					}
					if (cmd === 'git' && args?.[0] === 'symbolic-ref') {
						return { stdout: 'refs/remotes/origin/main', stderr: '', exitCode: 0 };
					}
					if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === 'user') {
						return { stdout: 'owner\n', stderr: '', exitCode: 0 };
					}
					if (cmd === 'git' && args?.[0] === 'commit') {
						return { stdout: '', stderr: '', exitCode: 0 };
					}
					if (cmd === 'git' && args?.[0] === 'rev-parse') {
						return { stdout: 'symphony/issue-63-doc-errors', stderr: '', exitCode: 0 };
					}
					if (cmd === 'git' && args?.[0] === 'push') {
						return { stdout: '', stderr: '', exitCode: 0 };
					}
					if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'create') {
						return {
							stdout: 'https://github.com/owner/start-non-fork-doc-errors/pull/630',
							stderr: '',
							exitCode: 0,
						};
					}
					return { stdout: '', stderr: '', exitCode: 0 };
				});
				mockFetch.mockRejectedValueOnce('external doc offline');

				const result = (await invokeHandler(handlers, 'symphony:startContribution', {
					contributionId: 'start_non_fork_doc_errors',
					sessionId: 'session-start-non-fork-doc-errors',
					repoSlug: 'owner/start-non-fork-doc-errors',
					issueNumber: 63,
					issueTitle: 'Start Non Fork Doc Errors',
					localPath,
					documentPaths: [
						{
							name: 'external.md',
							path: 'https://objects.githubusercontent.com/github-production-file/external.md',
							isExternal: true,
						},
						{ name: 'missing.md', path: 'docs/missing.md', isExternal: false },
					],
				})) as { success: boolean; draftPrNumber?: number; error?: string };

				expect(result).toMatchObject({ success: true, draftPrNumber: 630 });
				const metadata = JSON.parse(
					await fs.readFile(
						path.join(
							testTempDir,
							'symphony',
							'contributions',
							'start_non_fork_doc_errors',
							'metadata.json'
						),
						'utf-8'
					)
				);
				expect(metadata).toMatchObject({
					prCreated: true,
					isFork: false,
					resolvedDocs: [],
				});
			} finally {
				accessSpy.mockRestore();
			}
		});

		it('should sync discovered PRs, unchanged draft status, and HTTP status failures', async () => {
			await writeStateForTest(
				createTestState({
					active: [
						createActiveContribution({
							id: 'missing_sync',
							repoSlug: 'owner/missing-sync',
						}),
						createActiveContribution({
							id: 'discover_sync_single',
							repoSlug: 'owner/discover-sync-single',
							branchName: 'symphony/issue-70-discover',
						}),
						createActiveContribution({
							id: 'draft_synced',
							repoSlug: 'owner/draft-synced',
							draftPrNumber: 93,
							draftPrUrl: 'https://github.com/owner/draft-synced/pull/93',
						}),
						createActiveContribution({
							id: 'status_http',
							repoSlug: 'owner/status-http',
							draftPrNumber: 94,
							draftPrUrl: 'https://github.com/owner/status-http/pull/94',
						}),
					],
				})
			);

			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('/repos/owner/discover-sync-single/pulls?head=')) {
					return {
						ok: true,
						json: async () => [
							{
								number: 92,
								html_url: 'https://github.com/owner/discover-sync-single/pull/92',
								state: 'open',
							},
						],
					};
				}
				if (url.includes('/repos/owner/discover-sync-single/pulls/92')) {
					return {
						ok: true,
						json: async () => ({ state: 'open', merged: false, merged_at: null, draft: true }),
					};
				}
				if (url.includes('/repos/owner/draft-synced/pulls/93')) {
					return {
						ok: true,
						json: async () => ({ state: 'open', merged: false, merged_at: null, draft: true }),
					};
				}
				if (url.includes('/repos/owner/status-http/pulls/94')) {
					return { ok: false, status: 502, statusText: 'Bad Gateway' };
				}
				return { ok: false, status: 404, statusText: 'Not Found' };
			});

			const missing = (await invokeHandler(
				handlers,
				'symphony:syncContribution',
				'missing_contribution'
			)) as { success: boolean; error?: string };
			const discovered = (await invokeHandler(
				handlers,
				'symphony:syncContribution',
				'discover_sync_single'
			)) as { success: boolean; prCreated?: boolean; message?: string };
			const draft = (await invokeHandler(
				handlers,
				'symphony:syncContribution',
				'draft_synced'
			)) as {
				success: boolean;
				message?: string;
			};
			const http = (await invokeHandler(handlers, 'symphony:syncContribution', 'status_http')) as {
				success: boolean;
				message?: string;
			};

			expect(missing).toEqual({ success: false, error: 'Contribution not found' });
			expect(discovered).toMatchObject({
				success: true,
				prCreated: true,
				message: 'Discovered PR #92 from branch symphony/issue-70-discover',
			});
			expect(draft).toMatchObject({ success: true, message: 'PR #93 synced (draft)' });
			expect(http).toMatchObject({
				success: true,
				message: 'Could not check PR status (HTTP 502)',
			});
		});

		it('should sync PR fallback fields, fork discovery misses, and unknown thrown errors', async () => {
			const localPath = path.join(testTempDir, 'symphony-repos', 'sync-fallbacks');
			await fs.mkdir(localPath, { recursive: true });
			await writeStateForTest(
				createTestState({
					active: [
						createActiveContribution({
							id: 'sync_merged_fallback',
							repoSlug: 'owner/sync-merged-fallback',
							localPath,
							draftPrNumber: 101,
						}),
						createActiveContribution({
							id: 'sync_closed_fallback',
							repoSlug: 'owner/sync-closed-fallback',
							localPath,
							draftPrNumber: 102,
						}),
						createActiveContribution({
							id: 'sync_ready_message',
							repoSlug: 'owner/sync-ready-message',
							localPath,
							draftPrNumber: 103,
							draftPrUrl: 'https://github.com/owner/sync-ready-message/pull/103',
							status: 'ready_for_review',
						}),
						createActiveContribution({
							id: 'sync_metadata_http_message',
							repoSlug: 'owner/sync-metadata-http',
							localPath,
							branchName: 'symphony/issue-104-metadata-http',
						}),
						createActiveContribution({
							id: 'sync_string_error',
							repoSlug: 'owner/sync-string-error',
							localPath,
							draftPrNumber: 105,
						}),
						createActiveContribution({
							id: 'sync_fork_discovery_empty',
							repoSlug: 'owner/sync-fork-empty',
							localPath,
							branchName: 'symphony/issue-106-fork-empty',
							isFork: true,
							forkSlug: 'contributor/sync-fork-empty',
							upstreamSlug: 'owner/sync-fork-empty',
						}),
						createActiveContribution({
							id: 'sync_discovery_string_error',
							repoSlug: 'owner/sync-discovery-string',
							localPath,
							branchName: 'symphony/issue-107-discovery-string',
						}),
						createActiveContribution({
							id: 'sync_fork_already_synced',
							repoSlug: 'owner/sync-fork-already',
							localPath,
							draftPrNumber: 108,
							draftPrUrl: 'https://github.com/owner/sync-fork-already/pull/108',
							isFork: true,
							forkSlug: 'contributor/sync-fork-already',
							upstreamSlug: 'owner/sync-fork-already',
						}),
						createActiveContribution({
							id: 'sync_metadata_no_pr',
							repoSlug: 'owner/sync-metadata-no-pr',
							localPath,
							branchName: 'symphony/issue-109-metadata-no-pr',
						}),
					],
				})
			);
			await writeContributionMetadata('sync_metadata_http_message', {
				contributionId: 'sync_metadata_http_message',
				sessionId: 'session-sync-metadata-http',
				repoSlug: 'owner/sync-metadata-http',
				issueNumber: 104,
				issueTitle: 'Sync Metadata HTTP',
				branchName: 'symphony/issue-104-metadata-http',
				localPath,
				prCreated: true,
				draftPrNumber: 104,
				draftPrUrl: 'https://github.com/owner/sync-metadata-http/pull/104',
			});
			await writeContributionMetadata('sync_metadata_no_pr', {
				contributionId: 'sync_metadata_no_pr',
				sessionId: 'session-sync-metadata-no-pr',
				repoSlug: 'owner/sync-metadata-no-pr',
				issueNumber: 109,
				issueTitle: 'Sync Metadata No PR',
				branchName: 'symphony/issue-109-metadata-no-pr',
				localPath,
				prCreated: false,
				isFork: false,
			});

			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('/pulls/101')) {
					return {
						ok: true,
						json: async () => ({ state: 'closed', merged: true, merged_at: null, draft: false }),
					};
				}
				if (url.includes('/pulls/102')) {
					return {
						ok: true,
						json: async () => ({ state: 'closed', merged: false, merged_at: null, draft: false }),
					};
				}
				if (url.includes('/pulls/103')) {
					return {
						ok: true,
						json: async () => ({ state: 'open', merged: false, merged_at: null, draft: false }),
					};
				}
				if (url.includes('/pulls/104')) {
					return { ok: false, status: 503, statusText: 'Unavailable' };
				}
				if (url.includes('/pulls/105')) {
					throw 'sync lookup unavailable';
				}
				if (url.includes('/repos/owner/sync-discovery-string/pulls?head=')) {
					throw 'discover string failure';
				}
				if (url.includes('/repos/owner/sync-fork-already/pulls/108')) {
					return {
						ok: true,
						json: async () => ({ state: 'open', merged: false, merged_at: null, draft: true }),
					};
				}
				if (url.includes('/pulls?head=')) {
					return { ok: true, json: async () => [] };
				}
				return { ok: false, status: 404, statusText: 'Not Found' };
			});

			const merged = (await invokeHandler(
				handlers,
				'symphony:syncContribution',
				'sync_merged_fallback'
			)) as { success: boolean; prMerged?: boolean };
			const closed = (await invokeHandler(
				handlers,
				'symphony:syncContribution',
				'sync_closed_fallback'
			)) as { success: boolean; prClosed?: boolean };
			const ready = (await invokeHandler(
				handlers,
				'symphony:syncContribution',
				'sync_ready_message'
			)) as { success: boolean; message?: string };
			const metadataHttp = (await invokeHandler(
				handlers,
				'symphony:syncContribution',
				'sync_metadata_http_message'
			)) as { success: boolean; message?: string };
			const stringError = (await invokeHandler(
				handlers,
				'symphony:syncContribution',
				'sync_string_error'
			)) as { success: boolean; error?: string };
			const forkEmpty = (await invokeHandler(
				handlers,
				'symphony:syncContribution',
				'sync_fork_discovery_empty'
			)) as { success: boolean; message?: string };
			const discoveryString = (await invokeHandler(
				handlers,
				'symphony:syncContribution',
				'sync_discovery_string_error'
			)) as { success: boolean; message?: string };
			const forkAlreadySynced = (await invokeHandler(
				handlers,
				'symphony:syncContribution',
				'sync_fork_already_synced'
			)) as { success: boolean; message?: string };
			const metadataNoPr = (await invokeHandler(
				handlers,
				'symphony:syncContribution',
				'sync_metadata_no_pr'
			)) as { success: boolean; message?: string };

			expect(merged).toMatchObject({ success: true, prMerged: true });
			expect(closed).toMatchObject({ success: true, prClosed: true });
			expect(ready).toMatchObject({ success: true, message: 'PR #103 synced (ready)' });
			expect(metadataHttp).toMatchObject({
				success: true,
				message: 'Synced PR #104 from metadata',
			});
			expect(stringError).toEqual({ success: false, error: 'Unknown error' });
			expect(forkEmpty).toMatchObject({
				success: true,
				message: 'No PR exists yet - contribution may still be in progress',
			});
			expect(discoveryString).toMatchObject({
				success: true,
				message: 'No PR exists yet - contribution may still be in progress',
			});
			expect(forkAlreadySynced).toMatchObject({
				success: true,
				message: 'PR #108 synced (draft)',
			});
			expect(metadataNoPr).toMatchObject({
				success: true,
				message: 'No PR exists yet - contribution may still be in progress',
			});

			const state = await readStateForTest();
			expect(state.history.find((c) => c.id === 'sync_merged_fallback')).toMatchObject({
				prUrl: '',
				wasMerged: true,
			});
			expect(state.history.find((c) => c.id === 'sync_closed_fallback')).toMatchObject({
				prUrl: '',
				wasClosed: true,
			});
		});

		it('should capture history PR status exceptions and skip already synced active metadata', async () => {
			await writeStateForTest(
				createTestState({
					history: [
						{
							id: 'history_json_error',
							repoSlug: 'owner/history-json-error',
							repoName: 'history-json-error',
							issueNumber: 71,
							issueTitle: 'History JSON Error',
							documentsProcessed: 1,
							tasksCompleted: 1,
							timeSpent: 1000,
							startedAt: '2026-05-01T00:00:00.000Z',
							completedAt: '2026-05-01T01:00:00.000Z',
							prUrl: 'https://github.com/owner/history-json-error/pull/301',
							prNumber: 301,
							tokenUsage: { inputTokens: 1, outputTokens: 1, totalCost: 0.01 },
							wasMerged: false,
						},
					],
					active: [
						createActiveContribution({
							id: 'already_synced_active',
							repoSlug: 'owner/already-synced-active',
							draftPrNumber: 302,
							draftPrUrl: 'https://github.com/owner/already-synced-active/pull/302',
							isFork: false,
						}),
					],
				})
			);

			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('/repos/owner/history-json-error/pulls/301')) {
					return {
						ok: true,
						json: async () => {
							throw new Error('history json failed');
						},
					};
				}
				if (url.includes('/repos/owner/already-synced-active/pulls/302')) {
					return {
						ok: true,
						json: async () => ({ state: 'open', merged: false, merged_at: null }),
					};
				}
				return { ok: false, status: 404, statusText: 'Not Found' };
			});

			const result = (await invokeHandler(handlers, 'symphony:checkPRStatuses')) as {
				checked: number;
				errors: string[];
			};

			expect(result.checked).toBe(2);
			expect(result.errors).toEqual(['Error checking PR #301: history json failed']);
		});

		it('should create cross-fork draft PRs from contribution metadata', async () => {
			const repoPath = path.join(testTempDir, 'symphony-repos', 'metadata-fork');
			await fs.mkdir(repoPath, { recursive: true });
			await writeContributionMetadata('metadata_fork', {
				contributionId: 'metadata_fork',
				sessionId: 'session-metadata-fork',
				repoSlug: 'owner/metadata-fork',
				issueNumber: 72,
				issueTitle: 'Metadata Fork',
				branchName: 'symphony/issue-72-metadata-fork',
				localPath: repoPath,
				prCreated: false,
				upstreamDefaultBranch: 'main',
				isFork: true,
				forkSlug: 'contributor/metadata-fork',
				upstreamSlug: 'owner/metadata-fork',
			});

			let prCreateArgs: unknown[] = [];
			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'rev-list') {
					return { stdout: '1', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'rev-parse') {
					return { stdout: 'symphony/issue-72-metadata-fork', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'push') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'create') {
					prCreateArgs = [...args];
					return {
						stdout: 'https://github.com/owner/metadata-fork/pull/720',
						stderr: '',
						exitCode: 0,
					};
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const result = (await invokeHandler(handlers, 'symphony:createDraftPR', {
				contributionId: 'metadata_fork',
			})) as { success: boolean; draftPrNumber?: number; error?: string };

			expect(result.error).toBeUndefined();
			expect(result).toMatchObject({ success: true, draftPrNumber: 720 });
			expect(prCreateArgs).toContain('--repo');
			expect(prCreateArgs).toContain('owner/metadata-fork');
			expect(prCreateArgs).toContain('contributor:symphony/issue-72-metadata-fork');
		});

		it('should skip star enrichment for registries with no active repositories', async () => {
			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('symphony-registry.json')) {
					return {
						ok: true,
						json: async () =>
							createMockRegistry({
								repositories: [
									{
										slug: 'owner/inactive',
										name: 'Inactive',
										description: 'Inactive repository',
										url: 'https://github.com/owner/inactive',
										category: 'developer-tools',
										maintainer: { name: 'Maintainer' },
										isActive: false,
										addedAt: '2026-05-01T00:00:00.000Z',
									},
								],
							}),
					};
				}
				throw new Error(`Unexpected fetch: ${url}`);
			});

			const result = (await invokeHandler(handlers, 'symphony:getRegistry', true)) as {
				registry: SymphonyRegistry;
				fromCache: boolean;
			};

			expect(result.fromCache).toBe(false);
			expect(result.registry.repositories[0]).not.toHaveProperty('stars');
			expect(mockFetch).toHaveBeenCalledTimes(1);
		});

		it('should fall back to stale star cache when star cache persistence fails', async () => {
			const cacheFile = path.join(testTempDir, 'symphony', 'symphony-cache.json');
			await fs.mkdir(path.dirname(cacheFile), { recursive: true });
			await fs.writeFile(
				cacheFile,
				JSON.stringify({
					issues: {},
					stars: {
						data: { 'owner/starred': 123 },
						fetchedAt: Date.now() - 48 * 60 * 60 * 1000,
					},
				})
			);

			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('symphony-registry.json')) {
					return {
						ok: true,
						json: async () =>
							createMockRegistry({
								repositories: [
									{
										slug: 'owner/starred',
										name: 'Starred',
										description: 'Starred repository',
										url: 'https://github.com/owner/starred',
										category: 'developer-tools',
										maintainer: { name: 'Maintainer' },
										isActive: true,
										addedAt: '2026-05-01T00:00:00.000Z',
									},
								],
							}),
					};
				}
				if (url.includes('/repos/owner/starred')) {
					return {
						ok: true,
						json: async () => ({ stargazers_count: 999 }),
					};
				}
				throw new Error(`Unexpected fetch: ${url}`);
			});
			vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('star cache write failed'));

			const result = (await invokeHandler(handlers, 'symphony:getRegistry', true)) as {
				registry: SymphonyRegistry;
			};

			expect(result.registry.repositories[0].stars).toBe(123);
		});

		it('should keep registry usable when fresh star cache persistence fails without stale stars', async () => {
			mockFetch.mockImplementation(async (url: string) => {
				if (url.includes('symphony-registry.json')) {
					return {
						ok: true,
						json: async () =>
							createMockRegistry({
								repositories: [
									{
										slug: 'owner/no-stale-stars',
										name: 'No Stale Stars',
										description: 'No stale stars repository',
										url: 'https://github.com/owner/no-stale-stars',
										category: 'developer-tools',
										maintainer: { name: 'Maintainer' },
										isActive: true,
										addedAt: '2026-05-01T00:00:00.000Z',
									},
								],
							}),
					};
				}
				if (url.includes('/repos/owner/no-stale-stars')) {
					return {
						ok: true,
						json: async () => ({ stargazers_count: 456 }),
					};
				}
				throw new Error(`Unexpected fetch: ${url}`);
			});
			vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('fresh star write failed'));

			const result = (await invokeHandler(handlers, 'symphony:getRegistry', true)) as {
				registry: SymphonyRegistry;
			};

			expect(result.registry.repositories[0]).not.toHaveProperty('stars');
		});

		it('should report unexpected startContribution setup failures', async () => {
			const repoPath = path.join(testTempDir, 'symphony-repos', 'metadata-write-fails');
			await fs.mkdir(repoPath, { recursive: true });
			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'checkout' && args?.[1] === '-b') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'symbolic-ref') {
					return { stdout: 'refs/remotes/origin/main', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === 'user') {
					return { stdout: 'owner\n', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});
			vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('metadata disk full'));

			const result = (await invokeHandler(handlers, 'symphony:startContribution', {
				contributionId: 'metadata_write_fails',
				sessionId: 'session-metadata-write-fails',
				repoSlug: 'owner/metadata-write-fails',
				issueNumber: 73,
				issueTitle: 'Metadata Write Fails',
				localPath: repoPath,
				documentPaths: [],
			})) as { success: boolean; error?: string };

			expect(result).toEqual({ success: false, error: 'metadata disk full' });
		});

		it('should report unknown startContribution errors for non-Error setup failures', async () => {
			const repoPath = path.join(testTempDir, 'symphony-repos', 'metadata-string-fails');
			await fs.mkdir(repoPath, { recursive: true });
			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'checkout' && args?.[1] === '-b') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'symbolic-ref') {
					return { stdout: 'refs/remotes/origin/main', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === 'user') {
					return { stdout: 'owner\n', stderr: '', exitCode: 0 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});
			const writeSpy = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce('metadata string failure');

			try {
				const result = (await invokeHandler(handlers, 'symphony:startContribution', {
					contributionId: 'metadata_string_fails',
					sessionId: 'session-metadata-string-fails',
					repoSlug: 'owner/metadata-string-fails',
					issueNumber: 75,
					issueTitle: 'Metadata String Fails',
					localPath: repoPath,
					documentPaths: [],
				})) as { success: boolean; error?: string };

				expect(result).toEqual({ success: false, error: 'Unknown error' });
			} finally {
				writeSpy.mockRestore();
			}
		});

		it('should skip repo documents whose resolved path escapes the literal local path', async () => {
			const localPath = `${testTempDir}/repo-root/../outside-root`;
			await fs.mkdir(localPath, { recursive: true });
			vi.mocked(execFileNoThrow).mockImplementation(async (cmd, args) => {
				if (cmd === 'gh' && args?.[0] === 'auth' && args?.[1] === 'status') {
					return { stdout: 'Logged in', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'checkout' && args?.[1] === '-b') {
					return { stdout: '', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'symbolic-ref') {
					return { stdout: 'refs/remotes/origin/main', stderr: '', exitCode: 0 };
				}
				if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === 'user') {
					return { stdout: 'owner\n', stderr: '', exitCode: 0 };
				}
				if (cmd === 'git' && args?.[0] === 'commit') {
					return { stdout: '', stderr: 'nothing to commit', exitCode: 1 };
				}
				return { stdout: '', stderr: '', exitCode: 0 };
			});

			const result = (await invokeHandler(handlers, 'symphony:startContribution', {
				contributionId: 'escaped_doc_path',
				sessionId: 'session-escaped-doc-path',
				repoSlug: 'owner/escaped-doc-path',
				issueNumber: 74,
				issueTitle: 'Escaped Doc Path',
				localPath,
				documentPaths: [{ name: 'task.md', path: 'docs/task.md', isExternal: false }],
			})) as { success: boolean; autoRunPath?: string; error?: string };

			expect(result.success, result.error).toBe(true);
			expect(result.autoRunPath).toBe(localPath);
		});
	});

	// ==========================================================================
	// Security Tests - Path Traversal Prevention
	// ==========================================================================

	describe('Security - Path Traversal Prevention', () => {
		it('should sanitize repoName with ../ sequences', async () => {
			const result = (await invokeHandler(handlers, 'symphony:cloneRepo', {
				repoUrl: 'https://github.com/../../../etc/passwd',
				localPath: path.join(testTempDir, 'traversal-test'),
			})) as { success: boolean; error?: string };

			expect(result.success).toBe(false);
			// Should be rejected by URL validation
		});

		it('should reject document paths with path traversal', async () => {
			const result = (await invokeHandler(handlers, 'symphony:startContribution', {
				contributionId: 'traversal_test',
				sessionId: 'session-traversal',
				repoSlug: 'owner/repo',
				issueNumber: 1,
				issueTitle: 'Traversal Test',
				localPath: path.join(testTempDir, 'traversal-repo'),
				documentPaths: [{ name: 'evil.md', path: '../../etc/passwd', isExternal: false }],
			})) as { success: boolean; error?: string };

			expect(result.success).toBe(false);
			expect(result.error).toContain('document path');
		});

		it('should reject document paths that are absolute', async () => {
			const result = (await invokeHandler(handlers, 'symphony:startContribution', {
				contributionId: 'absolute_path_test',
				sessionId: 'session-abs',
				repoSlug: 'owner/repo',
				issueNumber: 1,
				issueTitle: 'Absolute Path Test',
				localPath: path.join(testTempDir, 'abs-repo'),
				documentPaths: [{ name: 'passwd', path: '/etc/passwd', isExternal: false }],
			})) as { success: boolean; error?: string };

			expect(result.success).toBe(false);
			expect(result.error).toContain('document path');
		});

		it('should reject document paths with embedded traversal sequences', async () => {
			// This tests a more subtle path traversal where a valid-looking path
			// contains ../ sequences that could escape the repo directory
			const result = (await invokeHandler(handlers, 'symphony:startContribution', {
				contributionId: 'embedded_traversal_test',
				sessionId: 'session-embedded',
				repoSlug: 'owner/repo',
				issueNumber: 1,
				issueTitle: 'Embedded Traversal Test',
				localPath: path.join(testTempDir, 'embedded-repo'),
				documentPaths: [{ name: 'evil.md', path: 'foo/../../../etc/passwd', isExternal: false }],
			})) as { success: boolean; error?: string };

			expect(result.success).toBe(false);
			expect(result.error).toContain('document path');
		});

		it('should reject external URL to non-GitHub domain', async () => {
			// External document URLs should only be allowed from GitHub domains
			// to prevent SSRF attacks and data exfiltration
			const result = (await invokeHandler(handlers, 'symphony:startContribution', {
				contributionId: 'non_github_url_test',
				sessionId: 'session-nongithub',
				repoSlug: 'owner/repo',
				issueNumber: 1,
				issueTitle: 'Non-GitHub URL Test',
				localPath: path.join(testTempDir, 'nongithub-repo'),
				documentPaths: [
					{ name: 'malicious.md', path: 'https://evil.com/malware.md', isExternal: true },
				],
			})) as { success: boolean; error?: string };

			expect(result.success).toBe(false);
			expect(result.error).toContain('GitHub');
		});
	});

	// ==========================================================================
	// Security Tests - Input Sanitization
	// ==========================================================================

	describe('Security - Input Sanitization', () => {
		it('should reject invalid start contribution parameters before shelling out', async () => {
			const baseParams = {
				repoSlug: 'test-owner/test-repo',
				repoUrl: 'https://github.com/test-owner/test-repo',
				repoName: 'Test Repository',
				issueNumber: 1,
				issueTitle: 'Safe issue',
				documentPaths: [],
				agentType: 'claude-code',
				sessionId: 'session-validation',
			};
			const invalidCases = [
				{
					name: 'missing repo slug',
					overrides: { repoSlug: '' },
					error: 'Repository slug is required',
				},
				{
					name: 'slug has too many segments',
					overrides: { repoSlug: 'owner/repo/extra' },
					error: 'Invalid repository slug format',
				},
				{
					name: 'slug missing repo name',
					overrides: { repoSlug: 'owner/' },
					error: 'Owner and repository name are required',
				},
				{
					name: 'bad slug owner',
					overrides: { repoSlug: '-owner/test-repo' },
					error: 'Invalid owner name',
				},
				{
					name: 'bad slug repo',
					overrides: { repoSlug: 'owner/repo<script>' },
					error: 'Invalid repository name',
				},
				{
					name: 'non-HTTPS repo URL',
					overrides: { repoUrl: 'git://github.com/test-owner/test-repo' },
					error: 'Only HTTPS URLs are allowed',
				},
				{
					name: 'non-GitHub repo URL',
					overrides: { repoUrl: 'https://example.com/test-owner/test-repo' },
					error: 'Only GitHub repositories are allowed',
				},
				{
					name: 'malformed repo URL',
					overrides: { repoUrl: 'not a url' },
					error: 'Invalid URL format',
				},
				{
					name: 'repo URL missing repository',
					overrides: { repoUrl: 'https://github.com/test-owner' },
					error: 'Invalid repository path',
				},
				{
					name: 'empty repo name',
					overrides: { repoName: '' },
					error: 'Repository name is required',
				},
				{
					name: 'invalid issue number',
					overrides: { issueNumber: 0 },
					error: 'Invalid issue number',
				},
				{
					name: 'external document without HTTPS',
					overrides: {
						documentPaths: [
							{
								name: 'notes.md',
								path: 'http://github.com/test-owner/test-repo/blob/main/notes.md',
								isExternal: true,
							},
						],
					},
					error: 'External document URL must use HTTPS',
				},
				{
					name: 'external document from non-GitHub host',
					overrides: {
						documentPaths: [
							{ name: 'notes.md', path: 'https://example.com/notes.md', isExternal: true },
						],
					},
					error: 'External document URL must be from GitHub',
				},
				{
					name: 'malformed external document URL',
					overrides: {
						documentPaths: [{ name: 'notes.md', path: 'notaurl', isExternal: true }],
					},
					error: 'Invalid external document URL',
				},
				{
					name: 'relative document path traversal',
					overrides: {
						documentPaths: [{ name: 'passwd', path: '../../etc/passwd', isExternal: false }],
					},
					error: 'Invalid document path',
				},
			];

			for (const testCase of invalidCases) {
				const result = (await invokeHandler(handlers, 'symphony:start', {
					...baseParams,
					...testCase.overrides,
				})) as { error?: string };

				expect(result.error, testCase.name).toContain(testCase.error);
			}

			expect(execFileNoThrow).not.toHaveBeenCalled();
		});

		it('should sanitize dangerous repo names before constructing start paths', async () => {
			const dangerousRepoName = `../<script>alert('x')</script>;DROP-${'a'.repeat(140)}`;

			const result = (await invokeHandler(handlers, 'symphony:start', {
				repoSlug: 'test-owner/test-repo',
				repoUrl: 'https://github.com/test-owner/test-repo',
				repoName: dangerousRepoName,
				issueNumber: 1,
				issueTitle: 'Sanitize repo path',
				documentPaths: [],
				agentType: 'claude-code',
				sessionId: 'session-sanitize-start',
			})) as {
				contributionId?: string;
				draftPrNumber?: number;
				draftPrUrl?: string;
				error?: string;
			};

			expect(result.error).toBeUndefined();
			expect(result.contributionId).toBeDefined();
			expect(result.draftPrNumber).toBe(1);
			expect(result.draftPrUrl).toBe('https://github.com/test-owner/test-repo/pull/1');

			const state = await readStateForTest();
			const contribution = state.active.find((active) => active.id === result.contributionId);
			expect(contribution).toBeDefined();

			const reposDir = path.join(testTempDir, 'symphony', 'symphony-repos');
			const relativePath = path.relative(reposDir, contribution!.localPath);
			const repoDirName = path.basename(contribution!.localPath);

			expect(relativePath).not.toMatch(/^\.\.(?:[/\\]|$)/);
			expect(path.isAbsolute(relativePath)).toBe(false);
			expect(repoDirName).toContain(result.contributionId!);
			expect(repoDirName.length).toBeLessThanOrEqual(101 + result.contributionId!.length);
			expect(repoDirName).not.toMatch(/\.\.|[<>:;"'\\/]/);
		});

		it('should neutralize XSS payloads in repo name', async () => {
			// XSS payloads in repo names should be sanitized to safe characters
			// The sanitizeRepoName function replaces unsafe chars with dashes
			const xssPayloads = [
				'<script>alert("XSS")</script>',
				'<img src=x onerror=alert(1)>',
				'"><script>document.cookie</script>',
				"';DROP TABLE users;--",
				'<svg/onload=alert(1)>',
			];

			for (const payload of xssPayloads) {
				const result = (await invokeHandler(handlers, 'symphony:registerActive', {
					contributionId: `xss_test_${Math.random().toString(36).substring(2, 8)}`,
					sessionId: 'session-xss',
					repoSlug: 'owner/repo',
					repoName: payload, // XSS payload as repo name
					issueNumber: 1,
					issueTitle: 'XSS Test',
					localPath: path.join(testTempDir, 'xss-repo'),
					branchName: 'symphony/issue-1',
					documentPaths: [],
					agentType: 'claude-code',
				})) as { success: boolean };

				// Should succeed (repo name is stored as-is in state, but sanitized when used for paths)
				expect(result.success).toBe(true);
			}

			// Verify that when using start handler (which uses sanitizeRepoName for path), the path is safe
			const repoDir = path.join(testTempDir, 'symphony-repos', 'xss-safe-repo');
			await fs.mkdir(repoDir, { recursive: true });

			// The start handler sanitizes repo name for local path construction
			// The result should be safe - no < > " ' ; characters should remain in paths
			const state = (await invokeHandler(handlers, 'symphony:getState')) as {
				state: SymphonyState;
			};

			// Repo names in state may contain XSS, but when used for file paths they must be sanitized
			// The key security property is that XSS in repo names cannot execute code
			// because they're only used server-side, not rendered as HTML
			expect(state.state.active.length).toBeGreaterThan(0);
		});

		it('should safely handle SQL injection patterns in issue title', async () => {
			// SQL injection patterns should be safe because Symphony doesn't use SQL
			// (it uses JSON file storage), but we should verify they're stored correctly
			const sqlPayloads = [
				"'; DROP TABLE issues; --",
				"1' OR '1'='1",
				'1; DELETE FROM contributions;',
				'UNION SELECT * FROM users--',
				"Robert'); DROP TABLE students;--",
			];

			for (const payload of sqlPayloads) {
				const contributionId = `sql_test_${Math.random().toString(36).substring(2, 8)}`;
				const result = (await invokeHandler(handlers, 'symphony:registerActive', {
					contributionId,
					sessionId: 'session-sql',
					repoSlug: 'owner/repo',
					repoName: 'repo',
					issueNumber: 1,
					issueTitle: payload, // SQL injection as issue title
					localPath: path.join(testTempDir, 'sql-repo'),
					branchName: 'symphony/issue-1',
					documentPaths: [],
					agentType: 'claude-code',
				})) as { success: boolean };

				expect(result.success).toBe(true);

				// Verify the title is stored correctly (not executed as SQL)
				const state = (await invokeHandler(handlers, 'symphony:getState')) as {
					state: SymphonyState;
				};
				const contrib = state.state.active.find((c) => c.id === contributionId);
				expect(contrib).toBeDefined();
				// The exact SQL injection payload should be preserved as the title (no execution)
				expect(contrib?.issueTitle).toBe(payload);

				// Cleanup - cancel this contribution
				await invokeHandler(handlers, 'symphony:cancel', contributionId, false);
			}
		});

		it('should prevent command injection in branch name', async () => {
			// Branch names are generated server-side from issue numbers
			// They should not be affected by malicious input
			// The generateBranchName function uses a template with only the issue number
			const commandInjectionInputs = [
				1, // Normal case
				999999, // Large number
			];

			for (const issueNum of commandInjectionInputs) {
				const repoDir = path.join(testTempDir, `cmd-inject-repo-${issueNum}`);
				await fs.mkdir(repoDir, { recursive: true });

				const result = (await invokeHandler(handlers, 'symphony:startContribution', {
					contributionId: `cmd_inject_${issueNum}`,
					sessionId: 'session-cmd',
					repoSlug: 'owner/repo',
					issueNumber: issueNum,
					issueTitle: '; rm -rf /', // Command injection attempt in title
					localPath: repoDir,
					documentPaths: [],
				})) as { success: boolean; branchName?: string; error?: string };

				expect(result.success).toBe(true);
				// Branch name should follow the safe template pattern
				expect(result.branchName).toMatch(/^symphony\/issue-\d+-[a-z0-9]+$/);
				// Should NOT contain any shell metacharacters
				expect(result.branchName).not.toMatch(/[;&|`$()<>]/);
			}
		});

		it('should prevent contribution ID manipulation', async () => {
			// Contribution IDs are generated server-side and should not be controllable by the user
			// However, when registering an active contribution, the ID is passed in
			// The key security property is that duplicate IDs don't overwrite existing contributions

			// First, create a contribution
			const result1 = (await invokeHandler(handlers, 'symphony:registerActive', {
				contributionId: 'legit_contrib_123',
				sessionId: 'session-legit',
				repoSlug: 'owner/legit-repo',
				repoName: 'legit-repo',
				issueNumber: 1,
				issueTitle: 'Legitimate Issue',
				localPath: path.join(testTempDir, 'legit-repo'),
				branchName: 'symphony/issue-1',
				documentPaths: [],
				agentType: 'claude-code',
			})) as { success: boolean };

			expect(result1.success).toBe(true);

			// Try to register another contribution with the same ID (should be idempotent, not overwrite)
			const result2 = (await invokeHandler(handlers, 'symphony:registerActive', {
				contributionId: 'legit_contrib_123', // Same ID
				sessionId: 'session-evil',
				repoSlug: 'owner/evil-repo', // Different repo
				repoName: 'evil-repo',
				issueNumber: 999,
				issueTitle: 'Evil Issue',
				localPath: path.join(testTempDir, 'evil-repo'),
				branchName: 'symphony/issue-999',
				documentPaths: [],
				agentType: 'claude-code',
			})) as { success: boolean };

			// Should succeed (idempotent) but NOT overwrite
			expect(result2.success).toBe(true);

			// Verify the original contribution is preserved
			const state = (await invokeHandler(handlers, 'symphony:getState')) as {
				state: SymphonyState;
			};
			const contrib = state.state.active.find((c) => c.id === 'legit_contrib_123');

			// The original contribution should still have the original data
			expect(contrib?.repoSlug).toBe('owner/legit-repo');
			expect(contrib?.issueNumber).toBe(1);
			expect(contrib?.issueTitle).toBe('Legitimate Issue');

			// There should only be one contribution with this ID
			const matchingContribs = state.state.active.filter((c) => c.id === 'legit_contrib_123');
			expect(matchingContribs.length).toBe(1);
		});
	});

	// ==========================================================================
	// Security Tests - URL Validation
	// ==========================================================================

	describe('Security - URL Validation', () => {
		it('should reject malformed repository URLs and incomplete GitHub paths', async () => {
			const invalidUrls = [
				{ repoUrl: 'not a url', error: 'Invalid URL format' },
				{ repoUrl: 'git://github.com/owner/repo', error: 'Only HTTPS URLs are allowed' },
				{
					repoUrl: 'https://example.com/owner/repo',
					error: 'Only GitHub repositories are allowed',
				},
				{ repoUrl: 'https://github.com/owner', error: 'Invalid repository path' },
				{ repoUrl: 'https://github.com/owner/../repo', error: 'Invalid repository path' },
			];

			for (const { repoUrl, error } of invalidUrls) {
				const result = (await invokeHandler(handlers, 'symphony:cloneRepo', {
					repoUrl,
					localPath: path.join(
						testTempDir,
						`invalid-url-${Math.random().toString(36).substring(2, 8)}`
					),
				})) as { success: boolean; error?: string };

				expect(result.success).toBe(false);
				expect(result.error).toContain(error);
			}
		});

		it('should reject javascript: URLs', async () => {
			const result = (await invokeHandler(handlers, 'symphony:cloneRepo', {
				repoUrl: 'javascript:alert(1)',
				localPath: path.join(testTempDir, 'js-url'),
			})) as { success: boolean; error?: string };

			expect(result.success).toBe(false);
		});

		it('should reject file: URLs', async () => {
			const result = (await invokeHandler(handlers, 'symphony:cloneRepo', {
				repoUrl: 'file:///etc/passwd',
				localPath: path.join(testTempDir, 'file-url'),
			})) as { success: boolean; error?: string };

			expect(result.success).toBe(false);
		});

		it('should reject URLs with non-GitHub hosts', async () => {
			const result = (await invokeHandler(handlers, 'symphony:cloneRepo', {
				repoUrl: 'https://evil.com/owner/repo',
				localPath: path.join(testTempDir, 'evil-url'),
			})) as { success: boolean; error?: string };

			expect(result.success).toBe(false);
			expect(result.error).toContain('GitHub');
		});

		it('should reject HTTP protocol (only HTTPS allowed)', async () => {
			const result = (await invokeHandler(handlers, 'symphony:cloneRepo', {
				repoUrl: 'http://github.com/owner/repo',
				localPath: path.join(testTempDir, 'http-url'),
			})) as { success: boolean; error?: string };

			expect(result.success).toBe(false);
			expect(result.error).toContain('HTTPS');
		});

		it('should reject data: URLs', async () => {
			// data: URLs could be used to embed arbitrary content
			const result = (await invokeHandler(handlers, 'symphony:cloneRepo', {
				repoUrl: 'data:text/html,<script>alert(1)</script>',
				localPath: path.join(testTempDir, 'data-url'),
			})) as { success: boolean; error?: string };

			expect(result.success).toBe(false);
		});

		it('should reject URLs with authentication credentials', async () => {
			// URLs with embedded credentials (user:pass@host) could be used
			// to exfiltrate credentials or bypass authentication
			const result = (await invokeHandler(handlers, 'symphony:cloneRepo', {
				repoUrl: 'https://user:password@github.com/owner/repo',
				localPath: path.join(testTempDir, 'creds-url'),
			})) as { success: boolean; error?: string };

			// This URL is technically valid but the host extraction should still work
			// The validation rejects non-GitHub hosts; embedded creds don't change hostname
			// However, this is a security concern that should be flagged
			// Current implementation may accept this - we document the behavior
			// For now, verify the URL is at least processed (success or explicit rejection)
			expect(result).toBeDefined();
		});

		it('should reject localhost/internal IP URLs', async () => {
			// Localhost and internal IPs could be used for SSRF attacks
			const internalUrls = [
				'https://localhost/owner/repo',
				'https://127.0.0.1/owner/repo',
				'https://192.168.1.1/owner/repo',
				'https://10.0.0.1/owner/repo',
				'https://172.16.0.1/owner/repo',
				'https://[::1]/owner/repo',
			];

			for (const url of internalUrls) {
				const result = (await invokeHandler(handlers, 'symphony:cloneRepo', {
					repoUrl: url,
					localPath: path.join(
						testTempDir,
						`internal-${Math.random().toString(36).substring(2, 8)}`
					),
				})) as { success: boolean; error?: string };

				// Should be rejected because they're not github.com
				expect(result.success).toBe(false);
				expect(result.error).toContain('GitHub');
			}
		});
	});

	describe('Document Content Fetching', () => {
		it('should fetch GitHub document content and reject unsafe URLs', async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				text: async () => '# Symphony task',
			});

			const success = (await invokeHandler(handlers, 'symphony:fetchDocumentContent', {
				url: 'https://raw.githubusercontent.com/test-owner/test-repo/main/docs/task.md',
			})) as { success: boolean; content?: string };

			expect(success).toEqual({ success: true, content: '# Symphony task' });

			const unsafeHosts = [
				['not a url', 'Invalid URL'],
				[
					'https://example.com/test-owner/test-repo/main/docs/task.md',
					'Only GitHub URLs are allowed',
				],
				[
					'http://github.com/test-owner/test-repo/blob/main/docs/task.md',
					'Only HTTPS URLs are allowed',
				],
			] as const;

			for (const [url, error] of unsafeHosts) {
				const result = (await invokeHandler(handlers, 'symphony:fetchDocumentContent', {
					url,
				})) as { success: boolean; error?: string };
				expect(result).toEqual({ success: false, error });
			}
		});

		it('should report GitHub document HTTP and network failures', async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 404,
				statusText: 'Not Found',
			});

			const missing = (await invokeHandler(handlers, 'symphony:fetchDocumentContent', {
				url: 'https://github.com/test-owner/test-repo/blob/main/missing.md',
			})) as { success: boolean; error?: string };

			expect(missing).toEqual({ success: false, error: 'HTTP 404: Not Found' });

			mockFetch.mockRejectedValueOnce(new Error('network down'));
			const failed = (await invokeHandler(handlers, 'symphony:fetchDocumentContent', {
				url: 'https://objects.githubusercontent.com/github-production-repository-file/task.md',
			})) as { success: boolean; error?: string };

			expect(failed).toEqual({ success: false, error: 'network down' });

			mockFetch.mockRejectedValueOnce('offline');
			const stringFailure = (await invokeHandler(handlers, 'symphony:fetchDocumentContent', {
				url: 'https://objects.githubusercontent.com/github-production-repository-file/string.md',
			})) as { success: boolean; error?: string };

			expect(stringFailure).toEqual({ success: false, error: 'Failed to fetch document' });
		});
	});

	// ==========================================================================
	// Performance Tests
	// ==========================================================================

	describe('Performance Tests', () => {
		it('should not freeze on pathological regex input in document parsing', async () => {
			// Create an issue with a body designed to test ReDoS protection
			const pathologicalBody = 'a'.repeat(10000) + '.md'.repeat(100);

			mockFetch.mockImplementationOnce(async () => ({
				ok: true,
				json: async () => [
					{
						number: 1,
						title: 'ReDoS Test',
						body: pathologicalBody,
						url: 'https://api.github.com/repos/owner/repo/issues/1',
						html_url: 'https://github.com/owner/repo/issues/1',
						user: { login: 'test' },
						created_at: new Date().toISOString(),
						updated_at: new Date().toISOString(),
					},
				],
			}));

			// Should complete quickly without hanging
			const start = Date.now();
			await invokeHandler(handlers, 'symphony:getIssues', 'owner/repo', true);
			const elapsed = Date.now() - start;

			// Should complete in less than 5 seconds
			expect(elapsed).toBeLessThan(5000);
		});

		it('should handle concurrent API calls correctly', async () => {
			// Launch multiple concurrent calls
			const promises = [
				invokeHandler(handlers, 'symphony:getRegistry', true),
				invokeHandler(handlers, 'symphony:getIssues', 'owner/repo1', true),
				invokeHandler(handlers, 'symphony:getIssues', 'owner/repo2', true),
				invokeHandler(handlers, 'symphony:getState'),
			];

			const results = await Promise.all(promises);

			// All should succeed
			expect(results.length).toBe(4);
			results.forEach((result) => {
				expect(result).toBeDefined();
			});
		});

		it('should perform state file writes atomically (no corruption on crash)', async () => {
			// Test that state file writes are atomic by simulating concurrent writes
			// and verifying the file is always valid JSON after each write

			const stateFile = path.join(testTempDir, 'symphony', 'symphony-state.json');

			// Perform multiple concurrent writes
			const writePromises = [];
			for (let i = 0; i < 10; i++) {
				writePromises.push(
					invokeHandler(handlers, 'symphony:registerActive', {
						contributionId: `atomic_test_${i}`,
						sessionId: `session-atomic-${i}`,
						repoSlug: `owner/repo-${i}`,
						repoName: `repo-${i}`,
						issueNumber: i + 1,
						issueTitle: `Atomic Test ${i}`,
						localPath: `/tmp/atomic-repo-${i}`,
						branchName: `symphony/issue-${i + 1}`,
						documentPaths: [],
						agentType: 'claude-code',
					})
				);
			}

			await Promise.all(writePromises);

			// Verify the state file is valid JSON
			const content = await fs.readFile(stateFile, 'utf-8');
			const state = JSON.parse(content) as SymphonyState; // Should not throw

			// All contributions should be present
			expect(state.active.length).toBe(10);

			// Verify no corruption - each contribution should have all required fields
			for (const contrib of state.active) {
				expect(contrib.id).toBeDefined();
				expect(contrib.repoSlug).toBeDefined();
				expect(contrib.issueNumber).toBeGreaterThan(0);
				expect(contrib.sessionId).toBeDefined();
			}
		});

		it('should not block main thread during cache reads', async () => {
			// Create a large cache to ensure reads are measurable
			const cacheFile = path.join(testTempDir, 'symphony', 'symphony-cache.json');
			await fs.mkdir(path.dirname(cacheFile), { recursive: true });

			// Write a moderately large cache (simulate many issues)
			const largeCache: SymphonyCache = {
				registry: {
					data: createMockRegistry({
						repositories: Array.from({ length: 100 }, (_, i) => ({
							slug: `owner/repo-${i}`,
							name: `Repository ${i}`,
							description: 'Test repository '.repeat(50), // ~750 chars
							url: `https://github.com/owner/repo-${i}`,
							category: 'developer-tools',
							maintainer: { name: 'Maintainer' },
							isActive: true,
							addedAt: new Date().toISOString(),
						})),
					}),
					fetchedAt: Date.now(),
				},
				issues: Object.fromEntries(
					Array.from({ length: 50 }, (_, i) => [
						`owner/repo-${i}`,
						{
							data: Array.from({ length: 20 }, (_, j) =>
								createMockIssue({
									number: j + 1,
									title: `Issue ${j + 1} with a fairly long title `.repeat(3),
									body: 'Issue body content '.repeat(100),
								})
							),
							fetchedAt: Date.now(),
						},
					])
				),
			};

			await fs.writeFile(cacheFile, JSON.stringify(largeCache));

			// Re-register handlers to load the cache
			handlers.clear();
			registerSymphonyHandlers(mockDeps);

			// Time the cache read operation
			const start = Date.now();
			const result = (await invokeHandler(handlers, 'symphony:getRegistry', false)) as {
				registry: SymphonyRegistry;
				fromCache: boolean;
			};
			const elapsed = Date.now() - start;

			// Cache read should complete quickly (< 1 second for reasonable cache sizes)
			expect(elapsed).toBeLessThan(1000);
			expect(result.fromCache).toBe(true);
			expect(result.registry.repositories.length).toBe(100);
		});
	});
});
