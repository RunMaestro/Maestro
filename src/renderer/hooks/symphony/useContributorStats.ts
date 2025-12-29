/**
 * useContributorStats Hook
 *
 * Provides contributor statistics for achievements and the Stats tab.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import type {
  ContributorStats,
  CompletedContribution,
} from '../../../shared/symphony-types';

// ============================================================================
// Types
// ============================================================================

export interface Achievement {
  id: string;
  title: string;
  description: string;
  icon: string;
  earned: boolean;
  earnedAt?: string;
  progress?: number;  // 0-100
}

export interface UseContributorStatsReturn {
  stats: ContributorStats | null;
  recentContributions: CompletedContribution[];
  achievements: Achievement[];
  isLoading: boolean;
  refresh: () => Promise<void>;

  // Formatted stats for display
  formattedTotalCost: string;
  formattedTotalTokens: string;
  formattedTotalTime: string;
  uniqueRepos: number;
  currentStreakDays: number;
  longestStreakDays: number;
}

// ============================================================================
// Achievement Definitions
// ============================================================================

interface AchievementDefinition {
  id: string;
  title: string;
  description: string;
  icon: string;
  check: (stats: ContributorStats) => boolean;
  progress: (stats: ContributorStats) => number;
}

const ACHIEVEMENT_DEFINITIONS: AchievementDefinition[] = [
  {
    id: 'first-contribution',
    title: 'First Steps',
    description: 'Complete your first Symphony contribution',
    icon: '🎵',
    check: (stats: ContributorStats) => stats.totalContributions >= 1,
    progress: (stats: ContributorStats) => Math.min(100, stats.totalContributions * 100),
  },
  {
    id: 'ten-contributions',
    title: 'Harmony Seeker',
    description: 'Complete 10 contributions',
    icon: '🎶',
    check: (stats: ContributorStats) => stats.totalContributions >= 10,
    progress: (stats: ContributorStats) => Math.min(100, (stats.totalContributions / 10) * 100),
  },
  {
    id: 'first-merge',
    title: 'Merged Melody',
    description: 'Have a contribution merged',
    icon: '🎼',
    check: (stats: ContributorStats) => stats.totalMerged >= 1,
    progress: (stats: ContributorStats) => Math.min(100, stats.totalMerged * 100),
  },
  {
    id: 'multi-repo',
    title: 'Ensemble Player',
    description: 'Contribute to 5 different repositories',
    icon: '🎻',
    check: (stats: ContributorStats) => stats.repositoriesContributed.length >= 5,
    progress: (stats: ContributorStats) => Math.min(100, (stats.repositoriesContributed.length / 5) * 100),
  },
  {
    id: 'streak-week',
    title: 'Weekly Rhythm',
    description: 'Maintain a 7-day contribution streak',
    icon: '🔥',
    check: (stats: ContributorStats) => stats.longestStreak >= 7,
    progress: (stats: ContributorStats) => Math.min(100, (stats.longestStreak / 7) * 100),
  },
  {
    id: 'token-millionaire',
    title: 'Token Millionaire',
    description: 'Donate over 1 million tokens',
    icon: '💎',
    check: (stats: ContributorStats) => stats.totalTokensUsed >= 1_000_000,
    progress: (stats: ContributorStats) => Math.min(100, (stats.totalTokensUsed / 1_000_000) * 100),
  },
  {
    id: 'hundred-tasks',
    title: 'Virtuoso',
    description: 'Complete 100 tasks across all contributions',
    icon: '🏆',
    check: (stats: ContributorStats) => stats.totalTasksCompleted >= 100,
    progress: (stats: ContributorStats) => Math.min(100, stats.totalTasksCompleted),
  },
  {
    id: 'early-adopter',
    title: 'Early Adopter',
    description: 'Join Symphony in its first month',
    icon: '⭐',
    check: (stats: ContributorStats) => {
      if (!stats.firstContributionAt) return false;
      const firstDate = new Date(stats.firstContributionAt);
      const symphonyLaunch = new Date('2025-01-01'); // Placeholder
      const oneMonthLater = new Date(symphonyLaunch);
      oneMonthLater.setMonth(oneMonthLater.getMonth() + 1);
      return firstDate <= oneMonthLater;
    },
    progress: () => 100, // Either earned or not
  },
];

// ============================================================================
// Helper Functions
// ============================================================================

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K`;
  }
  return count.toString();
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useContributorStats(): UseContributorStatsReturn {
  const [stats, setStats] = useState<ContributorStats | null>(null);
  const [recentContributions, setRecentContributions] = useState<CompletedContribution[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    setIsLoading(true);
    try {
      const [statsResponse, completedResponse] = await Promise.all([
        window.maestro.symphony.getStats(),
        window.maestro.symphony.getCompleted(10), // Last 10 contributions
      ]);

      if (statsResponse.stats) {
        setStats(statsResponse.stats as ContributorStats);
      }
      if (completedResponse.contributions) {
        setRecentContributions(completedResponse.contributions as CompletedContribution[]);
      }
    } catch (err) {
      console.error('Failed to fetch contributor stats:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  // Compute achievements
  const achievements = useMemo((): Achievement[] => {
    if (!stats) return ACHIEVEMENT_DEFINITIONS.map(def => ({
      id: def.id,
      title: def.title,
      description: def.description,
      icon: def.icon,
      earned: false,
      progress: 0,
    }));

    return ACHIEVEMENT_DEFINITIONS.map(def => ({
      id: def.id,
      title: def.title,
      description: def.description,
      icon: def.icon,
      earned: def.check(stats),
      progress: def.progress(stats),
    }));
  }, [stats]);

  // Formatted values
  const formattedTotalCost = useMemo(() => {
    return formatCost(stats?.estimatedCostDonated ?? 0);
  }, [stats]);

  const formattedTotalTokens = useMemo(() => {
    return formatTokenCount(stats?.totalTokensUsed ?? 0);
  }, [stats]);

  const formattedTotalTime = useMemo(() => {
    return formatDuration(stats?.totalTimeSpent ?? 0);
  }, [stats]);

  const uniqueRepos = useMemo(() => {
    return stats?.repositoriesContributed.length ?? 0;
  }, [stats]);

  const currentStreakDays = stats?.currentStreak ?? 0;
  const longestStreakDays = stats?.longestStreak ?? 0;

  return {
    stats,
    recentContributions,
    achievements,
    isLoading,
    refresh: fetchStats,
    formattedTotalCost,
    formattedTotalTokens,
    formattedTotalTime,
    uniqueRepos,
    currentStreakDays,
    longestStreakDays,
  };
}
