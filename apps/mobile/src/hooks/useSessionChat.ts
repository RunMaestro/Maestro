/**
 * useSessionChat - Chat functionality for a specific Maestro session
 *
 * Subscribes to events from the shared SessionsContext WebSocket, filters for
 * the target session, streams assistant output, and commits messages when the
 * session finishes a turn (either session_state_change to idle, or session_exit
 * for agents that don't emit state transitions on completion).
 *
 * Shared by the session route (`/session/[sessionId]`) and the home chat screen
 * (`/`), which targets the active session. Keep this the single source of truth
 * for session chat behavior - do not fork a second copy.
 */

import { createStreamingStore, type ChatMessage } from '@/components/chat';
import {
	useSessions,
	type SessionData,
	type SessionHistoryMessage,
	type ToolEventLog,
} from '@/lib/SessionsContext';
import { useMaestroOfflineQueue } from '@/hooks/useMaestroOfflineQueue';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Throttle interval for streaming UI updates (~30fps)
const STREAMING_THROTTLE_MS = 32;

/**
 * Convert the desktop's `SessionHistoryMessage[]` into the mobile `ChatMessage`
 * shape the UI expects. The mobile UI only renders `user` / `assistant`, plus
 * "tool" messages identified by a `tool-` id prefix (matches the existing
 * convention in renderMessage). Other roles (system/thinking/error/unknown)
 * are dropped here for parity with the streaming path — those don't show up
 * mid-conversation either, so we'd be the only surface to render them.
 */
function historyToChatMessages(history: SessionHistoryMessage[]): ChatMessage[] {
	const result: ChatMessage[] = [];
	for (const entry of history) {
		if (!entry || typeof entry.content !== 'string' || entry.content.length === 0) continue;
		if (entry.role === 'user') {
			result.push({ id: entry.id, role: 'user', content: entry.content });
		} else if (entry.role === 'assistant') {
			result.push({ id: entry.id, role: 'assistant', content: entry.content });
		} else if (entry.role === 'tool') {
			const toolId = entry.id.startsWith('tool-') ? entry.id : `tool-${entry.id}`;
			result.push({ id: toolId, role: 'assistant', content: entry.content });
		}
	}
	return result;
}

export type ChatConnectionState = 'disconnected' | 'connecting' | 'connected' | 'ready';

export interface UseSessionChatReturn {
	messages: ChatMessage[];
	input: string;
	setInput: (value: string) => void;
	isGenerating: boolean;
	onSend: () => void;
	streamingStore: ReturnType<typeof createStreamingStore>;
	connectionState: ChatConnectionState;
	session: SessionData | null;
	/** Whether the connection is active (connected or ready state) */
	isConnected: boolean;
	/** Number of commands queued for offline sending */
	queueLength: number;
}

export function useSessionChat(targetSessionId: string): UseSessionChatReturn {
	const {
		connectionState: wsConnectionState,
		sessions,
		setActiveSessionId,
		sendCommand,
		requestSessionHistory,
		subscribeSessionOutput,
		subscribeSessionStateChange,
		subscribeSessionExit,
		subscribeToolEvent,
		subscribeUserInput,
	} = useSessions();

	const session = useMemo(
		() => sessions.find((s) => s.id === targetSessionId) || null,
		[sessions, targetSessionId]
	);

	// Chat state
	const [input, setInput] = useState('');
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [isGenerating, setIsGenerating] = useState(false);

	// Streaming state
	const streamingStore = useMemo(() => createStreamingStore(), []);
	const streamingRef = useRef('');
	const throttleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const streamingMessageIdRef = useRef<string | null>(null);

	// Stable reference to targetSessionId for subscriber callbacks
	const sessionIdRef = useRef<string>(targetSessionId);
	useEffect(() => {
		sessionIdRef.current = targetSessionId;
	}, [targetSessionId]);

	// Stable reference to the active tab id so streaming subscribers can filter
	// out output produced for inactive tabs. Without this, a busy background tab
	// would append its tokens to the visible tab's message list.
	const activeTabIdRef = useRef<string | null>(null);

	// Commit the in-flight streaming buffer to the assistant message and clear
	// streaming state. Used by both session_state_change=idle and session_exit.
	const commitStreaming = useCallback(() => {
		if (streamingMessageIdRef.current && streamingRef.current) {
			const finalContent = streamingRef.current;
			const msgId = streamingMessageIdRef.current;
			setMessages((prev) => {
				const updated = [...prev];
				const lastIdx = updated.findIndex((m) => m.id === msgId);
				if (lastIdx >= 0) {
					updated[lastIdx] = { ...updated[lastIdx], content: finalContent };
				}
				return updated;
			});
			Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
		}
		streamingRef.current = '';
		streamingStore.set('');
		streamingMessageIdRef.current = null;
		setIsGenerating(false);
	}, [streamingStore]);

	// Derive screen-level connection state from the shared WS state plus whether
	// the target session has actually shown up in the sessions list.
	// Note: the desktop sends a bare `connected` message (no `authenticated: true`),
	// so we treat both 'connected' and 'authenticated' as fully ready for I/O —
	// the WS handshake itself already validated the mobile pairing token.
	const connectionState = useMemo<ChatConnectionState>(() => {
		if (wsConnectionState === 'disconnected') return 'disconnected';
		if (wsConnectionState === 'connecting') return 'connecting';
		if (session) return 'ready';
		return 'connected';
	}, [wsConnectionState, session]);

	// If the session is already running when we land on the screen, reflect that.
	useEffect(() => {
		if (session && (session.state === 'running' || session.state === 'busy')) {
			setIsGenerating(true);
		}
	}, [session]);

	// Subscribe to session output (streamed assistant tokens).
	useEffect(() => {
		return subscribeSessionOutput((outputSessionId, data, source, tabId) => {
			if (outputSessionId !== sessionIdRef.current) return;
			if (source !== 'ai') return;
			// Drop output from non-active tabs. The desktop fans out tokens for
			// every running tab; we only render the one the user is looking at.
			const currentTabId = activeTabIdRef.current;
			if (tabId && currentTabId && tabId !== currentTabId) return;

			if (!streamingMessageIdRef.current) {
				const messageId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
				streamingMessageIdRef.current = messageId;
				setMessages((prev) => [...prev, { id: messageId, role: 'assistant', content: '' }]);
				setIsGenerating(true);
			}

			streamingRef.current += data;

			if (!throttleRef.current) {
				throttleRef.current = setTimeout(() => {
					streamingStore.set(streamingRef.current);
					throttleRef.current = null;
				}, STREAMING_THROTTLE_MS);
			}
		});
	}, [subscribeSessionOutput, streamingStore]);

	// Subscribe to session_state_change (turn-complete signal for agents that
	// emit explicit idle/ready transitions).
	useEffect(() => {
		return subscribeSessionStateChange((changedSessionId, state) => {
			if (changedSessionId !== sessionIdRef.current) return;
			if (state === 'idle' || state === 'ready') {
				commitStreaming();
			} else if (state === 'running' || state === 'busy') {
				setIsGenerating(true);
			}
		});
	}, [subscribeSessionStateChange, commitStreaming]);

	// Subscribe to session_exit (turn-complete signal for agents like Claude Code
	// that exit per turn instead of emitting a state change). Without this the
	// spinner stuck forever and onSend early-returned because isGenerating stayed
	// true.
	useEffect(() => {
		return subscribeSessionExit((exitSessionId) => {
			if (exitSessionId !== sessionIdRef.current) return;
			commitStreaming();
		});
	}, [subscribeSessionExit, commitStreaming]);

	// Subscribe to tool events.
	useEffect(() => {
		return subscribeToolEvent((toolSessionId, _tabId, toolLog: ToolEventLog) => {
			if (toolSessionId !== sessionIdRef.current) return;

			const toolName = toolLog.metadata?.toolState?.name || 'tool';
			const status = toolLog.metadata?.toolState?.status || 'running';
			const toolMessageId = `tool-${toolLog.id}`;

			setMessages((prev) => {
				const existingIdx = prev.findIndex((m) => m.id === toolMessageId);
				const toolContent =
					status === 'running'
						? `Running: ${toolName}`
						: status === 'completed'
							? `Completed: ${toolName}`
							: `Error: ${toolName}`;

				if (existingIdx >= 0) {
					const updated = [...prev];
					updated[existingIdx] = { ...updated[existingIdx], content: toolContent };
					return updated;
				}
				return [...prev, { id: toolMessageId, role: 'assistant' as const, content: toolContent }];
			});
		});
	}, [subscribeToolEvent]);

	// Subscribe to user input echoed from desktop.
	useEffect(() => {
		return subscribeUserInput((inputSessionId, command, inputMode) => {
			if (inputSessionId !== sessionIdRef.current) return;
			if (inputMode !== 'ai') return;

			const messageId = `user-desktop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			setMessages((prev) => [...prev, { id: messageId, role: 'user', content: command }]);
		});
	}, [subscribeUserInput]);

	// Sync active session in context so the drawer + tab strip stay in sync.
	useEffect(() => {
		if (targetSessionId) {
			setActiveSessionId(targetSessionId);
		}
	}, [targetSessionId, setActiveSessionId]);

	// Load history (and reset streaming state) when the session or active tab
	// changes. Without this the screen would be empty until the user sends a
	// new message — the desktop already has the conversation, we just never
	// asked for it.
	const activeTabId = session?.activeTabId ?? null;
	useEffect(() => {
		activeTabIdRef.current = activeTabId;
		setMessages([]);
		streamingRef.current = '';
		streamingStore.set('');
		streamingMessageIdRef.current = null;
		setIsGenerating(false);

		if (!targetSessionId || !activeTabId) return;
		if (wsConnectionState !== 'connected' && wsConnectionState !== 'authenticated') return;

		let cancelled = false;
		requestSessionHistory(activeTabId)
			.then((result) => {
				if (cancelled) return;
				if (sessionIdRef.current !== targetSessionId) return;
				const initial = historyToChatMessages(result.messages);
				if (initial.length === 0) return;
				// Prepend so any streaming/user/tool events that landed while the
				// request was in flight stay at the end of the conversation.
				setMessages((prev) => {
					const seen = new Set(prev.map((m) => m.id));
					const deduped = initial.filter((m) => !seen.has(m.id));
					return deduped.length === 0 ? prev : [...deduped, ...prev];
				});
			})
			.catch((err) => {
				if (cancelled) return;
				console.warn('[useSessionChat] Failed to load session history', err);
			});

		return () => {
			cancelled = true;
		};
	}, [targetSessionId, activeTabId, wsConnectionState, requestSessionHistory, streamingStore]);

	const isConnected = connectionState === 'connected' || connectionState === 'ready';

	// Offline queue for queueing commands when disconnected.
	const queueSend = useCallback(
		(sessionId: string, command: string) => {
			return sendCommand(sessionId, command);
		},
		[sendCommand]
	);

	const { queueCommand, queueLength } = useMaestroOfflineQueue({
		isOnline: connectionState !== 'disconnected',
		isConnected: connectionState === 'ready',
		sendCommand: queueSend,
		onCommandSent: useCallback(() => {
			Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
		}, []),
	});

	const onSend = useCallback(() => {
		if (!input.trim() || isGenerating || !targetSessionId) return;

		Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

		const userMessageId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		setMessages((prev) => [...prev, { id: userMessageId, role: 'user', content: input.trim() }]);

		if (!isConnected) {
			queueCommand(targetSessionId, input.trim(), 'ai');
			setInput('');
			return;
		}

		sendCommand(targetSessionId, input.trim());
		setInput('');
		setIsGenerating(true);
	}, [input, isGenerating, targetSessionId, sendCommand, isConnected, queueCommand]);

	// Cleanup throttle timeout on unmount.
	useEffect(() => {
		return () => {
			if (throttleRef.current) {
				clearTimeout(throttleRef.current);
			}
		};
	}, []);

	return {
		messages,
		input,
		setInput,
		isGenerating,
		onSend,
		streamingStore,
		connectionState,
		session,
		isConnected,
		queueLength,
	};
}
