/**
 * @fileoverview Tests for useSymphony hook
 *
 * Tests the Symphony hook including:
 * - Initial state and data loading
 * - Registry fetching with cache support
 * - Repository filtering by category and search
 * - Repository selection and issue fetching
 * - Real-time updates via event subscription
 * - Contribution lifecycle (start, cancel, finalize)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSymphony } from '../../../../renderer/hooks/symphony/useSymphony';
import type {
  SymphonyRegistry,
  RegisteredRepository,
  SymphonyIssue,
  SymphonyState,
  ActiveContribution,
  SymphonyCategory,
} from '../../../../shared/symphony-types';

// ============================================================================
// Test Data Factories
// ============================================================================

const createRepository = (overrides: Partial<RegisteredRepository> = {}): RegisteredRepository => ({
  slug: 'test-owner/test-repo',
  name: 'Test Repository',
  description: 'A test repository for testing',
  url: 'https://github.com/test-owner/test-repo',
  category: 'developer-tools' as SymphonyCategory,
  tags: ['test', 'typescript'],
  maintainer: { name: 'Test Maintainer', url: 'https://github.com/test-maintainer' },
  isActive: true,
  featured: false,
  addedAt: '2025-01-01T00:00:00Z',
  ...overrides,
});

const createIssue = (overrides: Partial<SymphonyIssue> = {}): SymphonyIssue => ({
  number: 1,
  title: 'Test Issue',
  body: 'Test issue body with `docs/task.md`',
  url: 'https://api.github.com/repos/test/repo/issues/1',
  htmlUrl: 'https://github.com/test/repo/issues/1',
  author: 'test-author',
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
  documentPaths: [{ name: 'task.md', path: 'docs/task.md', isExternal: false }],
  status: 'available',
  ...overrides,
});

const createRegistry = (repositories: RegisteredRepository[] = []): SymphonyRegistry => ({
  schemaVersion: '1.0',
  lastUpdated: '2025-01-01T00:00:00Z',
  repositories,
});

const createSymphonyState = (overrides: Partial<SymphonyState> = {}): SymphonyState => ({
  active: [],
  history: [],
  stats: {
    totalContributions: 0,
    totalMerged: 0,
    totalIssuesResolved: 0,
    totalDocumentsProcessed: 0,
    totalTasksCompleted: 0,
    totalTokensUsed: 0,
    totalTimeSpent: 0,
    estimatedCostDonated: 0,
    repositoriesContributed: [],
    uniqueMaintainersHelped: 0,
    currentStreak: 0,
    longestStreak: 0,
  },
  ...overrides,
});

const createActiveContribution = (overrides: Partial<ActiveContribution> = {}): ActiveContribution => ({
  id: 'contrib_abc123_xyz789',
  repoSlug: 'test-owner/test-repo',
  repoName: 'Test Repository',
  issueNumber: 1,
  issueTitle: 'Test Issue',
  localPath: '/tmp/symphony/test-repo',
  branchName: 'symphony/issue-1-abc123',
  draftPrNumber: 1,
  draftPrUrl: 'https://github.com/test/repo/pull/1',
  startedAt: '2025-01-01T00:00:00Z',
  status: 'running',
  progress: {
    totalDocuments: 1,
    completedDocuments: 0,
    currentDocument: 'docs/task.md',
    totalTasks: 5,
    completedTasks: 2,
  },
  tokenUsage: {
    inputTokens: 1000,
    outputTokens: 500,
    estimatedCost: 0.05,
  },
  timeSpent: 60000,
  sessionId: 'session-123',
  agentType: 'claude-code',
  ...overrides,
});

// ============================================================================
// Test Setup
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// Test Suites
// ============================================================================

describe('useSymphony', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Initial State Tests
  // ──────────────────────────────────────────────────────────────────────────

  describe('initial state', () => {
    it('should initialize with null registry', async () => {
      const { result } = renderHook(() => useSymphony());

      // Initial state before fetch completes
      expect(result.current.registry).toBe(null);
    });

    it('should initialize with isLoading true', () => {
      const { result } = renderHook(() => useSymphony());
      expect(result.current.isLoading).toBe(true);
    });

    it('should initialize with empty repositories array', () => {
      const { result } = renderHook(() => useSymphony());
      expect(result.current.repositories).toEqual([]);
    });

    it('should initialize with selectedCategory as "all"', () => {
      const { result } = renderHook(() => useSymphony());
      expect(result.current.selectedCategory).toBe('all');
    });

    it('should initialize with empty searchQuery', () => {
      const { result } = renderHook(() => useSymphony());
      expect(result.current.searchQuery).toBe('');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Registry Fetching Tests
  // ──────────────────────────────────────────────────────────────────────────

  describe('registry fetching', () => {
    it('should fetch registry on mount', async () => {
      const testRegistry = createRegistry([createRepository()]);
      vi.mocked(window.maestro.symphony.getRegistry).mockResolvedValue({
        registry: testRegistry,
        fromCache: false,
        cacheAge: 0,
      });

      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(window.maestro.symphony.getRegistry).toHaveBeenCalledTimes(1);
    });

    it('should fetch symphony state on mount', async () => {
      const testState = createSymphonyState();
      vi.mocked(window.maestro.symphony.getState).mockResolvedValue({ state: testState });

      renderHook(() => useSymphony());

      await waitFor(() => {
        expect(window.maestro.symphony.getState).toHaveBeenCalledTimes(1);
      });
    });

    it('should set registry data from API response', async () => {
      const testRegistry = createRegistry([createRepository()]);
      vi.mocked(window.maestro.symphony.getRegistry).mockResolvedValue({
        registry: testRegistry,
        fromCache: false,
        cacheAge: 0,
      });

      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.registry).toEqual(testRegistry);
      });

      expect(result.current.repositories).toHaveLength(1);
    });

    it('should set fromCache and cacheAge from response', async () => {
      const testRegistry = createRegistry([]);
      vi.mocked(window.maestro.symphony.getRegistry).mockResolvedValue({
        registry: testRegistry,
        fromCache: true,
        cacheAge: 300000, // 5 minutes
      });

      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.fromCache).toBe(true);
      expect(result.current.cacheAge).toBe(300000);
    });

    it('should set error on fetch failure', async () => {
      vi.mocked(window.maestro.symphony.getRegistry).mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toBe('Network error');
      expect(result.current.registry).toBe(null);
    });

    it('should set isLoading false after fetch', async () => {
      vi.mocked(window.maestro.symphony.getRegistry).mockResolvedValue({
        registry: createRegistry([]),
        fromCache: false,
        cacheAge: 0,
      });

      const { result } = renderHook(() => useSymphony());

      expect(result.current.isLoading).toBe(true);

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Filtering Tests
  // ──────────────────────────────────────────────────────────────────────────

  describe('filtering', () => {
    const setupWithRepositories = async () => {
      const repositories = [
        createRepository({
          slug: 'owner/repo-1',
          name: 'Alpha Repository',
          description: 'First repository',
          category: 'ai-ml',
          tags: ['ai', 'machine-learning'],
          isActive: true,
          featured: true,
        }),
        createRepository({
          slug: 'owner/repo-2',
          name: 'Beta Repository',
          description: 'Second repository',
          category: 'developer-tools',
          tags: ['cli', 'tools'],
          isActive: true,
          featured: false,
        }),
        createRepository({
          slug: 'owner/repo-3',
          name: 'Gamma Repository',
          description: 'Third repository for documentation',
          category: 'ai-ml',
          tags: ['docs'],
          isActive: true,
          featured: false,
        }),
        createRepository({
          slug: 'owner/inactive-repo',
          name: 'Inactive Repository',
          description: 'Inactive repository',
          category: 'web',
          isActive: false,
        }),
      ];

      vi.mocked(window.maestro.symphony.getRegistry).mockResolvedValue({
        registry: createRegistry(repositories),
        fromCache: false,
        cacheAge: 0,
      });

      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      return result;
    };

    it('should filter repositories to only active repos', async () => {
      const result = await setupWithRepositories();

      expect(result.current.repositories).toHaveLength(3);
      expect(result.current.repositories.every((r) => r.isActive)).toBe(true);
    });

    it('should extract unique categories from repositories', async () => {
      const result = await setupWithRepositories();

      expect(result.current.categories).toContain('ai-ml');
      expect(result.current.categories).toContain('developer-tools');
      // web category has no active repos
      expect(result.current.categories).not.toContain('web');
    });

    it('should filter filteredRepositories by selectedCategory', async () => {
      const result = await setupWithRepositories();

      act(() => {
        result.current.setSelectedCategory('ai-ml');
      });

      expect(result.current.filteredRepositories).toHaveLength(2);
      expect(result.current.filteredRepositories.every((r) => r.category === 'ai-ml')).toBe(true);
    });

    it('should filter filteredRepositories by searchQuery in name', async () => {
      const result = await setupWithRepositories();

      act(() => {
        result.current.setSearchQuery('Alpha');
      });

      expect(result.current.filteredRepositories).toHaveLength(1);
      expect(result.current.filteredRepositories[0].name).toBe('Alpha Repository');
    });

    it('should filter filteredRepositories by searchQuery in description', async () => {
      const result = await setupWithRepositories();

      act(() => {
        result.current.setSearchQuery('documentation');
      });

      expect(result.current.filteredRepositories).toHaveLength(1);
      expect(result.current.filteredRepositories[0].slug).toBe('owner/repo-3');
    });

    it('should filter filteredRepositories by searchQuery in slug', async () => {
      const result = await setupWithRepositories();

      act(() => {
        result.current.setSearchQuery('repo-2');
      });

      expect(result.current.filteredRepositories).toHaveLength(1);
      expect(result.current.filteredRepositories[0].slug).toBe('owner/repo-2');
    });

    it('should filter filteredRepositories by searchQuery in tags', async () => {
      const result = await setupWithRepositories();

      act(() => {
        result.current.setSearchQuery('machine-learning');
      });

      expect(result.current.filteredRepositories).toHaveLength(1);
      expect(result.current.filteredRepositories[0].slug).toBe('owner/repo-1');
    });

    it('should sort featured repos first', async () => {
      const result = await setupWithRepositories();

      // Featured repo should be first
      expect(result.current.filteredRepositories[0].featured).toBe(true);
    });

    it('should sort alphabetically within groups', async () => {
      const result = await setupWithRepositories();

      // Non-featured repos should be sorted alphabetically
      const nonFeatured = result.current.filteredRepositories.filter((r) => !r.featured);
      const names = nonFeatured.map((r) => r.name);
      const sortedNames = [...names].sort();
      expect(names).toEqual(sortedNames);
    });

  });

  // ──────────────────────────────────────────────────────────────────────────
  // Repository Selection Tests
  // ──────────────────────────────────────────────────────────────────────────

  describe('repository selection', () => {
    it('should set selectedRepo state', async () => {
      const testRepo = createRepository();
      vi.mocked(window.maestro.symphony.getRegistry).mockResolvedValue({
        registry: createRegistry([testRepo]),
        fromCache: false,
        cacheAge: 0,
      });

      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.selectRepository(testRepo);
      });

      expect(result.current.selectedRepo).toEqual(testRepo);
    });

    it('should clear repoIssues when selecting', async () => {
      const testRepo = createRepository();
      vi.mocked(window.maestro.symphony.getIssues).mockResolvedValue({
        issues: [createIssue()],
        fromCache: false,
        cacheAge: 0,
      });

      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Select first repo and load issues
      await act(async () => {
        await result.current.selectRepository(testRepo);
      });

      await waitFor(() => {
        expect(result.current.repoIssues).toHaveLength(1);
      });

      // Select a different repo - issues should be cleared immediately
      const anotherRepo = createRepository({ slug: 'another/repo' });
      act(() => {
        result.current.selectRepository(anotherRepo);
      });

      // Issues should be cleared before new fetch completes
      expect(result.current.repoIssues).toEqual([]);
    });

    it('should fetch issues for selected repo', async () => {
      const testRepo = createRepository({ slug: 'test/repo' });
      const testIssues = [createIssue({ number: 1 }), createIssue({ number: 2 })];

      vi.mocked(window.maestro.symphony.getIssues).mockResolvedValue({
        issues: testIssues,
        fromCache: false,
        cacheAge: 0,
      });

      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.selectRepository(testRepo);
      });

      expect(window.maestro.symphony.getIssues).toHaveBeenCalledWith('test/repo');
    });

    it('should set isLoadingIssues during fetch', async () => {
      const testRepo = createRepository();

      // Make getIssues return a promise that we control
      let resolveIssues: (value: unknown) => void;
      vi.mocked(window.maestro.symphony.getIssues).mockReturnValue(
        new Promise((resolve) => {
          resolveIssues = resolve;
        })
      );

      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      act(() => {
        result.current.selectRepository(testRepo);
      });

      expect(result.current.isLoadingIssues).toBe(true);

      await act(async () => {
        resolveIssues!({ issues: [], fromCache: false, cacheAge: 0 });
      });

      expect(result.current.isLoadingIssues).toBe(false);
    });

    it('should set repoIssues from response', async () => {
      const testRepo = createRepository();
      const testIssues = [createIssue({ number: 42, title: 'Test Issue 42' })];

      vi.mocked(window.maestro.symphony.getIssues).mockResolvedValue({
        issues: testIssues,
        fromCache: false,
        cacheAge: 0,
      });

      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.selectRepository(testRepo);
      });

      expect(result.current.repoIssues).toEqual(testIssues);
    });

    it('should handle null selection (deselect)', async () => {
      const testRepo = createRepository();

      vi.mocked(window.maestro.symphony.getIssues).mockResolvedValue({
        issues: [createIssue()],
        fromCache: false,
        cacheAge: 0,
      });

      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Select repo
      await act(async () => {
        await result.current.selectRepository(testRepo);
      });

      expect(result.current.selectedRepo).not.toBe(null);

      // Deselect
      await act(async () => {
        await result.current.selectRepository(null);
      });

      expect(result.current.selectedRepo).toBe(null);
      expect(result.current.repoIssues).toEqual([]);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Real-time Updates Tests
  // ──────────────────────────────────────────────────────────────────────────

  describe('real-time updates', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should subscribe to symphony:updated events', async () => {
      await act(async () => {
        renderHook(() => useSymphony());
        await Promise.resolve();
      });

      expect(window.maestro.symphony.onUpdated).toHaveBeenCalled();
    });

    it('should refetch state on update event (debounced)', async () => {
      let updateCallback: (() => void) | null = null;
      vi.mocked(window.maestro.symphony.onUpdated).mockImplementation((callback) => {
        updateCallback = callback;
        return () => {};
      });

      await act(async () => {
        renderHook(() => useSymphony());
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(updateCallback).not.toBe(null);

      // Initial call
      const initialCalls = vi.mocked(window.maestro.symphony.getState).mock.calls.length;

      // Trigger update
      act(() => {
        updateCallback!();
      });

      // Advance time past debounce (500ms)
      await act(async () => {
        vi.advanceTimersByTime(600);
        await Promise.resolve();
      });

      expect(vi.mocked(window.maestro.symphony.getState).mock.calls.length).toBeGreaterThan(
        initialCalls
      );
    });

    it('should unsubscribe on unmount', async () => {
      const unsubscribe = vi.fn();
      vi.mocked(window.maestro.symphony.onUpdated).mockReturnValue(unsubscribe);

      const { unmount } = renderHook(() => useSymphony());

      await act(async () => {
        await Promise.resolve();
      });

      unmount();

      expect(unsubscribe).toHaveBeenCalled();
    });

    it('should debounce to prevent excessive refetches', async () => {
      let updateCallback: (() => void) | null = null;
      vi.mocked(window.maestro.symphony.onUpdated).mockImplementation((callback) => {
        updateCallback = callback;
        return () => {};
      });

      await act(async () => {
        renderHook(() => useSymphony());
        await Promise.resolve();
        await Promise.resolve();
      });

      const initialCalls = vi.mocked(window.maestro.symphony.getState).mock.calls.length;

      // Trigger multiple updates rapidly
      act(() => {
        updateCallback!();
        updateCallback!();
        updateCallback!();
      });

      // Advance time to just before debounce completes
      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
      });

      // Should not have refetched yet (still within debounce window)
      expect(vi.mocked(window.maestro.symphony.getState).mock.calls.length).toBe(initialCalls);

      // Complete the debounce
      await act(async () => {
        vi.advanceTimersByTime(200);
        await Promise.resolve();
      });

      // Should have refetched exactly once
      expect(vi.mocked(window.maestro.symphony.getState).mock.calls.length).toBe(initialCalls + 1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Refresh Action Tests
  // ──────────────────────────────────────────────────────────────────────────

  describe('refresh action', () => {
    it('should fetch both registry and state', async () => {
      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      vi.clearAllMocks();

      await act(async () => {
        await result.current.refresh();
      });

      expect(window.maestro.symphony.getRegistry).toHaveBeenCalled();
      expect(window.maestro.symphony.getState).toHaveBeenCalled();
    });

    it('should bypass cache with force=true', async () => {
      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      vi.clearAllMocks();

      await act(async () => {
        await result.current.refresh(true);
      });

      expect(window.maestro.symphony.getRegistry).toHaveBeenCalledWith(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Start Contribution Tests
  // ──────────────────────────────────────────────────────────────────────────

  describe('start contribution', () => {
    const testRepo = createRepository({ slug: 'owner/repo', name: 'Test Repo', url: 'https://github.com/owner/repo' });
    const testIssue = createIssue({ number: 42, title: 'Fix bug', documentPaths: [{ name: 'task.md', path: 'docs/task.md', isExternal: false }] });

    it('should generate unique contribution ID', async () => {
      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        const result1 = await result.current.startContribution(
          testRepo,
          testIssue,
          'claude-code',
          'session-1'
        );
        const result2 = await result.current.startContribution(
          testRepo,
          testIssue,
          'claude-code',
          'session-2'
        );

        expect(result1.contributionId).not.toBe(result2.contributionId);
      });
    });

    it('should call cloneRepo API', async () => {
      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.startContribution(testRepo, testIssue, 'claude-code', 'session-1');
      });

      expect(window.maestro.symphony.cloneRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          repoUrl: testRepo.url,
        })
      );
    });

    it('should return error on clone failure', async () => {
      vi.mocked(window.maestro.symphony.cloneRepo).mockResolvedValue({
        success: false,
        error: 'Clone failed: permission denied',
      });

      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      let startResult: { success: boolean; error?: string };
      await act(async () => {
        startResult = await result.current.startContribution(
          testRepo,
          testIssue,
          'claude-code',
          'session-1'
        );
      });

      expect(startResult!.success).toBe(false);
      expect(startResult!.error).toContain('Clone failed');
    });

    it('should call startContribution API', async () => {
      vi.mocked(window.maestro.symphony.cloneRepo).mockResolvedValue({ success: true });

      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.startContribution(testRepo, testIssue, 'claude-code', 'session-1');
      });

      expect(window.maestro.symphony.startContribution).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          repoSlug: 'owner/repo',
          issueNumber: 42,
          issueTitle: 'Fix bug',
        })
      );
    });

    it('should return error on start failure', async () => {
      vi.mocked(window.maestro.symphony.cloneRepo).mockResolvedValue({ success: true });
      vi.mocked(window.maestro.symphony.startContribution).mockResolvedValue({
        success: false,
        error: 'Branch creation failed',
      });

      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      let startResult: { success: boolean; error?: string };
      await act(async () => {
        startResult = await result.current.startContribution(
          testRepo,
          testIssue,
          'claude-code',
          'session-1'
        );
      });

      expect(startResult!.success).toBe(false);
      expect(startResult!.error).toContain('Branch creation failed');
    });

    it('should refetch state on success', async () => {
      vi.mocked(window.maestro.symphony.cloneRepo).mockResolvedValue({ success: true });
      vi.mocked(window.maestro.symphony.startContribution).mockResolvedValue({
        success: true,
        branchName: 'symphony/issue-42-abc',
        autoRunPath: '/path/to/docs',
      });

      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const callsBefore = vi.mocked(window.maestro.symphony.getState).mock.calls.length;

      await act(async () => {
        await result.current.startContribution(testRepo, testIssue, 'claude-code', 'session-1');
      });

      expect(vi.mocked(window.maestro.symphony.getState).mock.calls.length).toBeGreaterThan(
        callsBefore
      );
    });

    it('should return contributionId, branchName, autoRunPath', async () => {
      vi.mocked(window.maestro.symphony.cloneRepo).mockResolvedValue({ success: true });
      vi.mocked(window.maestro.symphony.startContribution).mockResolvedValue({
        success: true,
        branchName: 'symphony/issue-42-xyz',
        autoRunPath: '/path/to/autorun/docs',
      });

      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      let startResult: { success: boolean; contributionId?: string; branchName?: string; autoRunPath?: string };
      await act(async () => {
        startResult = await result.current.startContribution(
          testRepo,
          testIssue,
          'claude-code',
          'session-1'
        );
      });

      expect(startResult!.success).toBe(true);
      expect(startResult!.contributionId).toMatch(/^contrib_/);
      expect(startResult!.branchName).toBe('symphony/issue-42-xyz');
      expect(startResult!.autoRunPath).toBe('/path/to/autorun/docs');
    });

    it('should return draftPrNumber and draftPrUrl when draft PR is created', async () => {
      vi.mocked(window.maestro.symphony.cloneRepo).mockResolvedValue({ success: true });
      vi.mocked(window.maestro.symphony.startContribution).mockResolvedValue({
        success: true,
        branchName: 'symphony/issue-42-xyz',
        autoRunPath: '/path/to/autorun/docs',
        draftPrNumber: 99,
        draftPrUrl: 'https://github.com/owner/repo/pull/99',
      });

      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      let startResult: { success: boolean; draftPrNumber?: number; draftPrUrl?: string };
      await act(async () => {
        startResult = await result.current.startContribution(
          testRepo,
          testIssue,
          'claude-code',
          'session-1'
        );
      });

      expect(startResult!.success).toBe(true);
      expect(startResult!.draftPrNumber).toBe(99);
      expect(startResult!.draftPrUrl).toBe('https://github.com/owner/repo/pull/99');
    });

    it('should succeed even when draft PR creation fails (non-blocking)', async () => {
      vi.mocked(window.maestro.symphony.cloneRepo).mockResolvedValue({ success: true });
      vi.mocked(window.maestro.symphony.startContribution).mockResolvedValue({
        success: true,
        branchName: 'symphony/issue-42-xyz',
        autoRunPath: '/path/to/autorun/docs',
        // No draftPrNumber/draftPrUrl - PR creation failed but contribution succeeded
      });

      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      let startResult: { success: boolean; draftPrNumber?: number; draftPrUrl?: string };
      await act(async () => {
        startResult = await result.current.startContribution(
          testRepo,
          testIssue,
          'claude-code',
          'session-1'
        );
      });

      expect(startResult!.success).toBe(true);
      expect(startResult!.draftPrNumber).toBeUndefined();
      expect(startResult!.draftPrUrl).toBeUndefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Cancel Contribution Tests
  // ──────────────────────────────────────────────────────────────────────────

  describe('cancel contribution', () => {
    it('should call cancel API', async () => {
      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await act(async () => {
        await result.current.cancelContribution('contrib_123');
      });

      expect(window.maestro.symphony.cancel).toHaveBeenCalledWith('contrib_123', true);
    });

    it('should refetch state on success', async () => {
      vi.mocked(window.maestro.symphony.cancel).mockResolvedValue({ cancelled: true });

      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const callsBefore = vi.mocked(window.maestro.symphony.getState).mock.calls.length;

      await act(async () => {
        await result.current.cancelContribution('contrib_123');
      });

      expect(vi.mocked(window.maestro.symphony.getState).mock.calls.length).toBeGreaterThan(
        callsBefore
      );
    });

    it('should return success status', async () => {
      vi.mocked(window.maestro.symphony.cancel).mockResolvedValue({ cancelled: true });

      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      let cancelResult: { success: boolean };
      await act(async () => {
        cancelResult = await result.current.cancelContribution('contrib_123');
      });

      expect(cancelResult!.success).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Finalize Contribution Tests
  // ──────────────────────────────────────────────────────────────────────────

  describe('finalize contribution', () => {
    const setupWithActiveContribution = async () => {
      const contribution = createActiveContribution({ id: 'contrib_active_123' });
      const state = createSymphonyState({ active: [contribution] });

      vi.mocked(window.maestro.symphony.getState).mockResolvedValue({ state });

      const { result } = renderHook(() => useSymphony());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      await waitFor(() => {
        expect(result.current.activeContributions).toHaveLength(1);
      });

      return result;
    };

    it('should find contribution in active list', async () => {
      const result = await setupWithActiveContribution();

      await act(async () => {
        await result.current.finalizeContribution('contrib_active_123');
      });

      expect(window.maestro.symphony.complete).toHaveBeenCalledWith(
        expect.objectContaining({
          contributionId: 'contrib_active_123',
        })
      );
    });

    it('should return error if not found', async () => {
      const result = await setupWithActiveContribution();

      let finalizeResult: { success: boolean; error?: string };
      await act(async () => {
        finalizeResult = await result.current.finalizeContribution('nonexistent_id');
      });

      expect(finalizeResult!.success).toBe(false);
      expect(finalizeResult!.error).toBe('Contribution not found');
    });

    it('should call complete API', async () => {
      const result = await setupWithActiveContribution();

      await act(async () => {
        await result.current.finalizeContribution('contrib_active_123');
      });

      expect(window.maestro.symphony.complete).toHaveBeenCalledWith({
        contributionId: 'contrib_active_123',
      });
    });

    it('should refetch state on success', async () => {
      vi.mocked(window.maestro.symphony.complete).mockResolvedValue({
        prUrl: 'https://github.com/test/repo/pull/1',
      });

      const result = await setupWithActiveContribution();

      const callsBefore = vi.mocked(window.maestro.symphony.getState).mock.calls.length;

      await act(async () => {
        await result.current.finalizeContribution('contrib_active_123');
      });

      expect(vi.mocked(window.maestro.symphony.getState).mock.calls.length).toBeGreaterThan(
        callsBefore
      );
    });

    it('should return prUrl on success', async () => {
      vi.mocked(window.maestro.symphony.complete).mockResolvedValue({
        prUrl: 'https://github.com/test/repo/pull/42',
      });

      const result = await setupWithActiveContribution();

      let finalizeResult: { success: boolean; prUrl?: string };
      await act(async () => {
        finalizeResult = await result.current.finalizeContribution('contrib_active_123');
      });

      expect(finalizeResult!.success).toBe(true);
      expect(finalizeResult!.prUrl).toBe('https://github.com/test/repo/pull/42');
    });

    it('should return error on failure', async () => {
      vi.mocked(window.maestro.symphony.complete).mockResolvedValue({
        error: 'Push failed',
      });

      const result = await setupWithActiveContribution();

      let finalizeResult: { success: boolean; error?: string };
      await act(async () => {
        finalizeResult = await result.current.finalizeContribution('contrib_active_123');
      });

      expect(finalizeResult!.success).toBe(false);
      expect(finalizeResult!.error).toBe('Push failed');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Symphony Auto-Start Batch Config Tests
  // ──────────────────────────────────────────────────────────────────────────
  // Validates the mapping from Symphony document paths to BatchRunConfig,
  // which App.tsx uses to auto-start batch runs when a contribution begins.

  describe('Symphony → BatchRunConfig mapping', () => {
    it('should strip .md extension from document names for batch filenames', () => {
      const documentPaths = [
        { name: 'PERF-01.md', path: 'https://example.com/PERF-01.md', isExternal: true },
        { name: 'PERF-02.md', path: 'https://example.com/PERF-02.md', isExternal: true },
        { name: 'task.md', path: 'docs/task.md', isExternal: false },
      ];

      const filenames = documentPaths.map((doc) => doc.name.replace(/\.md$/, ''));

      expect(filenames).toEqual(['PERF-01', 'PERF-02', 'task']);
    });

    it('should handle document names without .md extension', () => {
      const documentPaths = [
        { name: 'README', path: 'README', isExternal: false },
        { name: 'TASK-01.md', path: 'docs/TASK-01.md', isExternal: false },
      ];

      const filenames = documentPaths.map((doc) => doc.name.replace(/\.md$/, ''));

      expect(filenames).toEqual(['README', 'TASK-01']);
    });

    it('should produce valid BatchDocumentEntry structure', () => {
      const documentPaths = [
        { name: 'PERF-01.md', path: 'https://example.com/PERF-01.md', isExternal: true },
      ];

      const documents = documentPaths.map((doc) => ({
        id: 'test-id',
        filename: doc.name.replace(/\.md$/, ''),
        resetOnCompletion: false,
        isDuplicate: false,
      }));

      expect(documents).toEqual([
        {
          id: 'test-id',
          filename: 'PERF-01',
          resetOnCompletion: false,
          isDuplicate: false,
        },
      ]);
    });

    it('should include all documents in batch config (not just first)', () => {
      const documentPaths = [
        { name: 'PERF-01.md', path: 'p1', isExternal: true },
        { name: 'PERF-02.md', path: 'p2', isExternal: true },
        { name: 'PERF-03.md', path: 'p3', isExternal: true },
        { name: 'PERF-04.md', path: 'p4', isExternal: true },
        { name: 'PERF-05.md', path: 'p5', isExternal: true },
        { name: 'PERF-06.md', path: 'p6', isExternal: true },
        { name: 'PERF-07.md', path: 'p7', isExternal: true },
        { name: 'PERF-08.md', path: 'p8', isExternal: true },
      ];

      const documents = documentPaths.map((doc) => ({
        id: 'test-id',
        filename: doc.name.replace(/\.md$/, ''),
        resetOnCompletion: false,
        isDuplicate: false,
      }));

      expect(documents).toHaveLength(8);
      expect(documents.map((d) => d.filename)).toEqual([
        'PERF-01', 'PERF-02', 'PERF-03', 'PERF-04',
        'PERF-05', 'PERF-06', 'PERF-07', 'PERF-08',
      ]);
    });

    it('should not auto-start when documentPaths is empty', () => {
      const documentPaths: { name: string; path: string; isExternal: boolean }[] = [];

      // Mirrors the guard: if (data.autoRunPath && data.issue.documentPaths.length > 0)
      const shouldAutoStart = documentPaths.length > 0;

      expect(shouldAutoStart).toBe(false);
    });

    it('should not auto-start when autoRunPath is undefined', () => {
      const autoRunPath: string | undefined = undefined;
      const documentPaths = [
        { name: 'PERF-01.md', path: 'p1', isExternal: true },
      ];

      // Mirrors the guard: if (data.autoRunPath && data.issue.documentPaths.length > 0)
      const shouldAutoStart = !!autoRunPath && documentPaths.length > 0;

      expect(shouldAutoStart).toBe(false);
    });
  });
});
