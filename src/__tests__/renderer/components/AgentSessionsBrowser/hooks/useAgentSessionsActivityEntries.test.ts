import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentSessionsActivityEntries } from '../../../../../renderer/components/AgentSessionsBrowser/hooks/useAgentSessionsActivityEntries';
import type { AgentSession } from '../../../../../renderer/hooks/agent/useSessionViewer';

function makeSession(sessionId: string, modifiedAt: string): AgentSession {
	return {
		sessionId,
		projectPath: '/p',
		timestamp: modifiedAt,
		modifiedAt,
		firstMessage: '',
		messageCount: 0,
		sizeBytes: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		durationSeconds: 0,
	};
}

const sessions = [
	makeSession('s1', '2024-01-01T00:00:00Z'),
	makeSession('s2', '2024-01-02T00:00:00Z'),
];

describe('useAgentSessionsActivityEntries', () => {
	it('returns empty activityEntries initially', () => {
		const { result } = renderHook(() =>
			useAgentSessionsActivityEntries({
				namedOnly: false,
				showAllSessions: false,
				showSearchPanel: true,
				filteredSessions: sessions,
			})
		);
		expect(result.current.activityEntries).toEqual([]);
	});

	it('updates entries when switching TO graph view', () => {
		const { result, rerender } = renderHook((args) => useAgentSessionsActivityEntries(args), {
			initialProps: {
				namedOnly: false,
				showAllSessions: false,
				showSearchPanel: true,
				filteredSessions: sessions,
			},
		});

		act(() => {
			rerender({
				namedOnly: false,
				showAllSessions: false,
				showSearchPanel: false,
				filteredSessions: sessions,
			});
		});

		expect(result.current.activityEntries).toHaveLength(2);
	});

	it('does NOT update entries when switching FROM graph to search', () => {
		const { result, rerender } = renderHook((args) => useAgentSessionsActivityEntries(args), {
			initialProps: {
				namedOnly: false,
				showAllSessions: false,
				showSearchPanel: false,
				filteredSessions: sessions,
			},
		});

		// Populate entries
		expect(result.current.activityEntries.length).toBeGreaterThan(0);
		const entriesBefore = result.current.activityEntries;

		act(() => {
			rerender({
				namedOnly: false,
				showAllSessions: false,
				showSearchPanel: true,
				filteredSessions: sessions,
			});
		});

		// Entries should NOT change (we went from graph to search)
		expect(result.current.activityEntries).toBe(entriesBefore);
	});

	it('updates entries when namedOnly changes while graph is visible', () => {
		const { result, rerender } = renderHook((args) => useAgentSessionsActivityEntries(args), {
			initialProps: {
				namedOnly: false,
				showAllSessions: false,
				showSearchPanel: false,
				filteredSessions: sessions,
			},
		});

		const newSessions = [makeSession('s3', '2024-01-03T00:00:00Z')];
		act(() => {
			rerender({
				namedOnly: true,
				showAllSessions: false,
				showSearchPanel: false,
				filteredSessions: newSessions,
			});
		});

		expect(result.current.activityEntries).toHaveLength(1);
		expect(result.current.activityEntries[0].timestamp).toBe('2024-01-03T00:00:00Z');
	});

	it('updates entries when showAllSessions changes while graph is visible', () => {
		const { result, rerender } = renderHook((args) => useAgentSessionsActivityEntries(args), {
			initialProps: {
				namedOnly: false,
				showAllSessions: false,
				showSearchPanel: false,
				filteredSessions: sessions,
			},
		});

		const newSessions = sessions.concat(makeSession('s3', '2024-01-03T00:00:00Z'));
		act(() => {
			rerender({
				namedOnly: false,
				showAllSessions: true,
				showSearchPanel: false,
				filteredSessions: newSessions,
			});
		});

		expect(result.current.activityEntries).toHaveLength(3);
	});

	it('does NOT update when filteredSessions changes alone while in search view', () => {
		const { result, rerender } = renderHook((args) => useAgentSessionsActivityEntries(args), {
			initialProps: {
				namedOnly: false,
				showAllSessions: false,
				showSearchPanel: true,
				filteredSessions: sessions,
			},
		});

		const before = result.current.activityEntries;
		act(() => {
			rerender({
				namedOnly: false,
				showAllSessions: false,
				showSearchPanel: true,
				filteredSessions: [makeSession('s3', '2024-01-03T00:00:00Z')],
			});
		});

		expect(result.current.activityEntries).toBe(before);
	});

	it('entry shape is { timestamp: modifiedAt }', () => {
		const { result, rerender } = renderHook((args) => useAgentSessionsActivityEntries(args), {
			initialProps: {
				namedOnly: false,
				showAllSessions: false,
				showSearchPanel: true,
				filteredSessions: sessions,
			},
		});

		act(() => {
			rerender({
				namedOnly: false,
				showAllSessions: false,
				showSearchPanel: false,
				filteredSessions: sessions,
			});
		});

		expect(result.current.activityEntries[0]).toEqual({ timestamp: '2024-01-01T00:00:00Z' });
		expect(result.current.activityEntries[1]).toEqual({ timestamp: '2024-01-02T00:00:00Z' });
	});

	it('handles filteredSessions transition from empty to non-empty while graph visible', () => {
		const { result, rerender } = renderHook((args) => useAgentSessionsActivityEntries(args), {
			initialProps: {
				namedOnly: false,
				showAllSessions: false,
				showSearchPanel: false,
				filteredSessions: [],
			},
		});

		// Initially no entries (empty sessions)
		expect(result.current.activityEntries).toHaveLength(0);

		act(() => {
			rerender({
				namedOnly: false,
				showAllSessions: false,
				showSearchPanel: false,
				filteredSessions: sessions,
			});
		});

		// Should NOT auto-update because filteredSessions changed alone (no filter/view toggle)
		// BUT it IS the initial load case: graph visible + entries empty + sessions non-empty
		// The hook only fires initial-load when switching states - so this depends on whether
		// prevFiltersRef changes triggered a re-check
		// Let's verify the entries DID update (initial load path)
		expect(result.current.activityEntries).toHaveLength(2);
	});
});
