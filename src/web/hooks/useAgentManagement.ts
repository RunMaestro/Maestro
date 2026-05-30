/**
 * useAgentManagement hook for agent and group CRUD operations from the web client.
 *
 * Provides functions for creating, deleting, and renaming agents,
 * as well as managing groups (create, rename, delete, move agents).
 * Maintains groups state, auto-loaded on mount and refreshed via broadcasts.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { UseWebSocketReturn, GroupData } from './useWebSocket';

/**
 * Return value from useAgentManagement hook.
 */
export interface UseAgentManagementReturn {
	/** Current list of groups */
	groups: GroupData[];
	/** Whether groups are currently loading */
	isLoading: boolean;

	/** Create a new agent. Returns { sessionId } on success, null on failure. */
	createAgent: (
		name: string,
		toolType: string,
		cwd: string,
		groupId?: string
	) => Promise<{ sessionId: string } | null>;
	/** Delete an agent by session ID. */
	deleteAgent: (sessionId: string) => Promise<boolean>;
	/** Rename an agent. */
	renameAgent: (sessionId: string, newName: string) => Promise<boolean>;

	/** Fetch the latest groups list. */
	getGroups: () => Promise<GroupData[]>;
	/** Create a new group. Returns { id } on success, null on failure. */
	createGroup: (name: string, emoji?: string) => Promise<{ id: string } | null>;
	/** Rename a group. */
	renameGroup: (groupId: string, name: string) => Promise<boolean>;
	/** Delete a group. */
	deleteGroup: (groupId: string) => Promise<boolean>;
	/** Move an agent to a group (or null for ungrouped). */
	moveToGroup: (sessionId: string, groupId: string | null) => Promise<boolean>;

	/** Handler for groups_changed broadcasts — wire to onGroupsChanged in WebSocket handlers */
	handleGroupsChanged: (groups: GroupData[]) => void;
}

/**
 * Hook for managing agents and groups via WebSocket.
 *
 * @param sendRequest - WebSocket sendRequest function for request-response operations
 * @param isConnected - Whether the WebSocket is currently connected
 */
export function useAgentManagement(
	sendRequest: UseWebSocketReturn['sendRequest'],
	isConnected: boolean
): UseAgentManagementReturn {
	const [groups, setGroups] = useState<GroupData[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const hasFetchedRef = useRef(false);

	// Fetch groups on mount and when connection is established
	useEffect(() => {
		if (!isConnected) {
			hasFetchedRef.current = false;
			return;
		}
		if (hasFetchedRef.current) return;

		hasFetchedRef.current = true;
		setIsLoading(true);

		sendRequest<{ groups?: GroupData[] }>('get_groups')
			.then((response) => {
				if (response.groups) {
					setGroups(response.groups);
				}
			})
			.catch(() => {
				// Groups fetch failed — will retry on reconnect
			})
			.finally(() => {
				setIsLoading(false);
			});
	}, [isConnected, sendRequest]);

	/**
	 * Update groups from a broadcast message.
	 * Intended to be wired to onGroupsChanged in the WebSocket handlers.
	 */
	const handleGroupsChanged = useCallback((newGroups: GroupData[]) => {
		setGroups(newGroups);
	}, []);

	/**
	 * Fetch the latest groups list on demand.
	 */
	const getGroups = useCallback(async (): Promise<GroupData[]> => {
		try {
			const response = await sendRequest<{ groups?: GroupData[] }>('get_groups');
			const fetched = response.groups ?? [];
			setGroups(fetched);
			return fetched;
		} catch {
			return groups;
		}
	}, [sendRequest, groups]);

	/**
	 * Create a new agent.
	 */
	const createAgent = useCallback(
		async (
			name: string,
			toolType: string,
			cwd: string,
			groupId?: string
		): Promise<{ sessionId: string } | null> => {
			try {
				const response = await sendRequest<{
					success?: boolean;
					sessionId?: string;
				}>('create_session', { name, toolType, cwd, groupId });
				if (response.success && response.sessionId) {
					return { sessionId: response.sessionId };
				}
				return null;
			} catch {
				return null;
			}
		},
		[sendRequest]
	);

	/**
	 * Delete an agent by session ID.
	 */
	const deleteAgent = useCallback(
		async (sessionId: string): Promise<boolean> => {
			try {
				const response = await sendRequest<{ success?: boolean }>('delete_session', { sessionId });
				return response.success ?? false;
			} catch {
				return false;
			}
		},
		[sendRequest]
	);

	/**
	 * Rename an agent.
	 */
	const renameAgent = useCallback(
		async (sessionId: string, newName: string): Promise<boolean> => {
			try {
				const response = await sendRequest<{ success?: boolean }>('rename_session', {
					sessionId,
					newName,
				});
				return response.success ?? false;
			} catch {
				return false;
			}
		},
		[sendRequest]
	);

	/**
	 * Create a new group.
	 */
	const createGroup = useCallback(
		async (name: string, emoji?: string): Promise<{ id: string } | null> => {
			try {
				const response = await sendRequest<{
					success?: boolean;
					groupId?: string;
				}>('create_group', { name, emoji });
				if (response.success && response.groupId) {
					return { id: response.groupId };
				}
				return null;
			} catch {
				return null;
			}
		},
		[sendRequest]
	);

	/**
	 * Rename a group.
	 */
	const renameGroup = useCallback(
		async (groupId: string, name: string): Promise<boolean> => {
			try {
				const response = await sendRequest<{ success?: boolean }>('rename_group', {
					groupId,
					name,
				});
				return response.success ?? false;
			} catch {
				return false;
			}
		},
		[sendRequest]
	);

	/**
	 * Delete a group.
	 */
	const deleteGroup = useCallback(
		async (groupId: string): Promise<boolean> => {
			try {
				const response = await sendRequest<{ success?: boolean }>('delete_group', { groupId });
				return response.success ?? false;
			} catch {
				return false;
			}
		},
		[sendRequest]
	);

	/**
	 * Move an agent to a group (or null to ungroup).
	 */
	const moveToGroup = useCallback(
		async (sessionId: string, groupId: string | null): Promise<boolean> => {
			try {
				const response = await sendRequest<{ success?: boolean }>('move_session_to_group', {
					sessionId,
					groupId,
				});
				return response.success ?? false;
			} catch {
				return false;
			}
		},
		[sendRequest]
	);

	return {
		groups,
		isLoading,
		createAgent,
		deleteAgent,
		renameAgent,
		getGroups,
		createGroup,
		renameGroup,
		deleteGroup,
		moveToGroup,
		handleGroupsChanged,
	};
}

export default useAgentManagement;
