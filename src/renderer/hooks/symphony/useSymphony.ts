/**
 * useSymphony Hook
 *
 * Primary hook for managing the Maestro Symphony feature.
 * Handles registry fetching, GitHub Issues browsing, and contribution state.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import type {
  SymphonyRegistry,
  RegisteredRepository,
  SymphonyIssue,
  SymphonyState,
  ActiveContribution,
  CompletedContribution,
  ContributorStats,
  SymphonyCategory,
} from '../../../shared/symphony-types';
import { SYMPHONY_CATEGORIES } from '../../../shared/symphony-constants';

// ============================================================================
// Types
// ============================================================================

export interface UseSymphonyReturn {
  // Registry data
  registry: SymphonyRegistry | null;
  repositories: RegisteredRepository[];
  categories: SymphonyCategory[];
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  fromCache: boolean;
  cacheAge: number | null;

  // Filtering
  selectedCategory: SymphonyCategory | 'all';
  setSelectedCategory: (category: SymphonyCategory | 'all') => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  filteredRepositories: RegisteredRepository[];

  // Selected repository
  selectedRepo: RegisteredRepository | null;
  repoIssues: SymphonyIssue[];
  isLoadingIssues: boolean;
  selectRepository: (repo: RegisteredRepository | null) => Promise<void>;

  // Symphony state
  symphonyState: SymphonyState | null;
  activeContributions: ActiveContribution[];
  completedContributions: CompletedContribution[];
  stats: ContributorStats | null;

  // Actions
  refresh: (force?: boolean) => Promise<void>;
  startContribution: (repo: RegisteredRepository, issue: SymphonyIssue, agentType: string, sessionId: string, workingDirectory?: string) => Promise<{
    success: boolean;
    contributionId?: string;
    branchName?: string;
    autoRunPath?: string;
    error?: string;
  }>;
  cancelContribution: (contributionId: string, cleanup?: boolean) => Promise<{ success: boolean }>;
  finalizeContribution: (contributionId: string) => Promise<{
    success: boolean;
    prUrl?: string;
    error?: string;
  }>;
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useSymphony(): UseSymphonyReturn {
  // Registry state
  const [registry, setRegistry] = useState<SymphonyRegistry | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [cacheAge, setCacheAge] = useState<number | null>(null);

  // Filtering state
  const [selectedCategory, setSelectedCategory] = useState<SymphonyCategory | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Selected repository state
  const [selectedRepo, setSelectedRepo] = useState<RegisteredRepository | null>(null);
  const [repoIssues, setRepoIssues] = useState<SymphonyIssue[]>([]);
  const [isLoadingIssues, setIsLoadingIssues] = useState(false);

  // Symphony state
  const [symphonyState, setSymphonyState] = useState<SymphonyState | null>(null);

  // ─────────────────────────────────────────────────────────────────────────
  // Computed Values
  // ─────────────────────────────────────────────────────────────────────────

  const repositories = useMemo(() => {
    return registry?.repositories.filter(r => r.isActive) ?? [];
  }, [registry]);

  const categories = useMemo(() => {
    const cats = new Set<SymphonyCategory>();
    repositories.forEach(r => cats.add(r.category));
    return Array.from(cats).sort((a, b) => {
      const labelA = SYMPHONY_CATEGORIES[a]?.label ?? a;
      const labelB = SYMPHONY_CATEGORIES[b]?.label ?? b;
      return labelA.localeCompare(labelB);
    });
  }, [repositories]);

  const filteredRepositories = useMemo(() => {
    let filtered = repositories;

    // Filter by category
    if (selectedCategory !== 'all') {
      filtered = filtered.filter(r => r.category === selectedCategory);
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(r =>
        r.name.toLowerCase().includes(query) ||
        r.description.toLowerCase().includes(query) ||
        r.slug.toLowerCase().includes(query) ||
        r.tags?.some(t => t.toLowerCase().includes(query))
      );
    }

    // Sort: featured first, then by name
    return filtered.sort((a, b) => {
      if (a.featured && !b.featured) return -1;
      if (!a.featured && b.featured) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [repositories, selectedCategory, searchQuery]);

  const activeContributions = useMemo(() => symphonyState?.active ?? [], [symphonyState]);
  const completedContributions = useMemo(() => symphonyState?.history ?? [], [symphonyState]);
  const stats = useMemo(() => symphonyState?.stats ?? null, [symphonyState]);

  // ─────────────────────────────────────────────────────────────────────────
  // Registry Fetching
  // ─────────────────────────────────────────────────────────────────────────

  const fetchRegistry = useCallback(async (force: boolean = false) => {
    try {
      if (force) {
        setIsRefreshing(true);
      } else {
        setIsLoading(true);
      }
      setError(null);

      const response = await window.maestro.symphony.getRegistry(force);
      if (response.registry) {
        setRegistry(response.registry as SymphonyRegistry);
      }
      setFromCache(response.fromCache ?? false);
      setCacheAge(response.cacheAge ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch registry');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  const fetchSymphonyState = useCallback(async () => {
    try {
      const response = await window.maestro.symphony.getState();
      if (response.state) {
        setSymphonyState(response.state as SymphonyState);
      }
    } catch (err) {
      console.error('Failed to fetch symphony state:', err);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchRegistry();
    fetchSymphonyState();
  }, [fetchRegistry, fetchSymphonyState]);

  // Real-time updates (matches Usage Dashboard pattern)
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = window.maestro.symphony.onUpdated(() => {
      // Debounce to prevent excessive updates
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        fetchSymphonyState();
      }, 500);
    });

    return () => {
      unsubscribe();
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, [fetchSymphonyState]);

  // Periodic auto-sync for active contributions (every 2 minutes)
  // This catches cases where status updates were missed due to connection issues
  useEffect(() => {
    const SYNC_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

    const syncActiveContributions = async () => {
      try {
        // Only sync if we have active contributions
        const state = await window.maestro.symphony.getState();
        if (state.state?.active && state.state.active.length > 0) {
          await window.maestro.symphony.checkPRStatuses();
          await fetchSymphonyState();
        }
      } catch (err) {
        console.error('Auto-sync failed:', err);
      }
    };

    const intervalId = setInterval(syncActiveContributions, SYNC_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [fetchSymphonyState]);

  // ─────────────────────────────────────────────────────────────────────────
  // Repository Selection & GitHub Issues
  // ─────────────────────────────────────────────────────────────────────────

  const selectRepository = useCallback(async (repo: RegisteredRepository | null) => {
    setSelectedRepo(repo);
    setRepoIssues([]);

    if (!repo) return;

    setIsLoadingIssues(true);
    try {
      // Fetch issues with runmaestro.ai label from GitHub API
      const response = await window.maestro.symphony.getIssues(repo.slug);
      if (response.issues) {
        setRepoIssues(response.issues as SymphonyIssue[]);
      }
    } catch (err) {
      console.error('Failed to fetch issues:', err);
    } finally {
      setIsLoadingIssues(false);
    }
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // Contribution Actions
  // ─────────────────────────────────────────────────────────────────────────

  const refresh = useCallback(async (force: boolean = true) => {
    await Promise.all([
      fetchRegistry(force),
      fetchSymphonyState(),
    ]);
  }, [fetchRegistry, fetchSymphonyState]);

  const startContribution = useCallback(async (
    repo: RegisteredRepository,
    issue: SymphonyIssue,
    agentType: string,
    sessionId: string,
    workingDirectory?: string
  ): Promise<{ success: boolean; contributionId?: string; branchName?: string; autoRunPath?: string; error?: string }> => {
    try {
      // Generate contribution ID
      const timestamp = Date.now().toString(36);
      const random = Math.random().toString(36).substring(2, 8);
      const contributionId = `contrib_${timestamp}_${random}`;

      // Determine local path for the clone
      const localPath = workingDirectory || `/tmp/symphony/${repo.name}-${contributionId}`;

      // Step 1: Clone the repository
      const cloneResult = await window.maestro.symphony.cloneRepo({
        repoUrl: repo.url,
        localPath,
      });

      if (!cloneResult.success) {
        return {
          success: false,
          error: cloneResult.error ?? 'Failed to clone repository',
        };
      }

      // Step 2: Start contribution (creates branch, sets up docs, NO PR yet)
      // Draft PR will be created on first real commit via symphony:createDraftPR
      const startResult = await window.maestro.symphony.startContribution({
        contributionId,
        sessionId,
        repoSlug: repo.slug,
        issueNumber: issue.number,
        issueTitle: issue.title,
        localPath,
        documentPaths: issue.documentPaths,
      });

      if (!startResult.success) {
        return {
          success: false,
          error: startResult.error ?? 'Failed to start contribution',
        };
      }

      await fetchSymphonyState();
      return {
        success: true,
        contributionId,
        branchName: startResult.branchName,
        autoRunPath: startResult.autoRunPath,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to start contribution',
      };
    }
  }, [fetchSymphonyState]);

  const cancelContribution = useCallback(async (
    contributionId: string,
    cleanup: boolean = true
  ): Promise<{ success: boolean }> => {
    try {
      // This will:
      // 1. Close the draft PR
      // 2. Delete the local branch
      // 3. Clean up local files
      const result = await window.maestro.symphony.cancel(contributionId, cleanup);
      if (result.cancelled) {
        await fetchSymphonyState();
      }
      return { success: result.cancelled ?? false };
    } catch {
      return { success: false };
    }
  }, [fetchSymphonyState]);

  const finalizeContribution = useCallback(async (
    contributionId: string
  ): Promise<{ success: boolean; prUrl?: string; error?: string }> => {
    const contribution = activeContributions.find(c => c.id === contributionId);
    if (!contribution) {
      return { success: false, error: 'Contribution not found' };
    }

    try {
      // This will:
      // 1. Commit all changes
      // 2. Push to the branch
      // 3. Convert draft PR to ready for review
      const result = await window.maestro.symphony.complete({
        contributionId,
      });

      if (result.prUrl) {
        await fetchSymphonyState();
        return {
          success: true,
          prUrl: result.prUrl,
        };
      }

      return {
        success: false,
        error: result.error ?? 'Unknown error',
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to finalize contribution',
      };
    }
  }, [activeContributions, fetchSymphonyState]);

  // ─────────────────────────────────────────────────────────────────────────
  // Return
  // ─────────────────────────────────────────────────────────────────────────

  return {
    // Registry data
    registry,
    repositories,
    categories,
    isLoading,
    isRefreshing,
    error,
    fromCache,
    cacheAge,

    // Filtering
    selectedCategory,
    setSelectedCategory,
    searchQuery,
    setSearchQuery,
    filteredRepositories,

    // Selected repository
    selectedRepo,
    repoIssues,
    isLoadingIssues,
    selectRepository,

    // Symphony state
    symphonyState,
    activeContributions,
    completedContributions,
    stats,

    // Actions
    refresh,
    startContribution,
    cancelContribution,
    finalizeContribution,
  };
}
