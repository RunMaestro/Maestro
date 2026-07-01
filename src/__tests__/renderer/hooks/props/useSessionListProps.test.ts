import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
	useSessionListProps,
	type UseSessionListPropsDeps,
} from '../../../../renderer/hooks/props';
import { mockTheme } from '../../../helpers/mockTheme';

function createDeps(overrides: Partial<UseSessionListPropsDeps> = {}): UseSessionListPropsDeps {
	return {
		theme: mockTheme,
		sortedSessions: [],
		isLiveMode: false,
		webInterfaceUrl: null,
		showSessionJumpNumbers: false,
		visibleSessions: [],
		navIndexMap: new Map(),
		starredItems: [],
		activateStarredItem: vi.fn(),
		sidebarContainerRef: { current: null },
		toggleGlobalLive: vi.fn().mockResolvedValue(undefined),
		restartWebServer: vi.fn().mockResolvedValue(null),
		toggleGroup: vi.fn(),
		handleDragStart: vi.fn(),
		handleDragOver: vi.fn(),
		handleDropOnGroup: vi.fn(),
		handleDropOnUngrouped: vi.fn(),
		finishRenamingGroup: vi.fn(),
		finishRenamingSession: vi.fn(),
		startRenamingGroup: vi.fn(),
		startRenamingSession: vi.fn(),
		showConfirmation: vi.fn(),
		createNewGroup: vi.fn(),
		handleCreateGroupAndMove: vi.fn(),
		addNewSession: vi.fn(),
		deleteSession: vi.fn(),
		deleteWorktreeGroup: vi.fn(),
		handleEditAgent: vi.fn(),
		handleOpenCreatePRSession: vi.fn(),
		handleQuickCreateWorktree: vi.fn(),
		handleOpenWorktreeConfigSession: vi.fn(),
		handleDeleteWorktreeSession: vi.fn(),
		handleToggleWorktreeExpanded: vi.fn(),
		handleConfigureCue: vi.fn(),
		maestroCueEnabled: false,
		handleJumpToStarredSession: vi.fn().mockResolvedValue(false),
		openWizardModal: vi.fn(),
		handleOpenFeedbackModal: vi.fn(),
		handleStartTour: vi.fn(),
		handleOpenGroupChat: vi.fn(),
		handleNewGroupChat: vi.fn(),
		handleEditGroupChat: vi.fn(),
		handleOpenRenameGroupChatModal: vi.fn(),
		handleOpenDeleteGroupChatModal: vi.fn(),
		handleArchiveGroupChat: vi.fn(),
		handleDeleteAllArchivedGroupChats: vi.fn(),
		...overrides,
	};
}

describe('useSessionListProps', () => {
	it('hides the Maestro Cue configure action when the Encore Feature is disabled', () => {
		const handleConfigureCue = vi.fn();

		const { result } = renderHook(() =>
			useSessionListProps(createDeps({ handleConfigureCue, maestroCueEnabled: false }))
		);

		expect(result.current.onConfigureCue).toBeUndefined();
	});

	it('passes the Maestro Cue configure action when the Encore Feature is enabled', () => {
		const handleConfigureCue = vi.fn();

		const { result } = renderHook(() =>
			useSessionListProps(createDeps({ handleConfigureCue, maestroCueEnabled: true }))
		);

		expect(result.current.onConfigureCue).toBe(handleConfigureCue);
	});
});
