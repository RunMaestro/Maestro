import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
	Search,
	Clock,
	MessageSquare,
	HardDrive,
	Play,
	ChevronLeft,
	Loader2,
	Star,
} from 'lucide-react';
import type { Theme, Session } from '../types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { useListNavigation } from '../hooks';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { formatSize, formatRelativeTime } from '../utils/formatters';
import { ToolCallCard } from './ToolCallCard';

interface AgentSession {
	sessionId: string;
	projectPath: string;
	timestamp: string;
	modifiedAt: string;
	firstMessage: string;
	messageCount: number;
	sizeBytes: number;
	sessionName?: string; // Named session from Maestro
	starred?: boolean; // Starred status from Maestro
}

interface SessionMessage {
	type: string;
	role?: string;
	content: string;
	timestamp: string;
	uuid: string;
	toolUse?: any;
}

interface AgentSessionsModalProps {
	theme: Theme;
	activeSession: Session | undefined;
	onClose: () => void;
	onResumeSession: (agentSessionId: string) => void;
}

export function AgentSessionsModal({
	theme,
	activeSession,
	onClose,
	onResumeSession,
}: AgentSessionsModalProps) {
	// Get agentId from the active session's toolType
	const agentId = activeSession?.toolType || 'claude-code';
	const [sessions, setSessions] = useState<AgentSession[]>([]);
	const [loading, setLoading] = useState(true);
	const [search, setSearch] = useState('');
	const [viewingSession, setViewingSession] = useState<AgentSession | null>(null);
	const [messages, setMessages] = useState<SessionMessage[]>([]);
	const [messagesLoading, setMessagesLoading] = useState(false);
	const [hasMoreMessages, setHasMoreMessages] = useState(false);
	const [totalMessages, setTotalMessages] = useState(0);
	const [messagesOffset, setMessagesOffset] = useState(0);
	const [starredSessions, setStarredSessions] = useState<Set<string>>(new Set());

	// Pagination state for sessions list
	const [hasMoreSessions, setHasMoreSessions] = useState(false);
	const [isLoadingMoreSessions, setIsLoadingMoreSessions] = useState(false);
	const [totalSessionCount, setTotalSessionCount] = useState(0);
	const nextCursorRef = useRef<string | null>(null);

	const inputRef = useRef<HTMLInputElement>(null);
	const selectedItemRef = useRef<HTMLButtonElement>(null);
	const messagesContainerRef = useRef<HTMLDivElement>(null);
	const sessionsContainerRef = useRef<HTMLDivElement>(null);
	const layerIdRef = useRef<string>();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();

	// Register layer on mount
	useEffect(() => {
		layerIdRef.current = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.AGENT_SESSIONS,
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'strict',
			ariaLabel: 'Agent Sessions',
			onEscape: () => {
				if (viewingSession) {
					setViewingSession(null);
					setMessages([]);
				} else {
					onCloseRef.current();
				}
			},
		});

		return () => {
			if (layerIdRef.current) {
				unregisterLayer(layerIdRef.current);
			}
		};
	}, [registerLayer, unregisterLayer]);

	// Update handler when viewingSession changes
	useEffect(() => {
		if (layerIdRef.current) {
			updateLayerHandler(layerIdRef.current, () => {
				if (viewingSession) {
					setViewingSession(null);
					setMessages([]);
				} else {
					onCloseRef.current();
				}
			});
		}
	}, [viewingSession, updateLayerHandler]);

	// Load sessions on mount and reset to list view
	useEffect(() => {
		// Always reset to list view when modal opens
		setViewingSession(null);
		setMessages([]);
		setMessagesOffset(0);
		setSessions([]);
		setHasMoreSessions(false);
		setTotalSessionCount(0);
		nextCursorRef.current = null;

		const loadSessions = async () => {
			if (!activeSession?.cwd) {
				console.log('AgentSessionsModal: No activeSession.cwd');
				setLoading(false);
				return;
			}

			const agentId = activeSession.toolType || 'claude-code';
			// Use projectRoot (not cwd) for consistent session storage access
			const projectPath = activeSession.projectRoot;
			console.log(
				'AgentSessionsModal: Loading sessions for projectPath:',
				projectPath,
				'agentId:',
				agentId
			);
			try {
				// Load starred sessions from session origins (shared with AgentSessionsBrowser)
				const starredFromOrigins = new Set<string>();
				if (agentId === 'claude-code') {
					// Claude Code uses its own origins store
					const origins = await window.maestro.claude.getSessionOrigins(projectPath);
					for (const [sessionId, originData] of Object.entries(origins)) {
						if (typeof originData === 'object' && originData?.starred) {
							starredFromOrigins.add(sessionId);
						}
					}
				} else {
					// Other agents use the generic origins store
					const origins = await window.maestro.agentSessions.getOrigins(agentId, projectPath);
					for (const [sessionId, originData] of Object.entries(origins)) {
						if (originData?.starred) {
							starredFromOrigins.add(sessionId);
						}
					}
				}
				setStarredSessions(starredFromOrigins);

				// Use generic agentSessions API for session listing
				const result = await window.maestro.agentSessions.listPaginated(agentId, projectPath, {
					limit: 100,
				});
				console.log(
					'AgentSessionsModal: Got sessions:',
					result.sessions.length,
					'of',
					result.totalCount
				);
				setSessions(result.sessions);
				setHasMoreSessions(result.hasMore);
				setTotalSessionCount(result.totalCount);
				nextCursorRef.current = result.nextCursor;
			} catch (error) {
				console.error('Failed to load sessions:', error);
			} finally {
				setLoading(false);
			}
		};

		loadSessions();
	}, [activeSession?.projectRoot, activeSession?.toolType]);

	// Load more sessions when scrolling near bottom
	const loadMoreSessions = useCallback(async () => {
		// Use projectRoot (not cwd) for consistent session storage access
		if (
			!activeSession?.projectRoot ||
			!hasMoreSessions ||
			isLoadingMoreSessions ||
			!nextCursorRef.current
		)
			return;

		const agentId = activeSession.toolType || 'claude-code';
		setIsLoadingMoreSessions(true);
		try {
			const result = await window.maestro.agentSessions.listPaginated(
				agentId,
				activeSession.projectRoot,
				{
					cursor: nextCursorRef.current,
					limit: 100,
				}
			);

			// Append new sessions, avoiding duplicates
			setSessions((prev) => {
				const existingIds = new Set(prev.map((s) => s.sessionId));
				const newSessions = result.sessions.filter((s) => !existingIds.has(s.sessionId));
				return [...prev, ...newSessions];
			});
			setHasMoreSessions(result.hasMore);
			nextCursorRef.current = result.nextCursor;
		} catch (error) {
			console.error('Failed to load more sessions:', error);
		} finally {
			setIsLoadingMoreSessions(false);
		}
	}, [activeSession?.projectRoot, activeSession?.toolType, hasMoreSessions, isLoadingMoreSessions]);

	// Handle scroll for sessions list pagination - load more at 70% scroll
	const handleSessionsScroll = useCallback(() => {
		const container = sessionsContainerRef.current;
		if (!container) return;

		const { scrollTop, scrollHeight, clientHeight } = container;
		const scrollPercentage = (scrollTop + clientHeight) / scrollHeight;
		const atSeventyPercent = scrollPercentage >= 0.7;

		if (atSeventyPercent && hasMoreSessions && !isLoadingMoreSessions) {
			loadMoreSessions();
		}
	}, [hasMoreSessions, isLoadingMoreSessions, loadMoreSessions]);

	// Toggle star status for a session
	const toggleStar = useCallback(
		async (sessionId: string, e: React.MouseEvent) => {
			e.stopPropagation(); // Don't trigger session view

			const newStarred = new Set(starredSessions);
			const isNowStarred = !newStarred.has(sessionId);
			if (isNowStarred) {
				newStarred.add(sessionId);
			} else {
				newStarred.delete(sessionId);
			}
			setStarredSessions(newStarred);

			// Persist to session origins (shared with AgentSessionsBrowser)
			// Use projectRoot (not cwd) for consistent session storage access
			if (activeSession?.projectRoot) {
				if (agentId === 'claude-code') {
					// Claude Code uses its own origins store
					await window.maestro.claude.updateSessionStarred(
						activeSession.projectRoot,
						sessionId,
						isNowStarred
					);
				} else {
					// Other agents use the generic origins store
					await window.maestro.agentSessions.setSessionStarred(
						agentId,
						activeSession.projectRoot,
						sessionId,
						isNowStarred
					);
				}
			}
		},
		[starredSessions, activeSession?.projectRoot, agentId]
	);

	// Focus input on mount
	useEffect(() => {
		const timer = setTimeout(() => inputRef.current?.focus(), 50);
		return () => clearTimeout(timer);
	}, []);

	// Load messages when viewing a session
	const loadMessages = useCallback(
		async (session: AgentSession, offset: number = 0) => {
			if (!activeSession?.cwd) return;

			const agentId = activeSession.toolType || 'claude-code';
			setMessagesLoading(true);
			try {
				const result = await window.maestro.agentSessions.read(
					agentId,
					activeSession.cwd,
					session.sessionId,
					{ offset, limit: 20 }
				);

				if (offset === 0) {
					setMessages(result.messages);
				} else {
					// Prepend older messages
					setMessages((prev) => [...result.messages, ...prev]);
				}
				setTotalMessages(result.total);
				setHasMoreMessages(result.hasMore);
				setMessagesOffset(offset + result.messages.length);
			} catch (error) {
				console.error('Failed to load messages:', error);
			} finally {
				setMessagesLoading(false);
			}
		},
		[activeSession?.cwd, activeSession?.toolType]
	);

	// Handle viewing a session
	const handleViewSession = useCallback(
		(session: AgentSession) => {
			setViewingSession(session);
			setMessages([]);
			setMessagesOffset(0);
			loadMessages(session, 0);
		},
		[loadMessages]
	);

	// Handle loading more messages (scroll to top)
	const handleLoadMore = useCallback(() => {
		if (viewingSession && hasMoreMessages && !messagesLoading) {
			loadMessages(viewingSession, messagesOffset);
		}
	}, [viewingSession, hasMoreMessages, messagesLoading, messagesOffset, loadMessages]);

	// Handle scroll for lazy loading
	const handleMessagesScroll = useCallback(() => {
		const container = messagesContainerRef.current;
		if (!container) return;

		// Load more when scrolled near top
		if (container.scrollTop < 100 && hasMoreMessages && !messagesLoading) {
			const prevScrollHeight = container.scrollHeight;
			handleLoadMore();

			// Maintain scroll position after loading
			requestAnimationFrame(() => {
				if (container) {
					container.scrollTop = container.scrollHeight - prevScrollHeight;
				}
			});
		}
	}, [hasMoreMessages, messagesLoading, handleLoadMore]);

	// Filter sessions by search and sort starred to top
	const filteredSessions = sessions
		.filter(
			(s) =>
				s.sessionName?.toLowerCase().includes(search.toLowerCase()) ||
				s.firstMessage.toLowerCase().includes(search.toLowerCase()) ||
				s.sessionId.toLowerCase().includes(search.toLowerCase())
		)
		.sort((a, b) => {
			const aStarred = starredSessions.has(a.sessionId);
			const bStarred = starredSessions.has(b.sessionId);
			if (aStarred && !bStarred) return -1;
			if (!aStarred && bStarred) return 1;
			// Within same starred status, sort by most recent
			return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
		});

	// Handle selection by index - opens session view
	const handleSelectByIndex = useCallback(
		(index: number) => {
			const selected = filteredSessions[index];
			if (selected) {
				handleViewSession(selected);
			}
		},
		[filteredSessions, handleViewSession]
	);

	// Keyboard navigation using useListNavigation hook
	const {
		selectedIndex,
		handleKeyDown: listHandleKeyDown,
		resetSelection,
	} = useListNavigation({
		listLength: filteredSessions.length,
		onSelect: handleSelectByIndex,
		enabled: !viewingSession, // Disable navigation when viewing session messages
	});

	// Scroll selected item into view
	useEffect(() => {
		selectedItemRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	}, [selectedIndex]);

	// Reset selection when search changes
	useEffect(() => {
		resetSelection();
	}, [search, resetSelection]);

	// Wrap keyboard handler to pass through to search input
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			// Let the hook handle navigation
			listHandleKeyDown(e);
		},
		[listHandleKeyDown]
	);

	// Handle resume session
	const handleResume = useCallback(() => {
		if (viewingSession) {
			onResumeSession(viewingSession.sessionId);
			onClose();
		}
	}, [viewingSession, onResumeSession, onClose]);

	// formatSize and formatRelativeTime imported from ../utils/formatters

	return (
		<div className="fixed inset-0 modal-overlay flex items-start justify-center pt-24 z-[9999] animate-in fade-in duration-100">
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Agent Sessions"
				tabIndex={-1}
				className="w-[700px] rounded-xl shadow-2xl border overflow-hidden flex flex-col max-h-[600px] outline-none"
				style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }}
			>
				{/* Header */}
				<div
					className="p-4 border-b flex items-center gap-3"
					style={{ borderColor: theme.colors.border }}
				>
					{viewingSession ? (
						<>
							<button
								onClick={() => {
									setViewingSession(null);
									setMessages([]);
								}}
								className="p-1 rounded hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textDim }}
							>
								<ChevronLeft className="w-5 h-5" />
							</button>
							<div className="flex-1 min-w-0">
								<div
									className="text-sm font-medium truncate"
									style={{ color: theme.colors.textMain }}
								>
									{viewingSession.sessionName || viewingSession.firstMessage || 'Session Preview'}
								</div>
								<div className="text-xs" style={{ color: theme.colors.textDim }}>
									{totalMessages} messages • {formatRelativeTime(viewingSession.modifiedAt)}
								</div>
							</div>
							<button
								onClick={handleResume}
								className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
								style={{
									backgroundColor: theme.colors.accent,
									color: theme.colors.accentForeground,
								}}
							>
								<Play className="w-4 h-4" />
								Resume
							</button>
						</>
					) : (
						<>
							<Search className="w-5 h-5" style={{ color: theme.colors.textDim }} />
							<input
								ref={inputRef}
								className="flex-1 bg-transparent outline-none text-lg placeholder-opacity-50"
								placeholder={`Search ${activeSession?.name || 'agent'} sessions...`}
								style={{ color: theme.colors.textMain }}
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								onKeyDown={handleKeyDown}
							/>
							<div
								className="px-2 py-0.5 rounded text-xs font-bold"
								style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textDim }}
							>
								ESC
							</div>
						</>
					)}
				</div>

				{/* Content */}
				{viewingSession ? (
					<div
						ref={messagesContainerRef}
						className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin"
						onScroll={handleMessagesScroll}
					>
						{/* Load more indicator */}
						{hasMoreMessages && (
							<div className="text-center py-2">
								{messagesLoading ? (
									<Loader2
										className="w-5 h-5 animate-spin mx-auto"
										style={{ color: theme.colors.textDim }}
									/>
								) : (
									<button
										onClick={handleLoadMore}
										className="text-sm hover:underline"
										style={{ color: theme.colors.accent }}
									>
										Load earlier messages...
									</button>
								)}
							</div>
						)}

						{/* Messages */}
						{messages.map((msg, idx) => (
							<div
								key={msg.uuid || idx}
								className={`flex ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}
							>
								{/* Tool call messages - render with ToolCallCard */}
								{msg.toolUse && msg.toolUse.length > 0 ? (
									<div className="max-w-[85%]">
										<ToolCallCard
											theme={theme}
											toolUse={msg.toolUse}
											timestamp={formatRelativeTime(msg.timestamp)}
											defaultExpanded={false}
										/>
									</div>
								) : (
									/* Regular text messages */
									<div
										className="max-w-[85%] rounded-lg px-4 py-2 text-sm"
										style={{
											backgroundColor:
												msg.type === 'user' ? theme.colors.accent : theme.colors.bgMain,
											color:
												msg.type === 'user'
													? theme.mode === 'light'
														? '#fff'
														: '#000'
													: theme.colors.textMain,
										}}
									>
										<div className="whitespace-pre-wrap break-words">
											{msg.content || '[No content]'}
										</div>
										<div
											className="text-[10px] mt-1 opacity-60"
											style={{
												color:
													msg.type === 'user'
														? theme.mode === 'light'
															? '#fff'
															: '#000'
														: theme.colors.textDim,
											}}
										>
											{formatRelativeTime(msg.timestamp)}
										</div>
									</div>
								)}
							</div>
						))}

						{messagesLoading && messages.length === 0 && (
							<div className="flex items-center justify-center py-8">
								<Loader2 className="w-6 h-6 animate-spin" style={{ color: theme.colors.textDim }} />
							</div>
						)}
					</div>
				) : (
					<div
						ref={sessionsContainerRef}
						className="overflow-y-auto py-2 flex-1 scrollbar-thin"
						onScroll={handleSessionsScroll}
					>
						{loading ? (
							<div className="flex items-center justify-center py-8">
								<Loader2 className="w-6 h-6 animate-spin" style={{ color: theme.colors.textDim }} />
							</div>
						) : filteredSessions.length === 0 ? (
							<div className="px-4 py-8 text-center" style={{ color: theme.colors.textDim }}>
								{sessions.length === 0
									? 'No Claude sessions found for this project'
									: 'No sessions match your search'}
							</div>
						) : (
							<>
								{filteredSessions.map((session, i) => {
									const isStarred = starredSessions.has(session.sessionId);
									return (
										<button
											key={session.sessionId}
											ref={i === selectedIndex ? selectedItemRef : null}
											onClick={() => handleViewSession(session)}
											className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-opacity-10 transition-colors group"
											style={{
												backgroundColor: i === selectedIndex ? theme.colors.accent : 'transparent',
												color: theme.colors.textMain,
											}}
										>
											{/* Star button */}
											<button
												onClick={(e) => toggleStar(session.sessionId, e)}
												className="p-1 -ml-1 rounded hover:bg-white/10 transition-colors shrink-0"
												title={isStarred ? 'Remove from favorites' : 'Add to favorites'}
											>
												<Star
													className="w-4 h-4"
													style={{
														color: isStarred ? theme.colors.warning : theme.colors.textDim,
														fill: isStarred ? theme.colors.warning : 'transparent',
													}}
												/>
											</button>
											<div className="flex-1 min-w-0">
												<div className="font-medium truncate text-sm">
													{session.sessionName ||
														session.firstMessage ||
														`Session ${session.sessionId.slice(0, 8)}...`}
												</div>
												<div
													className="flex items-center gap-3 mt-1 text-xs"
													style={{ color: theme.colors.textDim }}
												>
													<span className="flex items-center gap-1">
														<Clock className="w-3 h-3" />
														{formatRelativeTime(session.modifiedAt)}
													</span>
													<span className="flex items-center gap-1">
														<MessageSquare className="w-3 h-3" />
														{session.messageCount} msgs
													</span>
													<span className="flex items-center gap-1">
														<HardDrive className="w-3 h-3" />
														{formatSize(session.sizeBytes)}
													</span>
												</div>
											</div>
										</button>
									);
								})}
								{/* Pagination indicator */}
								{(isLoadingMoreSessions || hasMoreSessions) && !search && (
									<div className="py-3 flex justify-center items-center">
										{isLoadingMoreSessions ? (
											<div className="flex items-center gap-2">
												<Loader2
													className="w-4 h-4 animate-spin"
													style={{ color: theme.colors.accent }}
												/>
												<span className="text-xs" style={{ color: theme.colors.textDim }}>
													Loading more sessions...
												</span>
											</div>
										) : (
											<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
												{sessions.length} of {totalSessionCount} sessions loaded
											</span>
										)}
									</div>
								)}
							</>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
