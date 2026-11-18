import { useState, useRef, useCallback, useLayoutEffect } from 'react';
import type { SessionMessagesResult } from '../../../main/agents/session-storage';
import { canonicalJson } from '../../../shared/canonicalJson';
import type { NativeSessionBinding } from '../../../shared/maestro-lib/agents/providerSwap';
import { matchesNativeSessionBinding, resumeSelectionKey } from '../../services/resumableSession';
import { useSessionStore } from '../../stores/sessionStore';
import { logger } from '../../utils/logger';

/**
 * Session message from Claude session JSONL files
 */
export interface SessionMessage {
	type: string;
	role?: string;
	content: string;
	timestamp: string;
	uuid: string;
	toolUse?: any;
	/** Base64 data URLs reconstructed from image content blocks in the transcript. */
	images?: string[];
}

/**
 * Agent session metadata (used for session browser)
 */
export interface AgentSession {
	/** Selected Maestro owner and observed native source, retained with this record. */
	ownerAgentId?: string;
	nativeSessionBinding?: NativeSessionBinding;
	transcriptSource?: SessionMessagesResult['source'];
	sessionId: string;
	projectPath: string;
	timestamp: string;
	modifiedAt: string;
	firstMessage: string;
	messageCount: number;
	sizeBytes: number;
	costUsd?: number; // Optional - some sessions may not have cost data
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	durationSeconds: number;
	origin?: 'user' | 'auto' | 'relay';
	sessionName?: string;
}

/**
 * @deprecated Use AgentSession instead
 */
export type ClaudeSession = AgentSession;

/**
 * Dependencies for useSessionViewer hook
 */
export interface UseSessionViewerDeps {
	/** Current working directory for the active session */
	cwd: string | undefined;
	/** Agent ID for the session (e.g., 'claude-code', 'opencode') */
	agentId?: string;
	/** Optional SSH remote ID for accessing sessions on a remote host */
	sshRemoteId?: string;
	ownerAgentId?: string;
	/** Private selection fence from resumeSelectionKey; never persisted or displayed. */
	selectionKey?: string;
}

/**
 * Return type for useSessionViewer hook
 */
export interface UseSessionViewerReturn {
	/** Currently viewed session (null when showing list view) */
	viewingSession: AgentSession | null;
	/** Messages loaded for the current session */
	messages: SessionMessage[];
	/** Whether messages are currently loading */
	messagesLoading: boolean;
	readError: string | null;
	/** Whether there are more messages to load */
	hasMoreMessages: boolean;
	/** Total number of messages in the session */
	totalMessages: number;
	/** Current offset for pagination */
	messagesOffset: number;
	/** Ref to the messages container for scroll handling */
	messagesContainerRef: React.RefObject<HTMLDivElement>;
	/** Load messages for a session (with optional offset for pagination) */
	loadMessages: (session: AgentSession, offset?: number) => Promise<void>;
	/** Start viewing a session (loads messages and sets viewingSession) */
	handleViewSession: (session: AgentSession) => void;
	/** Load more messages (older messages) */
	handleLoadMore: () => void;
	/** Handle scroll event for lazy loading */
	handleMessagesScroll: () => void;
	/** Clear the viewing session and return to list */
	clearViewingSession: () => void;
	/** Setter for viewingSession (for updates like rename) */
	setViewingSession: React.Dispatch<React.SetStateAction<AgentSession | null>>;
}

/**
 * Hook for managing session viewer state and pagination
 *
 * Encapsulates the detail view functionality of the AgentSessionsBrowser:
 * - Viewing a single session's messages
 * - Lazy loading messages with pagination
 * - Scroll-based infinite loading
 *
 * @example
 * ```tsx
 * const {
 *   viewingSession,
 *   messages,
 *   messagesLoading,
 *   handleViewSession,
 *   handleMessagesScroll,
 *   clearViewingSession,
 * } = useSessionViewer({ cwd: activeSession?.cwd });
 *
 * // View a session
 * handleViewSession(session);
 *
 * // Return to list
 * clearViewingSession();
 * ```
 */
export function useSessionViewer({
	cwd,
	agentId = 'claude-code',
	sshRemoteId,
	ownerAgentId,
	selectionKey,
}: UseSessionViewerDeps): UseSessionViewerReturn {
	const [viewingSession, setViewingSession] = useState<AgentSession | null>(null);
	const [messages, setMessages] = useState<SessionMessage[]>([]);
	const [messagesLoading, setMessagesLoading] = useState(false);
	const [readError, setReadError] = useState<string | null>(null);
	const [hasMoreMessages, setHasMoreMessages] = useState(false);
	const [totalMessages, setTotalMessages] = useState(0);
	const [messagesOffset, setMessagesOffset] = useState(0);

	const messagesContainerRef = useRef<HTMLDivElement>(null);
	const scopeKey = canonicalJson({ cwd, agentId, sshRemoteId, ownerAgentId, selectionKey });
	const scopeRef = useRef(scopeKey);
	scopeRef.current = scopeKey;
	const requestRef = useRef(0);
	const selectedRef = useRef<AgentSession | null>(null);
	const [viewScope, setViewScope] = useState(scopeKey);

	const clearViewingSession = useCallback(() => {
		requestRef.current++;
		selectedRef.current = null;
		setViewingSession(null);
		setMessages([]);
		setMessagesLoading(false);
		setHasMoreMessages(false);
		setTotalMessages(0);
		setMessagesOffset(0);
		setReadError(null);
	}, []);

	useLayoutEffect(() => {
		clearViewingSession();
		setViewScope(scopeKey);
		return () => {
			requestRef.current++;
			selectedRef.current = null;
		};
	}, [scopeKey, clearViewingSession]);

	/**
	 * Load messages for a session with pagination support
	 * @param session - The session to load messages for
	 * @param offset - Offset for pagination (0 for initial load)
	 */
	const loadMessages = useCallback(
		async (session: AgentSession, offset: number = 0) => {
			if (!cwd || scopeRef.current !== scopeKey) return;
			if (session.ownerAgentId && session.ownerAgentId !== ownerAgentId) return;
			if (agentId === 'grok' && !ownerAgentId) {
				clearViewingSession();
				setReadError('Select the owning Grok agent before viewing its history.');
				return;
			}
			if (offset > 0 && selectedRef.current?.sessionId !== session.sessionId) return;
			const retained = offset > 0 ? selectedRef.current! : session;
			if (
				offset > 0 &&
				agentId === 'grok' &&
				!matchesNativeSessionBinding(session.nativeSessionBinding, retained.nativeSessionBinding)
			)
				return;
			const binding = retained.nativeSessionBinding
				? structuredClone(retained.nativeSessionBinding)
				: undefined;
			const request = ++requestRef.current;
			const isCurrent = () => {
				if (requestRef.current !== request || scopeRef.current !== scopeKey) return false;
				if (selectionKey !== undefined) {
					const owner = useSessionStore.getState().sessions.find((s) => s.id === ownerAgentId);
					if (!owner || resumeSelectionKey(owner) !== selectionKey) {
						clearViewingSession();
						setReadError('The selected agent changed. Select its history again.');
						return false;
					}
				}
				return true;
			};
			if (!isCurrent()) return;
			if (offset === 0) {
				const selected = { ...session, ownerAgentId, nativeSessionBinding: binding };
				selectedRef.current = selected;
				setViewingSession(selected);
				setMessages([]);
				setHasMoreMessages(false);
				setTotalMessages(0);
				setMessagesOffset(0);
			}

			setMessagesLoading(true);
			setReadError(null);
			try {
				// Use the generic agentSessions API with agentId parameter
				// Pass sshRemoteId for SSH remote session access
				const result = await window.maestro.agentSessions.read(
					agentId,
					cwd,
					session.sessionId,
					{
						offset,
						limit: 20,
						...(ownerAgentId === undefined ? {} : { ownerAgentId }),
						...(binding === undefined ? {} : { nativeSessionBinding: binding }),
					},
					sshRemoteId
				);
				if (!isCurrent()) return;
				const observed = result.nativeSessionBinding;
				if (
					agentId === 'grok' &&
					(!matchesNativeSessionBinding(observed, observed) ||
						observed?.state !== 'bound' ||
						observed.provider !== agentId ||
						observed.nativeSessionId !== session.sessionId ||
						(binding !== undefined && !matchesNativeSessionBinding(binding, observed)) ||
						(offset > 0 && !binding) ||
						result.source?.provider !== agentId ||
						result.source.status === 'unavailable')
				) {
					clearViewingSession();
					setReadError('History ownership is unavailable or changed. Select the session again.');
					return;
				}
				const receipt = {
					ownerAgentId,
					nativeSessionBinding: observed ? structuredClone(observed) : undefined,
					transcriptSource:
						offset > 0 && retained.transcriptSource?.status === 'partial'
							? retained.transcriptSource
							: result.source,
				};
				selectedRef.current = { ...selectedRef.current!, ...receipt };
				// A rename may have landed during this page. Only replace source fields.
				setViewingSession((current) => (current ? { ...current, ...receipt } : current));
				if (agentId === 'grok' && receipt.transcriptSource?.status !== 'available') {
					setReadError('This history is incomplete and cannot be resumed.');
				}

				if (offset === 0) {
					setMessages(result.messages);
					// Scroll to bottom after initial load and focus the container for keyboard nav
					requestAnimationFrame(() => {
						if (isCurrent() && messagesContainerRef.current) {
							messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
							messagesContainerRef.current.focus();
						}
					});
				} else {
					// Prepend older messages
					setMessages((prev) => [...result.messages, ...prev]);
				}
				setTotalMessages(result.total);
				setHasMoreMessages(result.hasMore);
				setMessagesOffset(offset + result.messages.length);
			} catch (error) {
				if (!isCurrent()) return;
				clearViewingSession();
				setReadError('History could not be read. Select the session to retry.');
				logger.error('Failed to load messages:', undefined, error);
			} finally {
				if (isCurrent()) setMessagesLoading(false);
			}
		},
		[cwd, agentId, sshRemoteId, ownerAgentId, scopeKey, selectionKey, clearViewingSession]
	);

	/**
	 * Start viewing a session - resets state and loads messages
	 */
	const handleViewSession = useCallback(
		(session: AgentSession) => {
			void loadMessages(session, 0);
		},
		[loadMessages]
	);

	/**
	 * Load more (older) messages
	 */
	const handleLoadMore = useCallback(() => {
		if (viewingSession && hasMoreMessages && !messagesLoading) {
			loadMessages(viewingSession, messagesOffset);
		}
	}, [viewingSession, hasMoreMessages, messagesLoading, messagesOffset, loadMessages]);

	/**
	 * Handle scroll event for infinite loading
	 * Loads more messages when scrolled near the top
	 */
	const handleMessagesScroll = useCallback(() => {
		const container = messagesContainerRef.current;
		if (!container) return;

		// Load more when scrolled near top
		if (container.scrollTop < 100 && hasMoreMessages && !messagesLoading) {
			const prevScrollHeight = container.scrollHeight;
			handleLoadMore();
			const request = requestRef.current;

			// Maintain scroll position after loading
			requestAnimationFrame(() => {
				if (scopeRef.current === scopeKey && requestRef.current === request) {
					container.scrollTop = container.scrollHeight - prevScrollHeight;
				}
			});
		}
	}, [hasMoreMessages, messagesLoading, handleLoadMore, scopeKey]);

	return {
		viewingSession: viewScope === scopeKey ? viewingSession : null,
		messages: viewScope === scopeKey ? messages : [],
		messagesLoading: viewScope === scopeKey && messagesLoading,
		readError: viewScope === scopeKey ? readError : null,
		hasMoreMessages: viewScope === scopeKey && hasMoreMessages,
		totalMessages: viewScope === scopeKey ? totalMessages : 0,
		messagesOffset: viewScope === scopeKey ? messagesOffset : 0,
		messagesContainerRef,
		loadMessages,
		handleViewSession,
		handleLoadMore,
		handleMessagesScroll,
		clearViewingSession,
		setViewingSession,
	};
}
