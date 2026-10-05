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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGroupManagement, type UseGroupManagementDeps } from '../../../renderer/hooks';
import type { Group, Session } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import { isLibraryRuntimeHosting } from '../../../renderer/services/libraryRuntime';
import { moveAgentToGroup, renameGroup, updateGroup } from '../../../renderer/services/agentOps';

// The flag defaults to false, so the tests outside the hosted describe exercise the OFF path unchanged.
vi.mock('../../../renderer/services/libraryRuntime', async () => {
	const actual = await vi.importActual<typeof import('../../../renderer/services/libraryRuntime')>(
		'../../../renderer/services/libraryRuntime'
	);
	return { ...actual, isLibraryRuntimeHosting: vi.fn(() => false) };
});

vi.mock('../../../renderer/services/agentOps', () => ({
	moveAgentToGroup: vi.fn(),
	renameGroup: vi.fn(),
	updateGroup: vi.fn(),
}));

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

// createMockSession imported from shared helper

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
		vi.mocked(isLibraryRuntimeHosting).mockReturnValue(false);
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

	it('preselects and clears the parent for a nested group creation', () => {
		const deps = createDeps();
		const { result } = renderHook(() => useGroupManagement(deps));

		act(() => {
			result.current.createNewGroup('parent');
		});

		expect(result.current.modalState).toMatchObject({
			createGroupModalOpen: true,
			createGroupParentId: 'parent',
		});

		act(() => {
			result.current.handleCloseCreateGroupModal();
		});

		expect(result.current.modalState).toMatchObject({
			createGroupModalOpen: false,
			createGroupParentId: undefined,
		});
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

	it('sets a root group parent', () => {
		const parent = createMockGroup({ id: 'parent' });
		const child = createMockGroup({ id: 'child' });
		const deps = createDeps({ groups: [parent, child] });
		const { result } = renderHook(() => useGroupManagement(deps));

		act(() => {
			result.current.setGroupParent('child', 'parent');
		});

		const updater = deps.setGroups.mock.calls[0][0];
		expect(updater(deps.groups)).toEqual([parent, { ...child, parentGroupId: 'parent' }]);
	});

	it('rejects a move that would exceed the depth cap', () => {
		const parent = createMockGroup({ id: 'parent' });
		const child = createMockGroup({ id: 'child', parentGroupId: 'parent' });
		const grandchild = createMockGroup({ id: 'grandchild' });
		const deps = createDeps({ groups: [parent, child, grandchild] });
		const { result } = renderHook(() => useGroupManagement(deps));

		act(() => {
			result.current.setGroupParent('grandchild', 'child');
		});

		const updater = deps.setGroups.mock.calls[0][0];
		expect(updater(deps.groups)).toBe(deps.groups);
	});
});

describe('useGroupManagement when the library runtime is hosted', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(isLibraryRuntimeHosting).mockReturnValue(true);
		vi.mocked(renameGroup).mockResolvedValue({ ok: true, value: undefined });
		vi.mocked(updateGroup).mockResolvedValue({ ok: true, value: undefined });
		vi.mocked(moveAgentToGroup).mockResolvedValue({ ok: true, value: undefined });
	});

	afterEach(() => {
		vi.mocked(isLibraryRuntimeHosting).mockReturnValue(false);
	});

	it('renames a group with the trimmed name and leaves casing to the runtime', () => {
		const deps = createDeps();
		const { result } = renderHook(() => useGroupManagement(deps));

		act(() => {
			result.current.finishRenamingGroup('group-1', '  new name  ');
		});

		expect(renameGroup).toHaveBeenCalledWith('group-1', 'new name');
		expect(deps.setEditingGroupId).toHaveBeenCalledWith(null);
		expect(deps.setGroups).not.toHaveBeenCalled();
	});

	it('only clears editing for a blank rename', () => {
		const deps = createDeps();
		const { result } = renderHook(() => useGroupManagement(deps));

		act(() => {
			result.current.finishRenamingGroup('group-1', '   ');
		});

		expect(renameGroup).not.toHaveBeenCalled();
		expect(deps.setEditingGroupId).toHaveBeenCalledWith(null);
		expect(deps.setGroups).not.toHaveBeenCalled();
	});

	it('sets a group parent through updateGroup', () => {
		const deps = createDeps();
		const { result } = renderHook(() => useGroupManagement(deps));

		act(() => {
			result.current.setGroupParent('group-1', 'parent');
		});

		expect(updateGroup).toHaveBeenCalledWith('group-1', { parentGroupId: 'parent' });
		expect(deps.setGroups).not.toHaveBeenCalled();
	});

	it('turns an undefined parent into null so the runtime moves the group to the root', () => {
		const deps = createDeps();
		const { result } = renderHook(() => useGroupManagement(deps));

		act(() => {
			result.current.setGroupParent('group-1', undefined);
		});

		expect(updateGroup).toHaveBeenCalledWith('group-1', { parentGroupId: null });
		expect(deps.setGroups).not.toHaveBeenCalled();
	});

	it('moves the dragged agent into the group on drop', () => {
		const deps = createDeps({ draggingSessionId: 'session-1' });
		const { result } = renderHook(() => useGroupManagement(deps));

		act(() => {
			result.current.handleDropOnGroup('group-1');
		});

		expect(moveAgentToGroup).toHaveBeenCalledWith('session-1', 'group-1');
		expect(deps.setDraggingSessionId).toHaveBeenCalledWith(null);
		expect(deps.setSessions).not.toHaveBeenCalled();
		expect(deps.setGroups).not.toHaveBeenCalled();
	});

	it('ungroups the dragged agent on drop onto the ungrouped area', () => {
		const deps = createDeps({ draggingSessionId: 'session-1' });
		const { result } = renderHook(() => useGroupManagement(deps));

		act(() => {
			result.current.handleDropOnUngrouped();
		});

		expect(moveAgentToGroup).toHaveBeenCalledWith('session-1', null);
		expect(deps.setDraggingSessionId).toHaveBeenCalledWith(null);
		expect(deps.setSessions).not.toHaveBeenCalled();
		expect(deps.setGroups).not.toHaveBeenCalled();
	});

	it('ignores drops when no agent is being dragged', () => {
		const deps = createDeps({ draggingSessionId: null });
		const { result } = renderHook(() => useGroupManagement(deps));

		act(() => {
			result.current.handleDropOnGroup('group-1');
			result.current.handleDropOnUngrouped();
		});

		expect(moveAgentToGroup).not.toHaveBeenCalled();
		expect(deps.setDraggingSessionId).not.toHaveBeenCalled();
	});
});
