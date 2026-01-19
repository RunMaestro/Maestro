import { useCallback, useState } from 'react';
import type { Session, Group } from '../../types';

/**
 * State returned from useGroupManagement for modal management
 */
export interface GroupModalState {
	/** Whether the create group modal is open */
	createGroupModalOpen: boolean;
	/** Setters for modal state */
	setCreateGroupModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

/**
 * Dependencies for useGroupManagement hook
 */
export interface UseGroupManagementDeps {
	/** All groups */
	groups: Group[];
	/** Setter for groups */
	setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
	/** Setter for sessions (for group assignment) */
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	/** Currently dragged session ID */
	draggingSessionId: string | null;
	/** Setter for dragging session ID */
	setDraggingSessionId: React.Dispatch<React.SetStateAction<string | null>>;
	/** Currently editing group ID */
	editingGroupId: string | null;
	/** Setter for editing group ID */
	setEditingGroupId: React.Dispatch<React.SetStateAction<string | null>>;
}

/**
 * Return type for useGroupManagement hook
 */
export interface UseGroupManagementReturn {
	/** Toggle group collapse/expand state */
	toggleGroup: (groupId: string) => void;
	/** Start renaming a group (sets editingGroupId) */
	startRenamingGroup: (groupId: string) => void;
	/** Finish renaming a group */
	finishRenamingGroup: (groupId: string, newName: string) => void;
	/** Open the create group modal */
	createNewGroup: () => void;
	/** Drop a session on a group */
	handleDropOnGroup: (groupId: string) => void;
	/** Drop a session on ungrouped area */
	handleDropOnUngrouped: () => void;
	/** Modal state for create group dialog */
	modalState: GroupModalState;
}

/**
 * Group management hook for session grouping operations.
 *
 * Provides handlers for:
 * - Toggle group collapse/expand
 * - Renaming groups (inline editing)
 * - Creating new groups (modal workflow)
 * - Drag and drop sessions to groups
 *
 * @param deps - Hook dependencies containing state and setters
 * @returns Group management handlers and modal state
 */
export function useGroupManagement(deps: UseGroupManagementDeps): UseGroupManagementReturn {
	const {
		groups: _groups,
		setGroups,
		setSessions,
		draggingSessionId,
		setDraggingSessionId,
		setEditingGroupId,
	} = deps;

	// Modal state for create group dialog
	const [createGroupModalOpen, setCreateGroupModalOpen] = useState(false);

	/**
	 * Toggle group collapse/expand state
	 */
	const toggleGroup = useCallback(
		(groupId: string) => {
			setGroups((prev) =>
				prev.map((g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g))
			);
		},
		[setGroups]
	);

	/**
	 * Start renaming a group (sets editingGroupId)
	 */
	const startRenamingGroup = useCallback(
		(groupId: string) => {
			setEditingGroupId(groupId);
		},
		[setEditingGroupId]
	);

	/**
	 * Finish renaming a group
	 */
	const finishRenamingGroup = useCallback(
		(groupId: string, newName: string) => {
			const trimmedName = newName.trim();
			if (!trimmedName) {
				setEditingGroupId(null);
				return;
			}
			setGroups((prev) =>
				prev.map((g) => (g.id === groupId ? { ...g, name: trimmedName.toUpperCase() } : g))
			);
			setEditingGroupId(null);
		},
		[setGroups, setEditingGroupId]
	);

	/**
	 * Open the create group modal
	 */
	const createNewGroup = useCallback(() => {
		setCreateGroupModalOpen(true);
	}, []);

	/**
	 * Drop a session on a group
	 */
	const handleDropOnGroup = useCallback(
		(groupId: string) => {
			if (draggingSessionId) {
				setSessions((prev) =>
					prev.map((s) => (s.id === draggingSessionId ? { ...s, groupId } : s))
				);
				setDraggingSessionId(null);
			}
		},
		[draggingSessionId, setSessions, setDraggingSessionId]
	);

	/**
	 * Drop a session on ungrouped area
	 */
	const handleDropOnUngrouped = useCallback(() => {
		if (draggingSessionId) {
			setSessions((prev) =>
				prev.map((s) => (s.id === draggingSessionId ? { ...s, groupId: undefined } : s))
			);
			setDraggingSessionId(null);
		}
	}, [draggingSessionId, setSessions, setDraggingSessionId]);

	// Modal state bundle for external access
	const modalState: GroupModalState = {
		createGroupModalOpen,
		setCreateGroupModalOpen,
	};

	return {
		toggleGroup,
		startRenamingGroup,
		finishRenamingGroup,
		createNewGroup,
		handleDropOnGroup,
		handleDropOnUngrouped,
		modalState,
	};
}
