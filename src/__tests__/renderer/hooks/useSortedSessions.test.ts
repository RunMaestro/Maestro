import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Group, Session } from '../../../renderer/types';
import {
	compareNamesIgnoringEmojis,
	stripLeadingEmojis,
	useSortedSessions,
} from '../../../renderer/hooks/session/useSortedSessions';

function makeSession(overrides: Partial<Session> & { id: string; name: string }): Session {
	return {
		id: overrides.id,
		name: overrides.name,
		groupId: overrides.groupId,
		bookmarked: overrides.bookmarked,
		parentSessionId: overrides.parentSessionId,
		worktreesExpanded: overrides.worktreesExpanded,
	} as Session;
}

function makeGroup(overrides: Partial<Group> & { id: string; name: string }): Group {
	return {
		id: overrides.id,
		name: overrides.name,
		emoji: overrides.emoji ?? '',
		collapsed: overrides.collapsed ?? false,
	};
}

function ids(sessions: Session[]) {
	return sessions.map((session) => session.id);
}

describe('useSortedSessions', () => {
	it('re-exports emoji-aware name helpers used for sorting', () => {
		expect(stripLeadingEmojis('🚀 Alpha')).toBe('Alpha');
		expect(compareNamesIgnoringEmojis('🚀 Alpha', 'Beta')).toBeLessThan(0);
	});

	it('sorts grouped sessions by group name before ungrouped sessions while ignoring leading emojis', () => {
		const backend = makeGroup({ id: 'backend', name: '🧠 Backend' });
		const frontend = makeGroup({ id: 'frontend', name: '🎨 Frontend' });
		const sessions = [
			makeSession({ id: 'z-api', name: '🧪 Z API', groupId: 'backend' }),
			makeSession({ id: 'a-api', name: 'Alpha API', groupId: 'backend' }),
			makeSession({ id: 'z-ui', name: 'Zulu UI', groupId: 'frontend' }),
			makeSession({ id: 'a-ui', name: '🚀 Alpha UI', groupId: 'frontend' }),
			makeSession({ id: 'ungrouped-z', name: 'Zulu Ungrouped' }),
			makeSession({ id: 'ungrouped-a', name: '✨ Alpha Ungrouped' }),
		];

		const { result } = renderHook(() =>
			useSortedSessions({
				sessions,
				groups: [frontend, backend],
				bookmarksCollapsed: true,
			})
		);

		expect(ids(result.current.sortedSessions)).toEqual([
			'a-api',
			'z-api',
			'a-ui',
			'z-ui',
			'ungrouped-a',
			'ungrouped-z',
		]);
	});

	it('nests sorted worktree children after expanded parents and hides children for collapsed parents', () => {
		const sessions = [
			makeSession({ id: 'parent-open', name: 'Open Parent' }),
			makeSession({ id: 'child-z', name: 'Zulu Child', parentSessionId: 'parent-open' }),
			makeSession({ id: 'child-a', name: 'Alpha Child', parentSessionId: 'parent-open' }),
			makeSession({
				id: 'parent-closed',
				name: 'Closed Parent',
				worktreesExpanded: false,
			}),
			makeSession({
				id: 'hidden-child',
				name: 'Hidden Child',
				parentSessionId: 'parent-closed',
			}),
		];

		const { result } = renderHook(() =>
			useSortedSessions({
				sessions,
				groups: [],
				bookmarksCollapsed: true,
			})
		);

		expect(ids(result.current.sortedSessions)).toEqual([
			'parent-closed',
			'parent-open',
			'child-a',
			'child-z',
		]);
	});

	it('places expanded bookmarks first in visible sessions and allows bookmarked duplicates', () => {
		const group = makeGroup({ id: 'group', name: 'Group' });
		const bookmarkedGrouped = makeSession({
			id: 'bookmarked-grouped',
			name: 'Bravo',
			groupId: 'group',
			bookmarked: true,
		});
		const bookmarkedUngrouped = makeSession({
			id: 'bookmarked-ungrouped',
			name: 'Alpha',
			bookmarked: true,
		});
		const child = makeSession({
			id: 'child',
			name: 'Child',
			bookmarked: true,
			parentSessionId: 'bookmarked-ungrouped',
		});

		const { result } = renderHook(() =>
			useSortedSessions({
				sessions: [bookmarkedGrouped, bookmarkedUngrouped, child],
				groups: [group],
				bookmarksCollapsed: false,
			})
		);

		expect(ids(result.current.visibleSessions)).toEqual([
			'bookmarked-ungrouped',
			'bookmarked-grouped',
			'bookmarked-grouped',
			'bookmarked-ungrouped',
		]);
		expect(ids(result.current.visibleSessions)).not.toContain('child');
	});

	it('omits the bookmark section when collapsed while preserving expanded group and ungrouped visibility', () => {
		const expanded = makeGroup({ id: 'expanded', name: 'Expanded' });
		const collapsed = makeGroup({ id: 'collapsed', name: 'Collapsed', collapsed: true });
		const sessions = [
			makeSession({ id: 'bookmarked', name: 'Bookmarked', bookmarked: true }),
			makeSession({ id: 'expanded-session', name: 'Expanded', groupId: 'expanded' }),
			makeSession({ id: 'collapsed-session', name: 'Collapsed', groupId: 'collapsed' }),
			makeSession({ id: 'missing-group', name: 'Missing', groupId: 'missing' }),
			makeSession({ id: 'ungrouped', name: 'Ungrouped' }),
			makeSession({ id: 'child', name: 'Child', parentSessionId: 'ungrouped' }),
		];

		const { result } = renderHook(() =>
			useSortedSessions({
				sessions,
				groups: [collapsed, expanded],
				bookmarksCollapsed: true,
			})
		);

		expect(ids(result.current.visibleSessions)).toEqual([
			'expanded-session',
			'bookmarked',
			'ungrouped',
		]);
		expect(ids(result.current.visibleSessions)).not.toContain('collapsed-session');
		expect(ids(result.current.visibleSessions)).not.toContain('missing-group');
		expect(ids(result.current.visibleSessions)).not.toContain('child');
	});

	it('returns empty sorted and visible lists for empty inputs', () => {
		const { result } = renderHook(() =>
			useSortedSessions({
				sessions: [],
				groups: [],
				bookmarksCollapsed: false,
			})
		);

		expect(result.current.sortedSessions).toEqual([]);
		expect(result.current.visibleSessions).toEqual([]);
	});
});
