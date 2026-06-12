/**
 * useGroupChat hook for group chat management in the web interface.
 *
 * Provides group chat listing, creation, messaging, and real-time
 * state updates via WebSocket broadcasts.
 */

import { useState, useCallback, useEffect } from 'react';
import type { UseWebSocketReturn, GroupChatState, GroupChatMessage } from './useWebSocket';

/**
 * Return value from useGroupChat hook.
 */
export interface UseGroupChatReturn {
	/** All known group chats */
	chats: GroupChatState[];
	/** Currently active/viewed chat */
	activeChat: GroupChatState | null;
	/** Whether chats are being loaded */
	isLoading: boolean;
	/** Load all group chats from the server */
	loadChats: () => Promise<void>;
	/** Start a new group chat */
	startChat: (topic: string, participantIds: string[]) => Promise<string | null>;
	/** Load full state for a specific chat */
	loadChatState: (chatId: string) => Promise<void>;
	/** Send a message to a group chat */
	sendMessage: (chatId: string, message: string) => Promise<boolean>;
	/** Stop a group chat */
	stopChat: (chatId: string) => Promise<boolean>;
	/** Set the active chat by ID (or null to deselect) */
	setActiveChatId: (chatId: string | null) => void;
	/** Handle incoming group chat message broadcast */
	handleGroupChatMessage: (chatId: string, message: GroupChatMessage) => void;
	/** Handle incoming group chat state change broadcast */
	handleGroupChatStateChange: (chatId: string, state: Partial<GroupChatState>) => void;
}

/**
 * Hook for managing group chat state and operations.
 *
 * @param sendRequest - WebSocket sendRequest function for request-response operations
 * @param send - WebSocket send function for fire-and-forget messages
 * @param isConnected - Whether the WebSocket is connected
 */
export function useGroupChat(
	sendRequest: UseWebSocketReturn['sendRequest'],
	_send: UseWebSocketReturn['send'],
	isConnected: boolean
): UseGroupChatReturn {
	const [chats, setChats] = useState<GroupChatState[]>([]);
	const [activeChat, setActiveChat] = useState<GroupChatState | null>(null);
	const [isLoading, setIsLoading] = useState(false);

	const loadChats = useCallback(async () => {
		setIsLoading(true);
		try {
			const response = await sendRequest<{ chats?: GroupChatState[] }>('get_group_chats');
			setChats(response.chats ?? []);
		} catch {
			setChats([]);
		} finally {
			setIsLoading(false);
		}
	}, [sendRequest]);

	const startChat = useCallback(
		async (topic: string, participantIds: string[]): Promise<string | null> => {
			try {
				const response = await sendRequest<{ success?: boolean; chatId?: string }>(
					'start_group_chat',
					{ topic, participantIds }
				);
				if (response.success && response.chatId) {
					// Reload chats to get the new one
					await loadChats();
					return response.chatId;
				}
				return null;
			} catch {
				return null;
			}
		},
		[sendRequest, loadChats]
	);

	const loadChatState = useCallback(
		async (chatId: string) => {
			try {
				const response = await sendRequest<{ state?: GroupChatState | null }>(
					'get_group_chat_state',
					{ chatId }
				);
				if (response.state) {
					setActiveChat(response.state);
					// Also update in the chats list
					setChats((prev) => prev.map((c) => (c.id === chatId ? response.state! : c)));
				}
			} catch {
				// Keep current state on error
			}
		},
		[sendRequest]
	);

	const sendMessage = useCallback(
		async (chatId: string, message: string): Promise<boolean> => {
			try {
				const response = await sendRequest<{ success?: boolean }>('send_group_chat_message', {
					chatId,
					message,
				});
				return response.success ?? false;
			} catch {
				return false;
			}
		},
		[sendRequest]
	);

	const stopChat = useCallback(
		async (chatId: string): Promise<boolean> => {
			try {
				const response = await sendRequest<{ success?: boolean }>('stop_group_chat', { chatId });
				return response.success ?? false;
			} catch {
				return false;
			}
		},
		[sendRequest]
	);

	const setActiveChatId = useCallback(
		(chatId: string | null) => {
			if (chatId === null) {
				setActiveChat(null);
			} else {
				const chat = chats.find((c) => c.id === chatId);
				setActiveChat(chat ?? null);
			}
		},
		[chats]
	);

	const handleGroupChatMessage = useCallback((chatId: string, message: GroupChatMessage) => {
		// Update activeChat if it matches
		setActiveChat((prev) => {
			if (prev && prev.id === chatId) {
				return { ...prev, messages: [...prev.messages, message] };
			}
			return prev;
		});

		// Update in chats list
		setChats((prev) =>
			prev.map((c) => {
				if (c.id === chatId) {
					return { ...c, messages: [...c.messages, message] };
				}
				return c;
			})
		);
	}, []);

	const handleGroupChatStateChange = useCallback(
		(chatId: string, state: Partial<GroupChatState>) => {
			// Update activeChat if it matches
			setActiveChat((prev) => {
				if (prev && prev.id === chatId) {
					return { ...prev, ...state };
				}
				return prev;
			});

			// Update in chats list
			setChats((prev) =>
				prev.map((c) => {
					if (c.id === chatId) {
						return { ...c, ...state };
					}
					return c;
				})
			);
		},
		[]
	);

	// Auto-load chats on mount when connected
	useEffect(() => {
		if (isConnected) {
			loadChats();
		}
	}, [isConnected, loadChats]);

	return {
		chats,
		activeChat,
		isLoading,
		loadChats,
		startChat,
		loadChatState,
		sendMessage,
		stopChat,
		setActiveChatId,
		handleGroupChatMessage,
		handleGroupChatStateChange,
	};
}

export default useGroupChat;
