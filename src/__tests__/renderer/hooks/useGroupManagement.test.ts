/**
 * @file useGroupManagement.test.ts
 * @description Unit tests for the useGroupManagement hook
 *
 * Tests cover:
 * - Group collapse toggling
 * - Rename flow (trim + uppercase, empty name guard)
 * - Create group modal open state
 * - Drag-and-drop session grouping
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGroupManagement, type UseGroupManagementDeps } from '../../../renderer/hooks';
import type { Group, Session } from '../../../renderer/types';

// ============================================================================
// Test Helpers
// ============================================================================

const createMockGroup = (overrides: Partial<Group> = {}): Group => ({
	id: 'group-1',
	name: 'ALPHA',
	emoji: '📁',
	collapsed: false,
	...overrides,
});

const createMockSession = (overrides: Partial<Session> = {}): Session => ({
	id: 'session-1',
	name: 'Test Session',
	toolType: 'claude-code',
	state: 'idle',
	cwd: '/test/project',
	fullPath: '/test/project',
	projectRoot: '/test/project',
	aiLogs: [],
	shellLogs: [],
	workLog: [],
	contextUsage: 0,
	inputMode: 'ai',
	aiPid: 0,
	terminalPid: 0,
	port: 0,
	isLive: false,
	changedFiles: [],
	isGitRepo: false,
	fileTree: [],
	fileExplorerExpanded: [],
	fileExplorerScrollPos: 0,
	executionQueue: [],
	activeTimeMs: 0,
	aiTabs: [],
	activeTabId: 'tab-1',
	closedTabHistory: [],
	...overrides,
});

const createDeps = (overrides: Partial<UseGroupManagementDeps> = {}): UseGroupManagementDeps => ({
	groups: [createMockGroup()],
	setGroups: vi.fn(),
	setSessions: vi.fn(),
	draggingSessionId: null,
	setDraggingSessionId: vi.fn(),
	editingGroupId: null,
	setEditingGroupId: vi.fn(),
	...overrides,
});

// ============================================================================
// Tests
// ============================================================================

describe('useGroupManagement', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('toggles group collapsed state', () => {
		const deps = createDeps();
		const { result } = renderHook(() => useGroupManagement(deps));

		act(() => {
			result.current.toggleGroup('group-1');
		});

		expect(deps.setGroups).toHaveBeenCalledWith(expect.any(Function));

		const updater = deps.setGroups.mock.calls[0][0];
		const updated = updater(deps.groups);
		expect(updated[0].collapsed).toBe(true);
	});

	it('starts group rename by setting editingGroupId', () => {
		const deps = createDeps();
		const { result } = renderHook(() => useGroupManagement(deps));

		act(() => {
			result.current.startRenamingGroup('group-1');
		});

		expect(deps.setEditingGroupId).toHaveBeenCalledWith('group-1');
	});

	it('finishes group rename with trimmed uppercase value', () => {
		const deps = createDeps();
		const { result } = renderHook(() => useGroupManagement(deps));

		act(() => {
			result.current.finishRenamingGroup('group-1', '  new name  ');
		});

		expect(deps.setGroups).toHaveBeenCalledWith(expect.any(Function));
		expect(deps.setEditingGroupId).toHaveBeenCalledWith(null);

		const updater = deps.setGroups.mock.calls[0][0];
		const updated = updater(deps.groups);
		expect(updated[0].name).toBe('NEW NAME');
	});

	it('ignores empty group rename values', () => {
		const deps = createDeps();
		const { result } = renderHook(() => useGroupManagement(deps));

		act(() => {
			result.current.finishRenamingGroup('group-1', '   ');
		});

		expect(deps.setGroups).not.toHaveBeenCalled();
		expect(deps.setEditingGroupId).toHaveBeenCalledWith(null);
	});

	it('opens the create group modal', () => {
		const deps = createDeps();
		const { result } = renderHook(() => useGroupManagement(deps));

		act(() => {
			result.current.createNewGroup();
		});

		expect(result.current.modalState.createGroupModalOpen).toBe(true);
	});

	it('assigns dragged session to group on drop', () => {
		const session = createMockSession({ id: 'session-1' });
		const deps = createDeps({
			draggingSessionId: 'session-1',
		});
		const { result } = renderHook(() => useGroupManagement(deps));

		act(() => {
			result.current.handleDropOnGroup('group-2');
		});

		expect(deps.setSessions).toHaveBeenCalledWith(expect.any(Function));
		expect(deps.setDraggingSessionId).toHaveBeenCalledWith(null);

		const updater = deps.setSessions.mock.calls[0][0];
		const updated = updater([session]);
		expect(updated[0].groupId).toBe('group-2');
	});

	it('clears group assignment when dropped on ungrouped', () => {
		const session = createMockSession({ id: 'session-1', groupId: 'group-1' });
		const deps = createDeps({
			draggingSessionId: 'session-1',
		});
		const { result } = renderHook(() => useGroupManagement(deps));

		act(() => {
			result.current.handleDropOnUngrouped();
		});

		expect(deps.setSessions).toHaveBeenCalledWith(expect.any(Function));
		expect(deps.setDraggingSessionId).toHaveBeenCalledWith(null);

		const updater = deps.setSessions.mock.calls[0][0];
		const updated = updater([session]);
		expect(updated[0].groupId).toBeUndefined();
	});

	it('ignores drops when no session is being dragged', () => {
		const deps = createDeps({ draggingSessionId: null });
		const { result } = renderHook(() => useGroupManagement(deps));

		act(() => {
			result.current.handleDropOnGroup('group-1');
			result.current.handleDropOnUngrouped();
		});

		expect(deps.setSessions).not.toHaveBeenCalled();
		expect(deps.setDraggingSessionId).not.toHaveBeenCalled();
	});
});
