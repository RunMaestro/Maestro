import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UseSessionListPropsDeps } from '../../../renderer/hooks/props/useSessionListProps';
import { useSessionListProps } from '../../../renderer/hooks/props/useSessionListProps';
import type { Session } from '../../../renderer/types';

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: overrides.id ?? 'session-1',
		name: overrides.name ?? 'Session 1',
		cwd: overrides.cwd ?? '/repo',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		...overrides,
	} as Session;
}

function makeDeps(overrides: Partial<UseSessionListPropsDeps> = {}): UseSessionListPropsDeps {
	const noop = vi.fn();
	const sessions = [makeSession()];

	return {
		theme: { name: 'dark' } as UseSessionListPropsDeps['theme'],
		sortedSessions: sessions,
		isLiveMode: false,
		webInterfaceUrl: null,
		showSessionJumpNumbers: true,
		visibleSessions: sessions,
		sidebarContainerRef: { current: null },
		toggleGlobalLive: vi.fn().mockResolvedValue(undefined),
		restartWebServer: vi.fn().mockResolvedValue('http://localhost:3333'),
		toggleGroup: noop,
		handleDragStart: noop,
		handleDragOver: noop,
		handleDropOnGroup: noop,
		handleDropOnUngrouped: noop,
		finishRenamingGroup: noop,
		finishRenamingSession: noop,
		startRenamingGroup: noop,
		startRenamingSession: noop,
		showConfirmation: noop,
		createNewGroup: noop,
		handleCreateGroupAndMove: noop,
		addNewSession: noop,
		deleteSession: noop,
		deleteWorktreeGroup: noop,
		handleEditAgent: noop,
		handleOpenCreatePRSession: noop,
		handleQuickCreateWorktree: noop,
		handleOpenWorktreeConfigSession: noop,
		handleDeleteWorktreeSession: noop,
		handleToggleWorktreeExpanded: noop,
		openWizardModal: noop,
		handleStartTour: noop,
		handleOpenGroupChat: noop,
		handleNewGroupChat: noop,
		handleEditGroupChat: noop,
		handleOpenRenameGroupChatModal: noop,
		handleOpenDeleteGroupChatModal: noop,
		handleArchiveGroupChat: noop,
		...overrides,
	};
}

describe('useSessionListProps', () => {
	it('maps computed values and domain handlers to SessionList prop names', () => {
		const addNewSession = vi.fn();
		const deleteSession = vi.fn();
		const handleCreateGroupAndMove = vi.fn();
		const handleOpenGroupChat = vi.fn();
		const handleArchiveGroupChat = vi.fn();
		const deps = makeDeps({
			isLiveMode: true,
			webInterfaceUrl: 'http://localhost:3333',
			addNewSession,
			deleteSession,
			handleCreateGroupAndMove,
			handleOpenGroupChat,
			handleArchiveGroupChat,
		});

		const { result } = renderHook(() => useSessionListProps(deps));

		result.current.addNewSession();
		result.current.onNewAgentSession();
		result.current.onDeleteSession('session-1');
		result.current.onCreateGroupAndMove('session-2');
		result.current.onOpenGroupChat('chat-1');
		result.current.onArchiveGroupChat('chat-1', true);

		expect(result.current.theme).toBe(deps.theme);
		expect(result.current.sortedSessions).toBe(deps.sortedSessions);
		expect(result.current.isLiveMode).toBe(true);
		expect(result.current.webInterfaceUrl).toBe('http://localhost:3333');
		expect(result.current.sidebarContainerRef).toBe(deps.sidebarContainerRef);
		expect(addNewSession).toHaveBeenCalledTimes(2);
		expect(deleteSession).toHaveBeenCalledWith('session-1');
		expect(handleCreateGroupAndMove).toHaveBeenCalledWith('session-2');
		expect(handleOpenGroupChat).toHaveBeenCalledWith('chat-1');
		expect(handleArchiveGroupChat).toHaveBeenCalledWith('chat-1', true);
	});

	it('reuses the memoized object until a computed dependency changes', () => {
		const deps = makeDeps();
		const { result, rerender } = renderHook(({ currentDeps }) => useSessionListProps(currentDeps), {
			initialProps: { currentDeps: deps },
		});
		const initialProps = result.current;

		rerender({ currentDeps: { ...deps } });

		expect(result.current).toBe(initialProps);

		rerender({
			currentDeps: {
				...deps,
				visibleSessions: [makeSession({ id: 'session-2' })],
			},
		});

		expect(result.current).not.toBe(initialProps);
	});
});
