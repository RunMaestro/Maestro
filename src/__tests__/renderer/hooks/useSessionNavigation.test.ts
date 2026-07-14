import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSessionNavigation } from '../../../renderer/hooks/session/useSessionNavigation';
import type { NavHistoryEntry } from '../../../renderer/hooks/session/useNavigationHistory';
import type { Session } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab, createMockFileTab } from '../../helpers/mockTab';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { resetStore } from '../../helpers/resetStores';

/**
 * Codifies the breadcrumb restore behavior: navigateBack/navigateForward must
 * reactivate the previously-visited tab of ANY kind (ai, file, browser,
 * terminal), not just AI tabs. Guards against regressing to AI-only restore.
 */
describe('useSessionNavigation', () => {
	beforeEach(() => {
		resetStore(useSessionStore);
	});

	function setup(
		sessions: Session[],
		backEntry: NavHistoryEntry | null,
		forwardEntry: NavHistoryEntry | null = null
	) {
		useSessionStore.setState({ sessions });

		const navigateBack = vi.fn(() => backEntry);
		const navigateForward = vi.fn(() => forwardEntry);
		const setActiveSessionId = vi.fn();
		const onNavigateToGroupChat = vi.fn(async () => {});
		// Capture the updater and apply it to `sessions` so we can assert the
		// session shape the hook produces.
		let updatedSessions: Session[] = sessions;
		const setSessions = vi.fn((updater: unknown) => {
			updatedSessions =
				typeof updater === 'function'
					? (updater as (prev: Session[]) => Session[])(sessions)
					: (updater as Session[]);
		});
		const cyclePositionRef = { current: 0 };

		const { result } = renderHook(() =>
			useSessionNavigation({
				navigateBack,
				navigateForward,
				setActiveSessionId,
				setSessions: setSessions as React.Dispatch<React.SetStateAction<Session[]>>,
				cyclePositionRef,
				onNavigateToGroupChat,
			})
		);

		return {
			result,
			navigateBack,
			navigateForward,
			setActiveSessionId,
			setSessions,
			onNavigateToGroupChat,
			cyclePositionRef,
			getUpdated: () => updatedSessions,
		};
	}

	it('restores a browser tab on navigate back', () => {
		const session = createMockSession({
			id: 's1',
			aiTabs: [createMockAITab({ id: 'ai-1' })],
			activeTabId: 'ai-1',
			browserTabs: [{ id: 'b1' }] as any,
			activeBrowserTabId: null,
			unifiedTabOrder: [
				{ type: 'ai', id: 'ai-1' },
				{ type: 'browser', id: 'b1' },
			],
		});
		const { result, setActiveSessionId, getUpdated, cyclePositionRef } = setup([session], {
			sessionId: 's1',
			tabId: 'b1',
			tabKind: 'browser',
		});

		act(() => result.current.handleNavBack());

		expect(setActiveSessionId).toHaveBeenCalledWith('s1');
		expect(cyclePositionRef.current).toBe(-1);
		const updated = getUpdated().find((s) => s.id === 's1')!;
		expect(updated.activeBrowserTabId).toBe('b1');
		expect(updated.activeFileTabId).toBeNull();
		expect(updated.activeTerminalTabId).toBeNull();
		expect(updated.inputMode).toBe('ai');
	});

	it('restores a file tab on navigate back', () => {
		const session = createMockSession({
			id: 's1',
			aiTabs: [createMockAITab({ id: 'ai-1' })],
			activeTabId: 'ai-1',
			filePreviewTabs: [createMockFileTab({ id: 'f1' })],
			activeFileTabId: null,
			unifiedTabOrder: [
				{ type: 'ai', id: 'ai-1' },
				{ type: 'file', id: 'f1' },
			],
		});
		const { result, getUpdated } = setup([session], {
			sessionId: 's1',
			tabId: 'f1',
			tabKind: 'file',
		});

		act(() => result.current.handleNavBack());

		const updated = getUpdated().find((s) => s.id === 's1')!;
		expect(updated.activeFileTabId).toBe('f1');
		expect(updated.activeBrowserTabId).toBeNull();
		expect(updated.inputMode).toBe('ai');
	});

	it('restores a terminal tab (and terminal inputMode) on navigate back', () => {
		const session = createMockSession({
			id: 's1',
			aiTabs: [createMockAITab({ id: 'ai-1' })],
			activeTabId: 'ai-1',
			terminalTabs: [{ id: 't1', name: 'Terminal 1' }] as any,
			activeTerminalTabId: null,
			unifiedTabOrder: [
				{ type: 'ai', id: 'ai-1' },
				{ type: 'terminal', id: 't1' },
			],
		});
		const { result, getUpdated } = setup([session], {
			sessionId: 's1',
			tabId: 't1',
			tabKind: 'terminal',
		});

		act(() => result.current.handleNavBack());

		const updated = getUpdated().find((s) => s.id === 's1')!;
		expect(updated.activeTerminalTabId).toBe('t1');
		expect(updated.inputMode).toBe('terminal');
	});

	it('restores an AI tab for legacy entries without tabKind', () => {
		const session = createMockSession({
			id: 's1',
			aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' })],
			activeTabId: 'ai-2',
			activeFileTabId: 'f1', // stale selection that must be cleared
			filePreviewTabs: [createMockFileTab({ id: 'f1' })],
			unifiedTabOrder: [
				{ type: 'ai', id: 'ai-1' },
				{ type: 'ai', id: 'ai-2' },
				{ type: 'file', id: 'f1' },
			],
		});
		// No tabKind — mimics an entry recorded before the tabKind field existed.
		const { result, getUpdated } = setup([session], { sessionId: 's1', tabId: 'ai-1' });

		act(() => result.current.handleNavBack());

		const updated = getUpdated().find((s) => s.id === 's1')!;
		expect(updated.activeTabId).toBe('ai-1');
		expect(updated.activeFileTabId).toBeNull();
		expect(updated.inputMode).toBe('ai');
	});

	it('navigates to a group chat without touching session state', () => {
		const { result, setActiveSessionId, setSessions, onNavigateToGroupChat } = setup(
			[createMockSession({ id: 's1' })],
			{ groupChatId: 'gc1' }
		);

		act(() => result.current.handleNavBack());

		expect(onNavigateToGroupChat).toHaveBeenCalledWith('gc1');
		expect(setActiveSessionId).not.toHaveBeenCalled();
		expect(setSessions).not.toHaveBeenCalled();
	});

	it('is a no-op when the target session no longer exists', () => {
		const { result, setActiveSessionId, setSessions } = setup([createMockSession({ id: 's1' })], {
			sessionId: 'gone',
			tabId: 'x',
			tabKind: 'ai',
		});

		act(() => result.current.handleNavBack());

		expect(setActiveSessionId).not.toHaveBeenCalled();
		expect(setSessions).not.toHaveBeenCalled();
	});

	it('uses navigateForward for handleNavForward', () => {
		const session = createMockSession({
			id: 's1',
			aiTabs: [createMockAITab({ id: 'ai-1' })],
			activeTabId: 'ai-1',
			browserTabs: [{ id: 'b1' }] as any,
			unifiedTabOrder: [
				{ type: 'ai', id: 'ai-1' },
				{ type: 'browser', id: 'b1' },
			],
		});
		const { result, navigateForward, navigateBack, getUpdated } = setup([session], null, {
			sessionId: 's1',
			tabId: 'b1',
			tabKind: 'browser',
		});

		act(() => result.current.handleNavForward());

		expect(navigateForward).toHaveBeenCalledTimes(1);
		expect(navigateBack).not.toHaveBeenCalled();
		expect(getUpdated().find((s) => s.id === 's1')!.activeBrowserTabId).toBe('b1');
	});
});
