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

// How long a locally-sent prompt stays eligible to absorb its own `user_input`
// echo from the desktop. Long enough to cover an offline-queue replay landing
// after reconnect, short enough that it can't shadow an unrelated desktop-typed
// message with the same text much later.
const ECHO_DEDUP_WINDOW_MS = 60_000;

/**
 * Convert the desktop's `SessionHistoryMessage[]` into the mobile `ChatMessage`
 * shape the UI expects. The mobile UI only renders `user` / `assistant`, plus
 * "tool" messages identified by a `tool-` id prefix (matches the existing
 * convention in renderMessage). Other roles (system/thinking/error/unknown)
 * are dropped here for parity with the streaming path; those don't show up
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
		subscribeToSession,
		sendCommand,
		requestSessionHistory,
		subscribeSessionOutput,
		subscribeSessionStateChange,
		subscribeSessionExit,
		subscribeToolEvent,
		subscribeUserInput,
		subscribeCommandResult,
		subscribeStaleBuffer,
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

	// Prompts we dispatched locally, awaiting their own `user_input` echo from
	// the desktop (which fans out to every subscriber, including this socket).
	// Recorded at dispatch time so an offline-queue replay still matches its echo.
	const pendingEchoesRef = useRef<{ command: string; ts: number }[]>([]);
	const recordPendingEcho = useCallback((command: string) => {
		pendingEchoesRef.current.push({ command, ts: Date.now() });
	}, []);

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

	// Drop an in-flight streaming turn without committing it. Used when a long
	// background pause invalidated the buffer: the desktop has likely already
	// finished, so the partial assistant bubble is abandoned (history reload on
	// reconnect re-fetches the final message) and isGenerating is unstuck so the
	// user can send again.
	const discardStreaming = useCallback(() => {
		const msgId = streamingMessageIdRef.current;
		if (msgId) {
			setMessages((prev) => prev.filter((m) => m.id !== msgId));
		}
		streamingRef.current = '';
		streamingStore.set('');
		streamingMessageIdRef.current = null;
		setIsGenerating(false);
	}, [streamingStore]);

	// Derive screen-level connection state from the shared WS state plus whether
	// the target session has actually shown up in the sessions list.
	// Note: the desktop sends a bare `connected` message (no `authenticated: true`),
	// so we treat both 'connected' and 'authenticated' as fully ready for I/O.
	// The WS handshake itself already validated the mobile pairing token.
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
		return subscribeSessionExit((exitSessionId, tabId) => {
			if (exitSessionId !== sessionIdRef.current) return;
			// A background tab can finish while the visible tab is still
			// generating. The desktop tags the exit with its AI tab id, so ignore
			// exits for any tab other than the one on screen - otherwise we'd
			// commit/clear the active tab's turn early and let the user send into
			// a still-running conversation.
			const currentTabId = activeTabIdRef.current;
			if (tabId && currentTabId && tabId !== currentTabId) return;
			commitStreaming();
		});
	}, [subscribeSessionExit, commitStreaming]);

	// Subscribe to tool events.
	useEffect(() => {
		return subscribeToolEvent((toolSessionId, tabId, toolLog: ToolEventLog) => {
			if (toolSessionId !== sessionIdRef.current) return;
			// Drop tool events for non-active tabs, mirroring the session_output
			// filter. The desktop fans tool_event for every running tab, so without
			// this a background tab's Running/Completed bubbles land in the visible
			// tab's list and disagree with its history until reload.
			const currentTabId = activeTabIdRef.current;
			if (tabId && currentTabId && tabId !== currentTabId) return;

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

			// The desktop broadcasts `user_input` to every session subscriber,
			// including the socket that sent it. We already rendered an optimistic
			// bubble for our own prompts, so absorb one matching pending echo and
			// skip the duplicate. Only echoes with no pending local match (i.e.
			// prompts typed on the desktop) get appended.
			const pending = pendingEchoesRef.current;
			const now = Date.now();
			while (pending.length > 0 && now - pending[0].ts > ECHO_DEDUP_WINDOW_MS) {
				pending.shift();
			}
			const matchIdx = pending.findIndex((e) => e.command === command);
			if (matchIdx >= 0) {
				pending.splice(matchIdx, 1);
				return;
			}

			const messageId = `user-desktop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			setMessages((prev) => [...prev, { id: messageId, role: 'user', content: command }]);
		});
	}, [subscribeUserInput]);

	// Subscribe to send_command acknowledgements. A `success: false` result means
	// the desktop rejected the prompt (session busy or removed), so roll back the
	// optimistic generating state instead of leaving the user stuck behind a
	// spinner waiting on output that will never arrive.
	useEffect(() => {
		return subscribeCommandResult((resultSessionId, success, tabId) => {
			if (resultSessionId !== sessionIdRef.current) return;
			if (success) return;
			const currentTabId = activeTabIdRef.current;
			if (tabId && currentTabId && tabId !== currentTabId) return;
			setIsGenerating(false);
		});
	}, [subscribeCommandResult]);

	// Subscribe to stale-buffer notifications. After a long background pause the
	// in-flight streaming turn is no longer trustworthy, so drop it and unstick
	// isGenerating; the history reload on reconnect restores the final message.
	useEffect(() => {
		return subscribeStaleBuffer(() => {
			discardStreaming();
		});
	}, [subscribeStaleBuffer, discardStreaming]);

	// Sync active session in context so the drawer + tab strip stay in sync.
	useEffect(() => {
		if (targetSessionId) {
			setActiveSessionId(targetSessionId);
		}
	}, [targetSessionId, setActiveSessionId]);

	// Tell the desktop to fan tool_event messages for this session to us. The
	// desktop's broadcastToolEvent is subscribed-only, so without this the
	// Running/Completed tool bubbles never arrive mid-turn. Re-fires on
	// reconnect because the subscription is per-socket and doesn't survive.
	useEffect(() => {
		if (!targetSessionId) return;
		if (wsConnectionState !== 'connected' && wsConnectionState !== 'authenticated') return;
		subscribeToSession(targetSessionId);
	}, [targetSessionId, wsConnectionState, subscribeToSession]);

	// Reset chat state only when the user actually navigates to a different
	// session or tab. Previously this effect was keyed on wsConnectionState
	// too, so a reconnect (e.g. backgrounded -> foreground) would blow away
	// the local message list before the offline queue had a chance to replay,
	// making queued user bubbles flash and disappear.
	const activeTabId = session?.activeTabId ?? null;
	const prevTargetRef = useRef<{ sessionId: string; tabId: string | null } | null>(null);
	useEffect(() => {
		activeTabIdRef.current = activeTabId;
		const prev = prevTargetRef.current;
		const isInitial = prev === null;
		const targetChanged =
			!isInitial && (prev.sessionId !== targetSessionId || prev.tabId !== activeTabId);

		if (isInitial || targetChanged) {
			setMessages([]);
			streamingRef.current = '';
			streamingStore.set('');
			streamingMessageIdRef.current = null;
			setIsGenerating(false);
		}
		prevTargetRef.current = { sessionId: targetSessionId, tabId: activeTabId };
	}, [targetSessionId, activeTabId, streamingStore]);

	// Load (or reload) the conversation backlog whenever the target or
	// connection state changes. The dedupe-merge below keeps queued user
	// bubbles and any streaming/user/tool events that landed while the request
	// was in flight, so a reconnect refreshes history without wiping pending
	// local state.
	useEffect(() => {
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
					// Optimistic local user bubbles use a generated `user-...` id, while
					// the persisted history copy of the same prompt carries the log id, so
					// an id-only dedupe would show the prompt twice after a reconnect or
					// history reload. Match history user messages against pending optimistic
					// bubbles by content and drop the duplicate, consuming each bubble once
					// so legitimately repeated prompts are preserved.
					const optimisticUserCounts = new Map<string, number>();
					for (const m of prev) {
						if (
							m.role === 'user' &&
							m.id.startsWith('user-') &&
							!m.id.startsWith('user-desktop-')
						) {
							optimisticUserCounts.set(m.content, (optimisticUserCounts.get(m.content) ?? 0) + 1);
						}
					}
					const deduped = initial.filter((m) => {
						if (seen.has(m.id)) return false;
						if (m.role === 'user') {
							const remaining = optimisticUserCounts.get(m.content) ?? 0;
							if (remaining > 0) {
								optimisticUserCounts.set(m.content, remaining - 1);
								return false;
							}
						}
						return true;
					});
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
	}, [targetSessionId, activeTabId, wsConnectionState, requestSessionHistory]);

	const isConnected = connectionState === 'connected' || connectionState === 'ready';

	// Offline queue for queueing commands when disconnected. Threads through
	// the optional tabId from the queued entry so replays land in the same tab
	// the user was on when offline, not whatever tab happens to be active when
	// the socket comes back.
	const queueSend = useCallback(
		(sessionId: string, command: string, tabId?: string) => {
			const sent = sendCommand(sessionId, command, tabId);
			// Record at actual dispatch (offline-queue replay can fire long after
			// the user typed) so the prompt's own echo is still absorbed.
			if (sent) recordPendingEcho(command);
			return sent;
		},
		[sendCommand, recordPendingEcho]
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

		const trimmed = input.trim();
		const userMessageId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		setMessages((prev) => [...prev, { id: userMessageId, role: 'user', content: trimmed }]);

		// Capture the tab id at submit time so a later replay (offline queue, or
		// the fallback below when a socket write loses to a race) targets the
		// same conversation the user is looking at right now.
		const targetTabId = activeTabIdRef.current ?? undefined;

		if (!isConnected) {
			queueCommand(targetSessionId, trimmed, 'ai', targetTabId);
			setInput('');
			return;
		}

		// Socket could have closed between the render that set isConnected and
		// here (NetInfo lag, background transition, etc.). sendCommand returns
		// false in that case; fall back to the offline queue instead of silently
		// dropping the prompt while clearing the input and pinning isGenerating.
		const sent = sendCommand(targetSessionId, trimmed, targetTabId);
		if (!sent) {
			queueCommand(targetSessionId, trimmed, 'ai', targetTabId);
			setInput('');
			return;
		}
		recordPendingEcho(trimmed);
		setInput('');
		setIsGenerating(true);
	}, [
		input,
		isGenerating,
		targetSessionId,
		sendCommand,
		isConnected,
		queueCommand,
		recordPendingEcho,
	]);

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
