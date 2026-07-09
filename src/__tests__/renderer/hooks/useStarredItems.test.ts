/**
 * Tests for useStarredItems hook - the single owner of the Left Bar "Starred
 * Sessions" list (consumed by both the SessionList render and Cmd+[ / Cmd+]
 * cycling). The cycling/keyboard tests treat starredItems as fixtures; these
 * tests exercise how that list is actually built.
 *
 * Tests:
 *   - Open starred AI tabs become rows
 *   - Closed/named starred sessions matched to a loaded parent agent become rows
 *   - Closed-twin suppression: a closed row is dropped when its conversation is
 *     already open as a tab (regression - duplicate row on aged-out star restore)
 *   - Project-path normalization when matching a closed session to its parent
 *   - Rows are sorted by display name; section disabled yields an empty list
 *   - activateStarredItem focuses an open tab, and offers to remove an aged-out star
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';

import { useStarredItems } from '../../../renderer/hooks/session/useStarredItems';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import type { Session } from '../../../renderer/types';

// ============================================================================
// Helpers
// ============================================================================

/** Build a minimal Session. Only the fields useStarredItems reads are set. */
const makeSession = (overrides: Partial<Session> = {}): Session =>
	({
		id: 'session-1',
		name: 'Agent',
		toolType: 'claude-code',
		projectRoot: '/proj',
		aiTabs: [],
		...overrides,
	}) as Session;

/** A named-session record as returned by agentSessions.getAllNamedSessions. */
const makeNamed = (overrides: Record<string, unknown> = {}) => ({
	agentId: 'claude-code',
	agentSessionId: 'asid-closed',
	projectPath: '/proj',
	sessionName: 'Closed One',
	starred: true,
	lastActivityAt: 1,
	...overrides,
});

const mockNamedSessions = (rows: Array<Record<string, unknown>>) => {
	vi.mocked(window.maestro.agentSessions.getAllNamedSessions).mockResolvedValue(rows as never);
};

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
	vi.clearAllMocks();
	mockNamedSessions([]);
	useSessionStore.setState({ sessions: [], activeSessionId: null } as never);
	useSettingsStore.setState({ showStarredSessionsSection: true } as never);
	useGroupChatStore.setState({ activeGroupChatId: null } as never);
});

afterEach(() => {
	cleanup();
});

// ============================================================================
// Tests
// ============================================================================

describe('useStarredItems', () => {
	it('returns an empty list when the Starred Sessions section is disabled', async () => {
		useSettingsStore.setState({ showStarredSessionsSection: false } as never);
		mockNamedSessions([makeNamed()]);
		useSessionStore.setState({
			sessions: [
				makeSession({
					aiTabs: [
						{ id: 't1', starred: true, agentSessionId: 'asid-open', name: 'Star Tab' },
					] as never,
				}),
			],
		} as never);

		const { result } = renderHook(() => useStarredItems({}));

		// Disabled section never loads disk sessions and never emits open rows.
		expect(result.current.starredItems).toEqual([]);
		expect(window.maestro.agentSessions.getAllNamedSessions).not.toHaveBeenCalled();
	});

	it('emits a row for each open starred AI tab', () => {
		useSessionStore.setState({
			sessions: [
				makeSession({
					id: 's1',
					name: 'Alpha',
					aiTabs: [
						{ id: 't1', starred: true, agentSessionId: 'asid-1', name: 'Tab One' },
						{ id: 't2', starred: false, agentSessionId: 'asid-2', name: 'Not Starred' },
					] as never,
				}),
			],
		} as never);

		const { result } = renderHook(() => useStarredItems({}));

		expect(result.current.starredItems).toHaveLength(1);
		expect(result.current.starredItems[0]).toMatchObject({
			kind: 'open',
			displayName: 'Tab One',
			parentSessionId: 's1',
			tabId: 't1',
		});
	});

	it('emits a closed row for a starred named session matched to a loaded parent agent', async () => {
		mockNamedSessions([makeNamed({ agentSessionId: 'asid-closed', sessionName: 'Resumable' })]);
		useSessionStore.setState({
			sessions: [makeSession({ id: 's1', name: 'Alpha', projectRoot: '/proj' })],
		} as never);

		const { result } = renderHook(() => useStarredItems({}));

		await waitFor(() => expect(result.current.starredItems).toHaveLength(1));
		expect(result.current.starredItems[0]).toMatchObject({
			kind: 'closed',
			displayName: 'Resumable',
			parentSessionId: 's1',
			agentSessionId: 'asid-closed',
		});
	});

	it('drops a closed named session that is already open as a tab (closed-twin suppression)', async () => {
		// Regression: restoring an aged-out star left the session rendered twice -
		// once as the now-open tab and once as its lingering closed twin. The hook
		// suppresses the closed row whenever an open tab shares its agentSessionId,
		// regardless of that tab's own star state.
		mockNamedSessions([makeNamed({ agentSessionId: 'shared-asid', sessionName: 'Twin' })]);
		useSessionStore.setState({
			sessions: [
				makeSession({
					id: 's1',
					name: 'Alpha',
					projectRoot: '/proj',
					// Open tab is NOT starred, but shares the closed session's id.
					aiTabs: [{ id: 't1', starred: false, agentSessionId: 'shared-asid' }] as never,
				}),
			],
		} as never);

		const { result } = renderHook(() => useStarredItems({}));

		// Let the async disk load resolve, then assert the closed twin never appears.
		await act(async () => {
			await Promise.resolve();
		});
		expect(result.current.starredItems.some((i) => i.kind === 'closed')).toBe(false);
	});

	it('matches a closed session to its parent ignoring trailing-slash differences', async () => {
		mockNamedSessions([makeNamed({ projectPath: '/proj/', agentSessionId: 'asid-closed' })]);
		useSessionStore.setState({
			sessions: [makeSession({ id: 's1', projectRoot: '/proj' })],
		} as never);

		const { result } = renderHook(() => useStarredItems({}));

		await waitFor(() => expect(result.current.starredItems).toHaveLength(1));
		expect(result.current.starredItems[0]).toMatchObject({ kind: 'closed', parentSessionId: 's1' });
	});

	it('omits a closed session whose owning agent is not loaded', async () => {
		mockNamedSessions([makeNamed({ projectPath: '/other-proj' })]);
		useSessionStore.setState({
			sessions: [makeSession({ id: 's1', projectRoot: '/proj' })],
		} as never);

		const { result } = renderHook(() => useStarredItems({}));

		await act(async () => {
			await Promise.resolve();
		});
		expect(result.current.starredItems).toEqual([]);
	});

	it('sorts rows alphabetically by display name', async () => {
		mockNamedSessions([makeNamed({ agentSessionId: 'asid-closed', sessionName: 'Beta' })]);
		useSessionStore.setState({
			sessions: [
				makeSession({
					id: 's1',
					name: 'Alpha',
					projectRoot: '/proj',
					aiTabs: [{ id: 't1', starred: true, agentSessionId: 'asid-open', name: 'Zulu' }] as never,
				}),
			],
		} as never);

		const { result } = renderHook(() => useStarredItems({}));

		await waitFor(() => expect(result.current.starredItems).toHaveLength(2));
		expect(result.current.starredItems.map((i) => i.displayName)).toEqual(['Beta', 'Zulu']);
	});

	it('activateStarredItem focuses the tab of an open row', async () => {
		useSessionStore.setState({
			sessions: [
				makeSession({
					id: 's1',
					aiTabs: [{ id: 't1', starred: true, agentSessionId: 'asid-1', name: 'Tab One' }] as never,
				}),
			],
		} as never);

		const { result } = renderHook(() => useStarredItems({}));
		const row = result.current.starredItems[0];

		await act(async () => {
			await result.current.activateStarredItem(row);
		});

		const session = useSessionStore.getState().sessions.find((s) => s.id === 's1');
		expect(useSessionStore.getState().activeSessionId).toBe('s1');
		expect(session?.activeTabId).toBe('t1');
		expect(session?.inputMode).toBe('ai');
	});

	it('dismisses an active group chat when activating a starred item (regression #1175)', async () => {
		// Bug: clicking a Starred Session while a group chat was open did nothing.
		// The group chat view is gated on a truthy activeGroupChatId and renders on
		// top of the session view, so activating a starred tab without clearing it
		// left the group chat covering the screen. Activation must clear it.
		useGroupChatStore.setState({ activeGroupChatId: 'gc-1' } as never);
		useSessionStore.setState({
			sessions: [
				makeSession({
					id: 's1',
					aiTabs: [{ id: 't1', starred: true, agentSessionId: 'asid-1', name: 'Tab One' }] as never,
				}),
			],
		} as never);

		const { result } = renderHook(() => useStarredItems({}));
		const row = result.current.starredItems[0];

		await act(async () => {
			await result.current.activateStarredItem(row);
		});

		expect(useGroupChatStore.getState().activeGroupChatId).toBeNull();
		expect(useSessionStore.getState().activeSessionId).toBe('s1');
	});

	it('offers to remove an aged-out star when the closed session can no longer be resumed', async () => {
		const onJumpToStarredSession = vi.fn().mockResolvedValue(false);
		const showConfirmation = vi.fn();
		mockNamedSessions([makeNamed({ agentSessionId: 'asid-closed', sessionName: 'Gone' })]);
		useSessionStore.setState({
			sessions: [makeSession({ id: 's1', projectRoot: '/proj' })],
		} as never);

		const { result } = renderHook(() =>
			useStarredItems({ onJumpToStarredSession, showConfirmation })
		);
		await waitFor(() => expect(result.current.starredItems).toHaveLength(1));
		const closedRow = result.current.starredItems[0];

		await act(async () => {
			await result.current.activateStarredItem(closedRow);
		});

		expect(onJumpToStarredSession).toHaveBeenCalledWith(
			'claude-code',
			'/proj',
			'asid-closed',
			'Gone',
			's1'
		);
		expect(showConfirmation).toHaveBeenCalledWith(
			expect.stringContaining('no longer available'),
			expect.any(Function)
		);
	});
});
