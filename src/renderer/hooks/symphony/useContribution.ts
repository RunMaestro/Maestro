/**
 * useContribution Hook
 *
 * Manages the state and actions for a single active contribution.
 * Used by the contribution runner component.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  ActiveContribution,
  ContributionStatus,
} from '../../../shared/symphony-types';

// ============================================================================
// Types
// ============================================================================

export interface UseContributionReturn {
  // Contribution data
  contribution: ActiveContribution | null;

  // Status
  isLoading: boolean;
  error: string | null;

  // Progress tracking
  currentDocumentIndex: number;
  totalDocuments: number;
  currentDocument: string | null;
  elapsedTime: number;

  // Actions
  updateProgress: (progress: Partial<ActiveContribution['progress']>) => Promise<void>;
  updateTokenUsage: (usage: Partial<ActiveContribution['tokenUsage']>) => Promise<void>;
  setStatus: (status: ContributionStatus) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  cancel: (cleanup?: boolean) => Promise<{ success: boolean }>;
  finalize: () => Promise<{ success: boolean; prUrl?: string; error?: string }>;
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useContribution(contributionId: string | null): UseContributionReturn {
  const [contribution, setContribution] = useState<ActiveContribution | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0);

  // Track if component is mounted
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Fetch contribution data
  const fetchContribution = useCallback(async () => {
    if (!contributionId) {
      setContribution(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await window.maestro.symphony.getActive();
      const contributions = response.contributions ?? [];
      const found = contributions.find(c => c.id === contributionId);

      if (!isMountedRef.current) return;

      if (!found) {
        setError('Contribution not found');
        setContribution(null);
      } else {
        setContribution(found as ActiveContribution);
      }
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to fetch contribution');
      }
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [contributionId]);

  useEffect(() => {
    fetchContribution();
  }, [fetchContribution]);

  // Poll for updates while contribution is active
  useEffect(() => {
    if (!contributionId || !contribution) return;
    if (['ready_for_review', 'failed', 'cancelled'].includes(contribution.status)) return;

    const interval = setInterval(fetchContribution, 2000);
    return () => clearInterval(interval);
  }, [contributionId, contribution?.status, fetchContribution]);

  // Track elapsed time
  useEffect(() => {
    if (!contribution || contribution.status !== 'running') {
      return;
    }

    const startTime = new Date(contribution.startedAt).getTime();
    const updateElapsed = () => {
      setElapsedTime(Date.now() - startTime);
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);
    return () => clearInterval(interval);
  }, [contribution?.startedAt, contribution?.status]);

  // Computed values
  const currentDocumentIndex = contribution?.progress.completedDocuments ?? 0;
  const totalDocuments = contribution?.progress.totalDocuments ?? 0;
  const currentDocument = contribution?.progress.currentDocument ?? null;

  // ─────────────────────────────────────────────────────────────────────────
  // Actions
  // ─────────────────────────────────────────────────────────────────────────

  const updateProgress = useCallback(async (progress: Partial<ActiveContribution['progress']>) => {
    if (!contributionId) return;

    await window.maestro.symphony.updateStatus({
      contributionId,
      progress: {
        totalDocuments: progress.totalDocuments ?? contribution?.progress.totalDocuments ?? 0,
        completedDocuments: progress.completedDocuments ?? contribution?.progress.completedDocuments ?? 0,
        totalTasks: progress.totalTasks ?? contribution?.progress.totalTasks ?? 0,
        completedTasks: progress.completedTasks ?? contribution?.progress.completedTasks ?? 0,
        currentDocument: progress.currentDocument,
      },
    });

    await fetchContribution();
  }, [contributionId, contribution, fetchContribution]);

  const updateTokenUsage = useCallback(async (usage: Partial<ActiveContribution['tokenUsage']>) => {
    if (!contributionId) return;

    await window.maestro.symphony.updateStatus({
      contributionId,
      tokenUsage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimatedCost: usage.estimatedCost,
      },
    });

    await fetchContribution();
  }, [contributionId, fetchContribution]);

  const setStatus = useCallback(async (status: ContributionStatus) => {
    if (!contributionId) return;

    await window.maestro.symphony.updateStatus({
      contributionId,
      status,
    });

    await fetchContribution();
  }, [contributionId, fetchContribution]);

  const pause = useCallback(async () => {
    await setStatus('paused');
  }, [setStatus]);

  const resume = useCallback(async () => {
    await setStatus('running');
  }, [setStatus]);

  const cancel = useCallback(async (cleanup: boolean = true) => {
    if (!contributionId) return { success: false };
    const result = await window.maestro.symphony.cancel(contributionId, cleanup);
    return { success: result.cancelled ?? false };
  }, [contributionId]);

  const finalize = useCallback(async (): Promise<{ success: boolean; prUrl?: string; error?: string }> => {
    if (!contributionId || !contribution) {
      return { success: false, error: 'No active contribution' };
    }

    const result = await window.maestro.symphony.complete({
      contributionId,
    });

    if (result.prUrl) {
      return { success: true, prUrl: result.prUrl };
    }

    return { success: false, error: result.error ?? 'Unknown error' };
  }, [contributionId, contribution]);

  // ─────────────────────────────────────────────────────────────────────────
  // Return
  // ─────────────────────────────────────────────────────────────────────────

  return {
    contribution,
    isLoading,
    error,
    currentDocumentIndex,
    totalDocuments,
    currentDocument,
    elapsedTime,
    updateProgress,
    updateTokenUsage,
    setStatus,
    pause,
    resume,
    cancel,
    finalize,
  };
}
