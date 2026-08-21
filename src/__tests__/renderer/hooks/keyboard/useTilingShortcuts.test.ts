/**
 * @file useTilingShortcuts.test.ts
 * @description Covers the Ctrl+Cmd pane-tiling shortcut family, focusing on the
 * contract that a keyboard pane move carries DOM FOCUS with it: each handler that
 * moves `focusedPaneId` must also publish a `paneFocusRequest` (the destination
 * leaf id) for MainPanelContent to consume. Without it the focus ring moves but
 * the caret stays behind, so typing goes to the previous pane.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useTilingShortcuts } from '../../../../renderer/hooks/keyboard/useTilingShortcuts';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useUIStore } from '../../../../renderer/stores/uiStore';
import { resetStore } from '../../../helpers';
import type { Session } from '../../../../renderer/types';

const GROUP_ID = 'group-1';

/**
 * A two-pane row: leaf-a (AI tab-1) | leaf-b (terminal term-1), leaf-a focused.
 * Mirrors the shape createGroupFromTabRefs produces.
 */
function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Agent',
		aiTabs: [{ id: 'tab-1', name: 'Chat' }],
		activeTabId: 'tab-1',
		terminalTabs: [{ id: 'term-1', name: null }],
		filePreviewTabs: [],
		browserTabs: [],
		unifiedTabOrder: [],
		activeGroupId: GROUP_ID,
		tabGroups: [
			{
				id: GROUP_ID,
				name: 'Group',
				focusedPaneId: 'leaf-a',
				createdAt: 0,
				layout: {
					kind: 'split',
					id: 'split-1',
					direction: 'row',
					sizes: [0.5, 0.5],
					children: [
						{ kind: 'leaf', id: 'leaf-a', tab: { type: 'ai', id: 'tab-1' } },
						{ kind: 'leaf', id: 'leaf-b', tab: { type: 'terminal', id: 'term-1' } },
					],
				},
			},
		],
		...overrides,
	} as unknown as Session;
}

function seed(session: Session) {
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
}

function focusedPaneId(): string | null | undefined {
	return useSessionStore.getState().sessions[0]?.tabGroups?.[0]?.focusedPaneId;
}

describe('useTilingShortcuts', () => {
	beforeEach(() => {
		resetStore(useUIStore);
		useSessionStore.setState({ sessions: [], activeSessionId: '' });
	});

	describe('focusPane (directional)', () => {
		it('moves pane focus and requests DOM focus for the destination', () => {
			seed(makeSession());
			const { result } = renderHook(() => useTilingShortcuts());

			act(() => result.current.focusPane('right'));

			expect(focusedPaneId()).toBe('leaf-b');
			expect(useUIStore.getState().paneFocusRequest).toBe('leaf-b');
		});

		it('does not request focus when there is no neighbor that way', () => {
			seed(makeSession());
			const { result } = renderHook(() => useTilingShortcuts());

			// leaf-a is already the leftmost pane.
			act(() => result.current.focusPane('left'));

			expect(focusedPaneId()).toBe('leaf-a');
			expect(useUIStore.getState().paneFocusRequest).toBeNull();
		});

		it('does not request focus when no group is active', () => {
			seed(makeSession({ activeGroupId: null } as Partial<Session>));
			const { result } = renderHook(() => useTilingShortcuts());

			act(() => result.current.focusPane('right'));

			expect(useUIStore.getState().paneFocusRequest).toBeNull();
		});
	});

	describe('cyclePane', () => {
		it('requests DOM focus for the next pane', () => {
			seed(makeSession());
			const { result } = renderHook(() => useTilingShortcuts());

			act(() => result.current.cyclePane('next'));

			expect(focusedPaneId()).toBe('leaf-b');
			expect(useUIStore.getState().paneFocusRequest).toBe('leaf-b');
		});

		it('requests DOM focus for the wrapped-around pane', () => {
			seed(makeSession());
			const { result } = renderHook(() => useTilingShortcuts());

			// prev from the first pane wraps to the last.
			act(() => result.current.cyclePane('prev'));

			expect(focusedPaneId()).toBe('leaf-b');
			expect(useUIStore.getState().paneFocusRequest).toBe('leaf-b');
		});

		it('does not request focus for a single-pane group (nothing to cycle to)', () => {
			seed(
				makeSession({
					tabGroups: [
						{
							id: GROUP_ID,
							name: 'Group',
							focusedPaneId: 'leaf-a',
							createdAt: 0,
							layout: { kind: 'leaf', id: 'leaf-a', tab: { type: 'ai', id: 'tab-1' } },
						},
					],
				} as unknown as Partial<Session>)
			);
			const { result } = renderHook(() => useTilingShortcuts());

			act(() => result.current.cyclePane('next'));

			expect(useUIStore.getState().paneFocusRequest).toBeNull();
		});
	});

	describe('splitFocusedPane', () => {
		it('requests DOM focus for the freshly inserted pane', () => {
			seed(
				makeSession({
					aiTabs: [
						{ id: 'tab-1', name: 'Chat' },
						{ id: 'tab-2', name: 'Standalone' },
					],
					unifiedTabOrder: [{ type: 'ai', id: 'tab-2' }],
				} as unknown as Partial<Session>)
			);
			const { result } = renderHook(() => useTilingShortcuts());

			act(() => result.current.splitFocusedPane('column'));

			const request = useUIStore.getState().paneFocusRequest;
			expect(request).not.toBeNull();
			// The new pane is the one that took focus, so typing lands in it.
			expect(request).toBe(focusedPaneId());
		});

		it('requests no focus when there is no standalone tab to split into', () => {
			seed(makeSession({ unifiedTabOrder: [] } as Partial<Session>));
			const { result } = renderHook(() => useTilingShortcuts());

			act(() => result.current.splitFocusedPane('column'));

			expect(useUIStore.getState().paneFocusRequest).toBeNull();
		});
	});

	describe('closeFocusedPane', () => {
		it('requests DOM focus for the neighbor that inherits focus', () => {
			// Three panes so the group survives the close (it dissolves at < 2).
			seed(
				makeSession({
					aiTabs: [
						{ id: 'tab-1', name: 'Chat' },
						{ id: 'tab-2', name: 'Chat 2' },
					],
					tabGroups: [
						{
							id: GROUP_ID,
							name: 'Group',
							focusedPaneId: 'leaf-a',
							createdAt: 0,
							layout: {
								kind: 'split',
								id: 'split-1',
								direction: 'row',
								sizes: [0.34, 0.33, 0.33],
								children: [
									{ kind: 'leaf', id: 'leaf-a', tab: { type: 'ai', id: 'tab-1' } },
									{ kind: 'leaf', id: 'leaf-b', tab: { type: 'terminal', id: 'term-1' } },
									{ kind: 'leaf', id: 'leaf-c', tab: { type: 'ai', id: 'tab-2' } },
								],
							},
						},
					],
				} as unknown as Partial<Session>)
			);
			const { result } = renderHook(() => useTilingShortcuts());

			act(() => result.current.closeFocusedPane());

			const request = useUIStore.getState().paneFocusRequest;
			expect(request).not.toBeNull();
			// Whatever survived as the focused pane is what focus was requested for.
			expect(request).toBe(focusedPaneId());
		});

		it('requests no focus when closing dissolves the group', () => {
			// Two panes: removing one drops the group to a single pane, which
			// auto-dissolves back to single-view - there is no pane left to aim at.
			seed(makeSession());
			const { result } = renderHook(() => useTilingShortcuts());

			act(() => result.current.closeFocusedPane());

			expect(useSessionStore.getState().sessions[0].tabGroups).toHaveLength(0);
			expect(useUIStore.getState().paneFocusRequest).toBeNull();
		});
	});

	describe('rebalance / toggleZoom', () => {
		it('do not steal DOM focus (they never move focusedPaneId)', () => {
			seed(makeSession());
			const { result } = renderHook(() => useTilingShortcuts());

			act(() => result.current.rebalance());
			act(() => result.current.toggleZoom());

			expect(useUIStore.getState().paneFocusRequest).toBeNull();
		});
	});
});
