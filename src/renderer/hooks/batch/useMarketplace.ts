/**
 * useMarketplace Hook
 *
 * React hook for managing Playbook Exchange state and operations.
 *
 * This hook encapsulates:
 * - Fetching and caching the marketplace manifest
 * - Category extraction and filtering
 * - Search functionality (title, description, tags)
 * - Refresh operations (bypass cache)
 * - Import operations (download playbook to Auto Run folder)
 * - Document preview fetching (README, individual documents)
 *
 * The marketplace data is fetched from the Maestro-Playbooks GitHub repository
 * and cached locally for 5 minutes to reduce API calls.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import type {
  MarketplaceManifest,
  MarketplacePlaybook,
} from '../../../shared/marketplace-types';

/**
 * Return type for the useMarketplace hook
 */
export interface UseMarketplaceReturn {
  // Data
  /** The full marketplace manifest (or null if not loaded) */
  manifest: MarketplaceManifest | null;
  /** All playbooks from the manifest */
  playbooks: MarketplacePlaybook[];
  /** Available categories including 'All' */
  categories: string[];

  // Loading states
  /** True during initial manifest load */
  isLoading: boolean;
  /** True during a manual refresh operation */
  isRefreshing: boolean;
  /** True during a playbook import operation */
  isImporting: boolean;

  // Cache info
  /** Whether the current data was served from cache */
  fromCache: boolean;
  /** Cache age in milliseconds (null if not from cache) */
  cacheAge: number | null;

  // Error state
  /** Current error message (null if no error) */
  error: string | null;

  // Filter state
  /** Currently selected category ('All' or category name) */
  selectedCategory: string;
  /** Current search query string */
  searchQuery: string;
  /** Playbooks filtered by category and search query */
  filteredPlaybooks: MarketplacePlaybook[];

  // Actions
  /** Set the selected category filter */
  setSelectedCategory: (category: string) => void;
  /** Set the search query */
  setSearchQuery: (query: string) => void;
  /** Force refresh manifest from GitHub (bypasses cache) */
  refresh: () => Promise<void>;
  /** Import a playbook to the Auto Run folder (supports SSH remote via sshRemoteId) */
  importPlaybook: (
    playbook: MarketplacePlaybook,
    targetFolderName: string,
    autoRunFolderPath: string,
    sessionId: string,
    sshRemoteId?: string
  ) => Promise<{ success: boolean; error?: string }>;

  // Document preview
  /** Fetch the README.md content for a playbook */
  fetchReadme: (playbookPath: string) => Promise<string | null>;
  /** Fetch a specific document's content from a playbook */
  fetchDocument: (playbookPath: string, filename: string) => Promise<string | null>;
}

/**
 * Hook for managing Playbook Exchange state and operations.
 *
 * @example
 * ```typescript
 * const {
 *   playbooks,
 *   categories,
 *   isLoading,
 *   filteredPlaybooks,
 *   selectedCategory,
 *   setSelectedCategory,
 *   searchQuery,
 *   setSearchQuery,
 *   refresh,
 *   importPlaybook,
 * } = useMarketplace();
 *
 * // Filter by category
 * setSelectedCategory('Security');
 *
 * // Search playbooks
 * setSearchQuery('authentication');
 *
 * // Import a playbook
 * const result = await importPlaybook(playbook, 'my-playbook', folderPath, sessionId);
 * ```
 */
export function useMarketplace(): UseMarketplaceReturn {
  // Data state
  const [manifest, setManifest] = useState<MarketplaceManifest | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [cacheAge, setCacheAge] = useState<number | null>(null);

  // Loading states
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  // Error state
  const [error, setError] = useState<string | null>(null);

  // Filter state
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');

  // Load manifest on mount
  useEffect(() => {
    const loadManifest = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const result = await window.maestro.marketplace.getManifest();
        if (result.success && result.manifest) {
          setManifest(result.manifest);
          setFromCache(result.fromCache ?? false);
          setCacheAge(result.cacheAge ?? null);
        } else if (!result.success) {
          setError(result.error || 'Failed to load marketplace data');
        }
      } catch (err) {
        console.error('Failed to load marketplace manifest:', err);
        setError('Failed to load marketplace data');
      }
      setIsLoading(false);
    };

    loadManifest();
  }, []);

  // Hot reload: listen for manifest changes (local-manifest.json edits)
  useEffect(() => {
    const cleanup = window.maestro.marketplace.onManifestChanged(async () => {
      console.log('Local manifest changed, reloading...');
      try {
        const result = await window.maestro.marketplace.getManifest();
        if (result.success && result.manifest) {
          setManifest(result.manifest);
          setFromCache(result.fromCache ?? false);
          setCacheAge(result.cacheAge ?? null);
        }
      } catch (err) {
        console.error('Failed to reload manifest after change:', err);
      }
    });

    return cleanup;
  }, []);

  // Extract playbooks from manifest
  const playbooks = useMemo(() => {
    return manifest?.playbooks ?? [];
  }, [manifest]);

  // Extract unique categories from playbooks
  const categories = useMemo(() => {
    if (!manifest) return ['All'];
    const cats = new Set(manifest.playbooks.map((p) => p.category));
    return ['All', ...Array.from(cats).sort()];
  }, [manifest]);

  // Filter playbooks by category and search query
  const filteredPlaybooks = useMemo(() => {
    if (!manifest) return [];

    let filtered = manifest.playbooks;

    // Filter by category
    if (selectedCategory !== 'All') {
      filtered = filtered.filter((p) => p.category === selectedCategory);
    }

    // Filter by search query (title, description, tags)
    if (searchQuery.trim()) {
      const query = searchQuery.trim().toLowerCase();
      filtered = filtered.filter(
        (p) =>
          p.title.toLowerCase().includes(query) ||
          p.description.toLowerCase().includes(query) ||
          (p.tags && p.tags.some((t) => t.toLowerCase().includes(query)))
      );
    }

    return filtered;
  }, [manifest, selectedCategory, searchQuery]);

  // Refresh manifest (bypasses cache)
  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    setError(null);
    try {
      const result = await window.maestro.marketplace.refreshManifest();
      if (result.success && result.manifest) {
        setManifest(result.manifest);
        setFromCache(false);
        setCacheAge(0);
      } else if (!result.success) {
        setError(result.error || 'Failed to refresh marketplace data');
      }
    } catch (err) {
      console.error('Failed to refresh marketplace manifest:', err);
      setError('Failed to refresh marketplace data');
    }
    setIsRefreshing(false);
  }, []);

  // Import a playbook to the Auto Run folder (supports SSH remote via sshRemoteId)
  const importPlaybook = useCallback(
    async (
      playbook: MarketplacePlaybook,
      targetFolderName: string,
      autoRunFolderPath: string,
      sessionId: string,
      sshRemoteId?: string
    ): Promise<{ success: boolean; error?: string }> => {
      setIsImporting(true);
      try {
        const result = await window.maestro.marketplace.importPlaybook(
          playbook.id,
          targetFolderName,
          autoRunFolderPath,
          sessionId,
          sshRemoteId
        );
        setIsImporting(false);
        return result;
      } catch (err) {
        console.error('Failed to import playbook:', err);
        setIsImporting(false);
        return { success: false, error: 'Import failed' };
      }
    },
    []
  );

  // Fetch README.md content for a playbook
  const fetchReadme = useCallback(async (playbookPath: string): Promise<string | null> => {
    try {
      const result = await window.maestro.marketplace.getReadme(playbookPath);
      if (result.success) {
        // content can be null if README doesn't exist, or undefined
        return result.content ?? null;
      }
      return null;
    } catch (err) {
      console.error('Failed to fetch README:', err);
      return null;
    }
  }, []);

  // Fetch a specific document's content
  const fetchDocument = useCallback(
    async (playbookPath: string, filename: string): Promise<string | null> => {
      try {
        const result = await window.maestro.marketplace.getDocument(playbookPath, filename);
        if (result.success) {
          return result.content ?? null;
        }
        return null;
      } catch (err) {
        console.error('Failed to fetch document:', err);
        return null;
      }
    },
    []
  );

  return {
    // Data
    manifest,
    playbooks,
    categories,

    // Loading states
    isLoading,
    isRefreshing,
    isImporting,

    // Cache info
    fromCache,
    cacheAge,

    // Error state
    error,

    // Filter state
    selectedCategory,
    searchQuery,
    filteredPlaybooks,

    // Actions
    setSelectedCategory,
    setSearchQuery,
    refresh,
    importPlaybook,

    // Document preview
    fetchReadme,
    fetchDocument,
  };
}
