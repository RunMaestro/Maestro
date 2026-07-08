import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSymphony } from '../../renderer/hooks/symphony/useSymphony';
import { logger } from '../../renderer/utils/logger';
import type {
	ActiveContribution,
	RegisteredRepository,
	SymphonyIssue,
	SymphonyRegistry,
	SymphonyState,
} from '../../shared/symphony-types';

vi.mock('../../renderer/utils/logger', () => ({
	logger: {
		error: vi.fn(),
	},
}));

type SymphonyApi = Record<string, ReturnType<typeof vi.fn>>;

function createRepo(overrides: Partial<RegisteredRepository> = {}): RegisteredRepository {
	return {
		slug: 'owner/repo',
		name: 'Repo',
		description: 'A repository',
		url: 'https://github.com/owner/repo',
		category: 'tools',
		tags: [],
		maintainer: { name: 'Owner' },
		isActive: true,
		addedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function createIssue(overrides: Partial<SymphonyIssue> = {}): SymphonyIssue {
	return {
		number: 42,
		title: 'Improve docs',
		body: 'Update docs/run.md',
		url: 'https://api.github.com/repos/owner/repo/issues/42',
		htmlUrl: 'https://github.com/owner/repo/issues/42',
		author: 'maintainer',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-02T00:00:00.000Z',
		documentPaths: [{ name: 'run.md', path: 'docs/run.md', isExternal: false }],
		labels: [],
		status: 'available',
		...overrides,
	};
}

function createActiveContribution(overrides: Partial<ActiveContribution> = {}): ActiveContribution {
	return {
		id: 'contribution-1',
		repoSlug: 'owner/repo',
		repoName: 'Repo',
		issueNumber: 42,
		issueTitle: 'Improve docs',
		localPath: '/tmp/repo',
		branchName: 'symphony/issue-42',
		startedAt: '2026-01-01T00:00:00.000Z',
		status: 'running',
		progress: {
			totalDocuments: 2,
			completedDocuments: 1,
			totalTasks: 4,
			completedTasks: 3,
		},
		tokenUsage: {
			inputTokens: 100,
			outputTokens: 50,
			estimatedCost: 0.25,
		},
		timeSpent: 12_000,
		sessionId: 'session-1',
		agentType: 'claude-code',
		...overrides,
	};
}

function createRegistry(repositories: RegisteredRepository[] = []): SymphonyRegistry {
	return {
		schemaVersion: '1.0',
		lastUpdated: '2026-01-01T00:00:00.000Z',
		repositories,
	};
}

function createState(overrides: Partial<SymphonyState> = {}): SymphonyState {
	return {
		active: [],
		history: [],
		stats: {
			totalContributions: 0,
			totalDocuments: 0,
			totalTasks: 0,
			totalTokens: 0,
			totalCost: 0,
			totalTimeMs: 0,
		},
		...overrides,
	} as SymphonyState;
}

function installSymphonyApi(overrides: Partial<SymphonyApi> = {}) {
	const api = {
		getRegistry: vi.fn().mockResolvedValue({
			registry: createRegistry(),
			fromCache: false,
			cacheAge: null,
		}),
		getState: vi.fn().mockResolvedValue({ state: createState() }),
		getIssueCounts: vi.fn().mockResolvedValue({ counts: {} }),
		getIssues: vi.fn().mockResolvedValue({ issues: [] }),
		onUpdated: vi.fn().mockReturnValue(vi.fn()),
		checkPRStatuses: vi.fn().mockResolvedValue({ success: true }),
		cloneRepo: vi.fn().mockResolvedValue({ success: true }),
		startContribution: vi.fn().mockResolvedValue({
			success: true,
			branchName: 'symphony/issue-42',
			autoRunPath: '/tmp/repo/docs',
			draftPrNumber: 7,
			draftPrUrl: 'https://github.com/owner/repo/pull/7',
		}),
		cancel: vi.fn().mockResolvedValue({ cancelled: true }),
		complete: vi.fn().mockResolvedValue({ prUrl: 'https://github.com/owner/repo/pull/7' }),
		...overrides,
	};

	window.maestro = {
		...(window.maestro as any),
		symphony: api,
	} as any;

	return api;
}

async function flushAsyncWork(times = 3) {
	for (let i = 0; i < times; i += 1) {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

describe('useSymphony integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('loads registry/state data and derives filters, ordering, and issue counts', async () => {
		const betaRepo = createRepo({
			slug: 'owner/beta',
			name: 'Beta',
			description: 'Beta docs',
			category: 'docs',
			tags: ['manuals'],
		});
		const featuredRepo = createRepo({
			slug: 'owner/featured',
			name: 'Featured',
			description: 'Featured repo',
			category: 'tools',
			featured: true,
		});
		const taggedRepo = createRepo({
			slug: 'owner/tagged',
			name: 'Tagged',
			description: 'Search by tag',
			category: 'libraries',
			tags: ['react-kit'],
		});
		const zetaRepo = createRepo({
			slug: 'owner/zeta',
			name: 'Zeta',
			description: 'Zeta docs',
			category: 'docs',
		});

		const api = installSymphonyApi({
			getRegistry: vi.fn().mockResolvedValue({
				registry: createRegistry([
					zetaRepo,
					createRepo({ slug: 'owner/inactive', name: 'Inactive', isActive: false }),
					taggedRepo,
					featuredRepo,
					betaRepo,
				]),
				fromCache: true,
				cacheAge: 120,
			}),
			getState: vi.fn().mockResolvedValue({
				state: createState({ active: [createActiveContribution()] }),
			}),
			getIssueCounts: vi.fn().mockResolvedValue({
				counts: { 'owner/beta': 3, 'owner/featured': 1, 'owner/tagged': 2, 'owner/zeta': 4 },
			}),
		});

		const { result } = renderHook(() => useSymphony());

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		await waitFor(() => expect(result.current.issueCounts).toEqual(expect.any(Object)));

		expect(result.current.repositories.map((repo) => repo.slug)).toEqual([
			'owner/featured',
			'owner/beta',
			'owner/tagged',
			'owner/zeta',
		]);
		expect(result.current.filteredRepositories.map((repo) => repo.name)).toEqual([
			'Featured',
			'Beta',
			'Tagged',
			'Zeta',
		]);
		expect(result.current.categories).toEqual(['docs', 'libraries', 'tools']);
		expect(result.current.fromCache).toBe(true);
		expect(result.current.cacheAge).toBe(120);
		expect(result.current.activeContributions).toHaveLength(1);
		expect(api.getIssueCounts).toHaveBeenLastCalledWith([
			'owner/featured',
			'owner/beta',
			'owner/tagged',
			'owner/zeta',
		]);

		await act(async () => {
			result.current.setSelectedCategory('docs');
		});
		expect(result.current.filteredRepositories.map((repo) => repo.name)).toEqual(['Beta', 'Zeta']);

		await act(async () => {
			result.current.setSelectedCategory('all');
			result.current.setSearchQuery('react-kit');
		});
		expect(result.current.filteredRepositories).toEqual([taggedRepo]);
	});

	it('handles registry, state, issue count, issue fetch, and refresh failures', async () => {
		const stateError = new Error('state unavailable');
		const countsError = new Error('counts unavailable');
		const issuesError = new Error('issues unavailable');
		const refreshError = new Error('refresh unavailable');
		const repo = createRepo();
		const api = installSymphonyApi({
			getRegistry: vi
				.fn()
				.mockRejectedValueOnce('bad registry')
				.mockResolvedValueOnce({ registry: createRegistry([repo]) }),
			getState: vi
				.fn()
				.mockRejectedValueOnce(stateError)
				.mockResolvedValueOnce({ state: createState({ active: [createActiveContribution()] }) })
				.mockResolvedValueOnce({ state: createState() }),
			getIssueCounts: vi.fn().mockRejectedValueOnce(countsError),
			getIssues: vi.fn().mockRejectedValueOnce(issuesError),
			checkPRStatuses: vi.fn().mockRejectedValueOnce(refreshError),
		});

		const { result } = renderHook(() => useSymphony());

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.error).toBe('Failed to fetch registry');
		expect(logger.error).toHaveBeenCalledWith(
			'Failed to fetch symphony state:',
			undefined,
			stateError
		);
		expect(result.current.issueCounts).toBeNull();

		await act(async () => {
			await result.current.refresh(false);
		});
		expect(api.getRegistry).toHaveBeenLastCalledWith(false);
		expect(logger.error).toHaveBeenCalledWith(
			'Failed to fetch issue counts:',
			undefined,
			countsError
		);
		expect(logger.error).toHaveBeenCalledWith(
			'Failed to refresh symphony:',
			undefined,
			refreshError
		);

		await act(async () => {
			await result.current.selectRepository(repo);
		});
		expect(result.current.selectedRepo).toEqual(repo);
		expect(result.current.repoIssues).toEqual([]);
		expect(result.current.isLoadingIssues).toBe(false);
		expect(logger.error).toHaveBeenCalledWith('Failed to fetch issues:', undefined, issuesError);

		await act(async () => {
			await result.current.selectRepository(null);
		});
		expect(result.current.selectedRepo).toBeNull();
		expect(result.current.repoIssues).toEqual([]);
	});

	it('tolerates empty IPC payloads while refreshing and selecting repositories', async () => {
		const repo = createRepo();
		const api = installSymphonyApi({
			getRegistry: vi
				.fn()
				.mockResolvedValueOnce({ registry: createRegistry([repo]) })
				.mockResolvedValueOnce({}),
			getState: vi.fn().mockResolvedValue({}),
			getIssueCounts: vi.fn().mockResolvedValue({}),
			getIssues: vi.fn().mockResolvedValue({}),
		});

		const { result } = renderHook(() => useSymphony());

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		await waitFor(() => expect(api.getIssueCounts).toHaveBeenCalledWith(['owner/repo']));
		expect(result.current.symphonyState).toBeNull();
		expect(result.current.issueCounts).toBeNull();

		await act(async () => {
			await result.current.refresh();
		});
		expect(api.getRegistry).toHaveBeenLastCalledWith(true);
		expect(api.checkPRStatuses).toHaveBeenCalled();
		expect(result.current.isRefreshing).toBe(false);

		await act(async () => {
			await result.current.selectRepository(repo);
		});
		expect(result.current.repoIssues).toEqual([]);
	});

	it('uses Error messages from registry failures', async () => {
		installSymphonyApi({
			getRegistry: vi.fn().mockRejectedValue(new Error('registry unavailable')),
		});

		const { result } = renderHook(() => useSymphony());

		await waitFor(() => expect(result.current.isLoading).toBe(false));
		expect(result.current.error).toBe('registry unavailable');
	});

	it('debounces update events, syncs active contributions, and cleans up timers', async () => {
		vi.useFakeTimers();
		const unsubscribe = vi.fn();
		let updatedHandler: (() => void) | undefined;
		const api = installSymphonyApi({
			getState: vi
				.fn()
				.mockResolvedValueOnce({ state: createState() })
				.mockResolvedValue({ state: createState({ active: [createActiveContribution()] }) }),
			onUpdated: vi.fn((handler: () => void) => {
				updatedHandler = handler;
				return unsubscribe;
			}),
		});
		const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
		const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

		const { result, unmount } = renderHook(() => useSymphony());

		await flushAsyncWork();
		expect(result.current.isLoading).toBe(false);

		act(() => {
			updatedHandler?.();
			updatedHandler?.();
		});
		expect(clearTimeoutSpy).toHaveBeenCalled();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});
		expect(api.getState).toHaveBeenCalledTimes(2);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
		});
		await flushAsyncWork();

		expect(api.checkPRStatuses).toHaveBeenCalled();
		expect(api.getState).toHaveBeenCalledTimes(4);

		unmount();
		expect(unsubscribe).toHaveBeenCalled();
		expect(clearIntervalSpy).toHaveBeenCalled();
	});

	it('skips auto-sync when no active contributions are present', async () => {
		vi.useFakeTimers();
		const api = installSymphonyApi({
			getState: vi.fn().mockResolvedValue({ state: createState() }),
		});

		const { result } = renderHook(() => useSymphony());

		await flushAsyncWork();
		expect(result.current.isLoading).toBe(false);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
		});
		await flushAsyncWork();

		expect(api.checkPRStatuses).not.toHaveBeenCalled();
	});

	it('logs auto-sync failures without throwing', async () => {
		vi.useFakeTimers();
		const syncError = new Error('sync failed');
		installSymphonyApi({
			getState: vi
				.fn()
				.mockResolvedValueOnce({ state: createState() })
				.mockRejectedValueOnce(syncError),
		});

		const { result } = renderHook(() => useSymphony());

		await flushAsyncWork();
		expect(result.current.isLoading).toBe(false);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
		});

		expect(logger.error).toHaveBeenCalledWith('Auto-sync failed:', undefined, syncError);
	});

	it('selects repositories and stores fetched issues', async () => {
		const repo = createRepo();
		const issue = createIssue();
		const api = installSymphonyApi({
			getIssues: vi.fn().mockResolvedValue({ issues: [issue] }),
		});

		const { result } = renderHook(() => useSymphony());
		await waitFor(() => expect(result.current.isLoading).toBe(false));

		await act(async () => {
			await result.current.selectRepository(repo);
		});

		expect(api.getIssues).toHaveBeenCalledWith('owner/repo');
		expect(result.current.repoIssues).toEqual([issue]);
		expect(result.current.isLoadingIssues).toBe(false);
	});

	it('starts contributions through clone and start IPC paths', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
		vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
		const repo = createRepo({ name: 'Repo Name' });
		const issue = createIssue();
		const api = installSymphonyApi();
		const { result } = renderHook(() => useSymphony());

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		let started: Awaited<ReturnType<typeof result.current.startContribution>> | undefined;
		await act(async () => {
			started = await result.current.startContribution(repo, issue, 'claude-code', 'session-1');
		});

		expect(started).toMatchObject({
			success: true,
			branchName: 'symphony/issue-42',
			autoRunPath: '/tmp/repo/docs',
			draftPrNumber: 7,
			draftPrUrl: 'https://github.com/owner/repo/pull/7',
		});
		expect(started?.contributionId).toMatch(/^contrib_/);
		expect(api.cloneRepo).toHaveBeenCalledWith({
			repoUrl: 'https://github.com/owner/repo',
			localPath: expect.stringMatching(/^\/tmp\/symphony\/Repo Name-contrib_/),
		});
		expect(api.startContribution).toHaveBeenCalledWith({
			contributionId: started?.contributionId,
			sessionId: 'session-1',
			repoSlug: 'owner/repo',
			issueNumber: 42,
			issueTitle: 'Improve docs',
			localPath: expect.stringMatching(/^\/tmp\/symphony\/Repo Name-contrib_/),
			documentPaths: issue.documentPaths,
		});

		await act(async () => {
			started = await result.current.startContribution(
				repo,
				issue,
				'claude-code',
				'session-2',
				'/custom/repo'
			);
		});
		expect(api.cloneRepo).toHaveBeenLastCalledWith({
			repoUrl: 'https://github.com/owner/repo',
			localPath: '/custom/repo',
		});
	});

	it('reports start contribution failure paths', async () => {
		const repo = createRepo();
		const issue = createIssue();

		const cloneFailureApi = installSymphonyApi({
			cloneRepo: vi.fn().mockResolvedValue({ success: false }),
		});
		let hook = renderHook(() => useSymphony());
		await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
		await expect(
			hook.result.current.startContribution(repo, issue, 'claude-code', 'session-1')
		).resolves.toEqual({
			success: false,
			error: 'Failed to clone repository',
		});
		expect(cloneFailureApi.startContribution).not.toHaveBeenCalled();
		hook.unmount();

		installSymphonyApi({
			startContribution: vi.fn().mockResolvedValue({ success: false }),
		});
		hook = renderHook(() => useSymphony());
		await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
		await expect(
			hook.result.current.startContribution(repo, issue, 'claude-code', 'session-1')
		).resolves.toEqual({
			success: false,
			error: 'Failed to start contribution',
		});
		hook.unmount();

		installSymphonyApi({
			cloneRepo: vi.fn().mockRejectedValue('bad clone'),
		});
		hook = renderHook(() => useSymphony());
		await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
		await expect(
			hook.result.current.startContribution(repo, issue, 'claude-code', 'session-1')
		).resolves.toEqual({
			success: false,
			error: 'Failed to start contribution',
		});
		hook.unmount();

		installSymphonyApi({
			cloneRepo: vi.fn().mockRejectedValue(new Error('clone exploded')),
		});
		hook = renderHook(() => useSymphony());
		await waitFor(() => expect(hook.result.current.isLoading).toBe(false));
		await expect(
			hook.result.current.startContribution(repo, issue, 'claude-code', 'session-1')
		).resolves.toEqual({
			success: false,
			error: 'clone exploded',
		});
	});

	it('cancels contributions and handles cancel failures', async () => {
		const api = installSymphonyApi({
			cancel: vi
				.fn()
				.mockResolvedValueOnce({ cancelled: true })
				.mockResolvedValueOnce({})
				.mockRejectedValueOnce(new Error('cancel failed')),
		});
		const { result } = renderHook(() => useSymphony());

		await waitFor(() => expect(result.current.isLoading).toBe(false));

		await expect(result.current.cancelContribution('contribution-1', false)).resolves.toEqual({
			success: true,
		});
		expect(api.cancel).toHaveBeenCalledWith('contribution-1', false);

		await expect(result.current.cancelContribution('contribution-2')).resolves.toEqual({
			success: false,
		});
		await expect(result.current.cancelContribution('contribution-3')).resolves.toEqual({
			success: false,
		});
	});

	it('finalizes active contributions and reports missing or failed completions', async () => {
		const active = createActiveContribution();
		const api = installSymphonyApi({
			getState: vi.fn().mockResolvedValue({
				state: createState({ active: [active] }),
			}),
			complete: vi
				.fn()
				.mockResolvedValueOnce({ prUrl: 'https://github.com/owner/repo/pull/7' })
				.mockResolvedValueOnce({})
				.mockRejectedValueOnce('bad complete')
				.mockRejectedValueOnce(new Error('complete exploded')),
		});
		const { result } = renderHook(() => useSymphony());

		await waitFor(() => expect(result.current.activeContributions).toHaveLength(1));

		await expect(result.current.finalizeContribution('missing')).resolves.toEqual({
			success: false,
			error: 'Contribution not found',
		});
		await expect(result.current.finalizeContribution('contribution-1')).resolves.toEqual({
			success: true,
			prUrl: 'https://github.com/owner/repo/pull/7',
		});
		expect(api.complete).toHaveBeenCalledWith({
			contributionId: 'contribution-1',
			stats: {
				inputTokens: 100,
				outputTokens: 50,
				estimatedCost: 0.25,
				timeSpentMs: 12_000,
				documentsProcessed: 1,
				tasksCompleted: 3,
			},
		});

		await expect(result.current.finalizeContribution('contribution-1')).resolves.toEqual({
			success: false,
			error: 'Unknown error',
		});
		await expect(result.current.finalizeContribution('contribution-1')).resolves.toEqual({
			success: false,
			error: 'Failed to finalize contribution',
		});
		await expect(result.current.finalizeContribution('contribution-1')).resolves.toEqual({
			success: false,
			error: 'complete exploded',
		});
	});
});
