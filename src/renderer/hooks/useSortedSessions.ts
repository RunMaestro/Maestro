import { useMemo } from 'react';
import type { Session, Group } from '../types';
import {
  stripLeadingEmojis,
  compareNamesIgnoringEmojis,
} from '../../shared/emojiUtils';

// Re-export for backwards compatibility with existing imports
export { stripLeadingEmojis, compareNamesIgnoringEmojis };

/**
 * Dependencies for the useSortedSessions hook.
 */
export interface UseSortedSessionsDeps {
  /** All sessions */
  sessions: Session[];
  /** All groups */
  groups: Group[];
  /** Whether the bookmarks folder is collapsed */
  bookmarksCollapsed: boolean;
}

/**
 * Return type for useSortedSessions hook.
 */
export interface UseSortedSessionsReturn {
  /** All sessions sorted by group then alphabetically (ignoring leading emojis) */
  sortedSessions: Session[];
  /**
   * Sessions visible for jump shortcuts (Opt+Cmd+NUMBER).
   * Order: Bookmarked sessions first (if bookmarks expanded), then expanded groups/ungrouped.
   * Note: A session may appear twice if bookmarked and in an expanded group.
   */
  visibleSessions: Session[];
}

/**
 * Hook for computing sorted and visible session lists.
 *
 * This hook handles:
 * 1. sortedSessions - All sessions sorted by group membership, then alphabetically
 *    (ignoring leading emojis for proper alphabetization)
 * 2. visibleSessions - Sessions visible for keyboard shortcuts (Opt+Cmd+NUMBER),
 *    respecting bookmarks folder state and group collapse states
 *
 * @param deps - Hook dependencies containing sessions, groups, and collapse state
 * @returns Sorted and visible session arrays
 */
export function useSortedSessions(deps: UseSortedSessionsDeps): UseSortedSessionsReturn {
  const { sessions, groups, bookmarksCollapsed } = deps;

  // Memoize worktree children lookup for O(1) access instead of O(n) per parent
  // This reduces complexity from O(n²) to O(n) when building sorted sessions
  const worktreeChildrenByParent = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const s of sessions) {
      if (s.parentSessionId) {
        const existing = map.get(s.parentSessionId);
        if (existing) {
          existing.push(s);
        } else {
          map.set(s.parentSessionId, [s]);
        }
      }
    }
    // Sort each group once
    for (const [, children] of map) {
      children.sort((a, b) => compareNamesIgnoringEmojis(a.worktreeBranch || a.name, b.worktreeBranch || b.name));
    }
    return map;
  }, [sessions]);

  // Create sorted sessions array that matches visual display order (includes ALL sessions)
  // Note: sorting ignores leading emojis for proper alphabetization
  // Worktree children are inserted after their parent when the parent's worktrees are expanded
  const sortedSessions = useMemo(() => {
    const sorted: Session[] = [];

    // Helper to add session with its worktree children - now O(1) lookup
    const addSessionWithWorktrees = (session: Session) => {
      // Skip worktree children - they're added with their parent
      if (session.parentSessionId) return;

      sorted.push(session);

      // Add worktree children if expanded
      if (session.worktreesExpanded !== false) {
        const children = worktreeChildrenByParent.get(session.id);
        if (children) {
          sorted.push(...children);
        }
      }
    };

    // First, add sessions from sorted groups (ignoring leading emojis)
    const sortedGroups = [...groups].sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
    sortedGroups.forEach(group => {
      const groupSessions = sessions
        .filter(s => s.groupId === group.id && !s.parentSessionId)
        .sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
      groupSessions.forEach(addSessionWithWorktrees);
    });

    // Then, add ungrouped sessions (sorted alphabetically, ignoring leading emojis)
    const ungroupedSessions = sessions
      .filter(s => !s.groupId && !s.parentSessionId)
      .sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
    ungroupedSessions.forEach(addSessionWithWorktrees);

    return sorted;
  }, [sessions, groups, worktreeChildrenByParent]);

  // Create a Map for O(1) group lookup instead of O(n) find() calls
  const groupsById = useMemo(() => {
    const map = new Map<string, Group>();
    for (const g of groups) {
      map.set(g.id, g);
    }
    return map;
  }, [groups]);

  // Create visible sessions array for session jump shortcuts (Opt+Cmd+NUMBER)
  // Order: Bookmarked sessions first (if bookmarks folder expanded), then groups/ungrouped
  // Note: A session can appear twice if it's both bookmarked and in an expanded group
  // Note: Worktree children are excluded - they don't display jump numbers and shouldn't consume slots
  const visibleSessions = useMemo(() => {
    const result: Session[] = [];

    // Add bookmarked sessions first (if bookmarks folder is expanded)
    // Exclude worktree children (they don't show jump numbers)
    if (!bookmarksCollapsed) {
      const bookmarkedSessions = sessions
        .filter(s => s.bookmarked && !s.parentSessionId)
        .sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name));
      result.push(...bookmarkedSessions);
    }

    // Add sessions from expanded groups and ungrouped sessions
    // Exclude worktree children (they don't show jump numbers)
    // Use Map for O(1) group lookup instead of O(n) find()
    const groupAndUngrouped = sortedSessions.filter(session => {
      // Exclude worktree children - they're nested under parent and don't show jump badges
      if (session.parentSessionId) return false;
      if (!session.groupId) return true; // Ungrouped sessions always visible
      const group = groupsById.get(session.groupId);
      return group && !group.collapsed; // Only show if group is expanded
    });
    result.push(...groupAndUngrouped);

    return result;
  }, [sortedSessions, groupsById, sessions, bookmarksCollapsed]);

  return {
    sortedSessions,
    visibleSessions,
  };
}
