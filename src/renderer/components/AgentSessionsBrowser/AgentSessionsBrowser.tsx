import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { useFocusAfterRender } from '../../hooks/utils/useFocusAfterRender';
import { useCommandKeyShortcut } from '../../hooks/keyboard/useCommandKeyShortcut';
import {
	useSessionViewer,
	useSessionPagination,
	useFilteredAndSortedSessions,
	useClickOutside,
} from '../../hooks';
import type { AgentSessionsBrowserProps } from './types';
import { resolveSessionProjectPath } from './utils/sessionProjectPath';
import { useAgentSessionsAggregateStats } from './hooks/useAgentSessionsAggregateStats';
import { useAgentSessionsSearch } from './hooks/useAgentSessionsSearch';
import { useAgentSessionsRename } from './hooks/useAgentSessionsRename';
import { useAgentSessionsStar } from './hooks/useAgentSessionsStar';
import { useAgentSessionsAutoView } from './hooks/useAgentSessionsAutoView';
import { useAgentSessionsActivityEntries } from './hooks/useAgentSessionsActivityEntries';
import { useAgentSessionsResume } from './hooks/useAgentSessionsResume';
import { useAgentSessionsFocusRestore } from './hooks/useAgentSessionsFocusRestore';
import { SessionListHeader } from './components/SessionListHeader';
import { SessionDetailHeader } from './components/SessionDetailHeader';
import { SessionDetailStatsPanel } from './components/SessionDetailStatsPanel';
import { SessionMessagesView } from './components/SessionMessagesView';
import { SessionListStatsBar } from './components/SessionListStatsBar';
import { SessionSearchBar } from './components/SessionSearchBar';
import { SessionListView } from './components/SessionListView';
import type { SearchMode } from './types';
import { FIXED_SHORTCUTS } from '../../constants/shortcuts';
import { eventMatchesShortcutKeys } from '../../utils/shortcutMatch';
import { trackShortcutUsage } from '../../utils/shortcutTracking';
import { matchesNativeSessionBinding, resumeSelectionKey } from '../../services/resumableSession';
import { useSessionStore } from '../../stores/sessionStore';

export function AgentSessionsBrowser(props: AgentSessionsBrowserProps) {
	const selectionKey = props.activeSession ? resumeSelectionKey(props.activeSession) : '';
	// The private key includes environment values. Only the numeric generation
	// goes into React's key; remounting also invalidates list/search pagination.
	const scope = useRef({ selectionKey, generation: 0 });
	if (scope.current.selectionKey !== selectionKey) {
		scope.current = { selectionKey, generation: scope.current.generation + 1 };
	}
	return (
		<ScopedAgentSessionsBrowser
			key={scope.current.generation}
			{...props}
			selectionKey={selectionKey}
		/>
	);
}

function ScopedAgentSessionsBrowser({
	theme,
	activeSession,
	activeAgentSessionId,
	onClose,
	onResumeSession,
	onNewSession,
	onUpdateTab,
	selectionKey,
}: AgentSessionsBrowserProps & { selectionKey: string }) {
	const agentId = activeSession?.toolType || 'claude-code';
	const { projectPathForSessions, sshRemoteId } = resolveSessionProjectPath(activeSession);

	const {
		viewingSession,
		messages,
		messagesLoading,
		readError,
		hasMoreMessages,
		totalMessages,
		messagesContainerRef,
		handleViewSession,
		handleLoadMore,
		handleMessagesScroll,
		clearViewingSession,
		setViewingSession,
	} = useSessionViewer({
		cwd: projectPathForSessions,
		agentId,
		sshRemoteId,
		ownerAgentId: activeSession?.id,
		selectionKey,
	});

	const { starredSessions, setStarredSessions, toggleStar } = useAgentSessionsStar({
		activeSession,
		agentId,
		onUpdateTab,
	});

	const {
		sessions,
		loading,
		hasMoreSessions,
		isLoadingMoreSessions,
		totalSessionCount,
		handleSessionsScroll,
		sessionsContainerRef,
		updateSession,
	} = useSessionPagination({
		projectPath: projectPathForSessions,
		agentId,
		onStarredSessionsLoaded: setStarredSessions,
		sshRemoteId,
		ownerAgentId: activeSession?.id,
	});

	const [search, setSearch] = useState('');
	const [searchMode, setSearchMode] = useState<SearchMode>('all');
	const [showAllSessions, setShowAllSessions] = useState(false);
	const [namedOnly, setNamedOnly] = useState(false);
	const [searchModeDropdownOpen, setSearchModeDropdownOpen] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [showSearchPanel, setShowSearchPanel] = useState(true);
	const [graphLookbackHours, setGraphLookbackHours] = useState<number | null>(null);
	const [resumeError, setResumeError] = useState<string | null>(null);

	// Refs shared by multiple consumers - owned by shell
	const inputRef = useRef<HTMLInputElement>(null);
	const renameInputRef = useRef<HTMLInputElement>(null);
	const selectedItemRef = useRef<HTMLButtonElement | HTMLDivElement | null>(null);
	const searchModeDropdownRef = useRef<HTMLDivElement>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const viewingSessionRef = useRef(viewingSession);
	viewingSessionRef.current = viewingSession;

	const handleSearchChange = useCallback((value: string) => {
		setSearch(value);
		setSelectedIndex(0);
	}, []);

	const { stats } = useAgentSessionsAggregateStats({
		projectRoot: activeSession?.projectRoot,
		projectPathForSessions,
		agentId,
		sessions,
		loading,
		hasMoreSessions,
	});

	const { searchResults, isSearching } = useAgentSessionsSearch({
		search,
		searchMode,
		projectPathForSessions,
		agentId,
		sshRemoteId,
	});

	const {
		renamingSessionId,
		renameValue,
		setRenameValue,
		setRenamingSessionId,
		beginRename,
		startRename,
		submitRename,
		cancelRename,
		consumeFocusRestore,
	} = useAgentSessionsRename({
		activeSession,
		agentId,
		viewingSession,
		setViewingSession,
		updateSession,
		onUpdateTab,
		renameInputRef,
	});

	// The rename input takes the keyboard as soon as it mounts, whichever way the
	// rename started (edit button, detail header, or the shortcut).
	useFocusAfterRender(renameInputRef, !!renamingSessionId);

	/**
	 * ...and hands it back on the way out, to whichever element hosts the keys
	 * on the surface we return to: the search input in the list view (Up/Down
	 * and Enter live on it), the message pane in the detail view (Enter to
	 * resume). Without this the caret lands on <body> and the browser stops
	 * answering the keyboard entirely.
	 *
	 * A layout effect, not a timer: this must run in the commit that unmounts
	 * the rename input, so focusing the new target cannot fire the old input's
	 * onBlur and submit a name the user just escaped out of.
	 */
	useLayoutEffect(() => {
		if (renamingSessionId || !consumeFocusRestore()) return;
		const target = viewingSessionRef.current ? messagesContainerRef.current : inputRef.current;
		target?.focus();
	}, [renamingSessionId, consumeFocusRestore, messagesContainerRef, inputRef]);

	// useFilteredAndSortedSessions MUST run before useAgentSessionsActivityEntries
	// because activityEntries reads filteredSessions
	const { filteredSessions, getSearchResultInfo } = useFilteredAndSortedSessions({
		sessions,
		search,
		searchMode,
		searchResults,
		isSearching,
		starredSessions,
		showAllSessions,
		namedOnly,
	});

	const { activityEntries } = useAgentSessionsActivityEntries({
		namedOnly,
		showAllSessions,
		showSearchPanel,
		filteredSessions,
	});

	const resumeSelectedSession = useCallback<AgentSessionsBrowserProps['onResumeSession']>(
		(id, logs, name, starred, usage, projectPath, opts) => {
			const binding = viewingSession?.nativeSessionBinding;
			const ownerAgentId = viewingSession?.ownerAgentId ?? activeSession?.id;
			if (
				(opts?.targetSessionId !== undefined && opts.targetSessionId !== ownerAgentId) ||
				(projectPath !== undefined && projectPath !== projectPathForSessions) ||
				(opts?.nativeSessionBinding !== undefined &&
					!matchesNativeSessionBinding(opts.nativeSessionBinding, binding))
			) {
				setResumeError('History ownership changed. Select the session again.');
				return false;
			}
			if (
				agentId === 'grok' &&
				(viewingSession?.sessionId !== id ||
					viewingSession.ownerAgentId !== activeSession?.id ||
					viewingSession.transcriptSource?.status !== 'available' ||
					!matchesNativeSessionBinding(binding, binding))
			) {
				setResumeError('Open this session and wait for verified history before resuming.');
				return false;
			}
			return onResumeSession(id, logs, name, starred, usage, projectPathForSessions, {
				...opts,
				targetSessionId: ownerAgentId,
				...(binding ? { nativeSessionBinding: structuredClone(binding) } : {}),
			});
		},
		[agentId, viewingSession, activeSession?.id, onResumeSession, projectPathForSessions]
	);

	const { handleResume: resumeViewed, handleQuickResume: quickResume } = useAgentSessionsResume({
		viewingSession,
		messages,
		starredSessions,
		onResumeSession: resumeSelectedSession,
		onClose,
	});
	const selectionIsCurrent = useCallback(() => {
		const owner = useSessionStore.getState().sessions.find((s) => s.id === activeSession?.id);
		if (!owner || resumeSelectionKey(owner) !== selectionKey) {
			clearViewingSession();
			setResumeError('The selected agent changed. Select its history again.');
			return false;
		}
		return true;
	}, [activeSession?.id, selectionKey, clearViewingSession]);
	const handleResume = useCallback(() => {
		if (!selectionIsCurrent()) return;
		if (
			agentId === 'grok' &&
			(messagesLoading ||
				viewingSession?.ownerAgentId !== activeSession?.id ||
				viewingSession?.transcriptSource?.status !== 'available' ||
				!matchesNativeSessionBinding(
					viewingSession?.nativeSessionBinding,
					viewingSession?.nativeSessionBinding
				))
		) {
			setResumeError('Open this session and wait for verified history before resuming.');
			return;
		}
		setResumeError(null);
		resumeViewed();
	}, [
		selectionIsCurrent,
		agentId,
		messagesLoading,
		viewingSession,
		activeSession?.id,
		resumeViewed,
	]);
	const handleQuickResume = useCallback<typeof quickResume>(
		(session, event) => {
			event.stopPropagation();
			if (!selectionIsCurrent()) return;
			if (agentId === 'grok') {
				// A list row and its display messages do not prove native ownership.
				// Obtain an observed receipt first; the user can then choose Resume.
				setResumeError('Verify this session, then choose Resume.');
				handleViewSession(session);
				return;
			}
			quickResume(session, event);
		},
		[selectionIsCurrent, agentId, handleViewSession, quickResume]
	);

	// Cmd/Ctrl+R fires the detail view's Resume button, the same chord the Usage
	// Dashboard claims for its own refresh. It is safe to take here because the
	// app-level Cmd+R (read-only toggle) is already blocked behind
	// `hasOpenModal()` while this browser is registered as a layer, and the
	// capture-phase listener also beats the browser's own reload default. Off
	// while a rename is in flight: resuming would close the browser and discard
	// the name the user is mid-way through typing.
	useCommandKeyShortcut('r', handleResume, !!viewingSession && !renamingSessionId);

	useAgentSessionsAutoView({
		loading,
		sessions,
		activeAgentSessionId,
		viewingSession,
		handleViewSession,
	});

	useAgentSessionsFocusRestore({
		viewingSession,
		inputRef,
		selectedItemRef: selectedItemRef as React.RefObject<HTMLButtonElement | null>,
	});

	useModalLayer(
		MODAL_PRIORITIES.AGENT_SESSIONS,
		'Agent Sessions Browser',
		() => {
			// The layer stack handles Escape at capture on window, so the rename
			// input never sees the key - cancel an in-progress rename here first,
			// or renaming a session and pressing Escape closes the whole browser.
			if (renamingSessionId) {
				cancelRename();
			} else if (viewingSessionRef.current) {
				clearViewingSession();
			} else {
				onCloseRef.current();
			}
		},
		{ focusTrap: 'lenient' }
	);

	// Reset to list view on mount
	useEffect(() => {
		clearViewingSession();
	}, [clearViewingSession]);

	// Focus input on mount
	useEffect(() => {
		const timer = setTimeout(() => inputRef.current?.focus(), 50);
		return () => clearTimeout(timer);
	}, []);

	// Scroll selected item into view on index change
	useEffect(() => {
		selectedItemRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	}, [selectedIndex]);

	useClickOutside(
		searchModeDropdownRef,
		() => setSearchModeDropdownOpen(false),
		searchModeDropdownOpen
	);

	// Cmd+F opens search panel (only when in list view and panel is closed)
	useEventListener(
		'keydown',
		(e: Event) => {
			const ke = e as KeyboardEvent;
			if (!viewingSession && !showSearchPanel && (ke.metaKey || ke.ctrlKey) && ke.key === 'f') {
				ke.preventDefault();
				setShowSearchPanel(true);
				setTimeout(() => inputRef.current?.focus(), 50);
			}
		},
		{ target: document }
	);

	/**
	 * Cmd/Ctrl+E renames the session in focus - the highlighted row in the list,
	 * or the one being viewed in the detail pane.
	 *
	 * Bound here rather than left to the global handler because this browser
	 * registers as a modal layer that blocks lower layers, so the app-level
	 * shortcut never reaches its own handler while the browser is up.
	 */
	useEventListener(
		'keydown',
		(event: Event) => {
			const e = event as KeyboardEvent;
			if (renamingSessionId) return;
			if (!eventMatchesShortcutKeys(e, FIXED_SHORTCUTS.renameAgentSession.keys)) return;
			const target = viewingSession ?? filteredSessions[selectedIndex];
			if (!target) return;
			e.preventDefault();
			e.stopPropagation();
			trackShortcutUsage('renameAgentSession');
			beginRename(target);
		},
		{ target: document }
	);

	const sessionSinceDate =
		typeof activeSession?.createdAt === 'number' && activeSession.createdAt > 0
			? new Date(activeSession.createdAt)
			: stats.oldestSession;

	const handleGraphBarClick = useCallback(
		(bucketStart: number, bucketEnd: number) => {
			const sessionInBucket = filteredSessions.find((s) => {
				const timestamp = new Date(s.modifiedAt).getTime();
				return timestamp >= bucketStart && timestamp < bucketEnd;
			});
			if (sessionInBucket) {
				const index = filteredSessions.findIndex((s) => s.sessionId === sessionInBucket.sessionId);
				if (index !== -1) {
					setSelectedIndex(index);
					setTimeout(() => {
						selectedItemRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
					}, 50);
				}
			}
		},
		[filteredSessions]
	);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (viewingSession) {
			if (e.key === 'Enter') {
				e.preventDefault();
				handleResume();
			}
			return;
		}
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			setSelectedIndex((prev) => Math.min(prev + 1, filteredSessions.length - 1));
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			setSelectedIndex((prev) => Math.max(prev - 1, 0));
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const selected = filteredSessions[selectedIndex];
			if (selected) handleViewSession(selected);
		}
	};

	return (
		<div className="flex-1 flex flex-col h-full" style={{ backgroundColor: theme.colors.bgMain }}>
			<div
				className="h-16 border-b flex items-center justify-between px-6 shrink-0"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
			>
				{viewingSession ? (
					<SessionDetailHeader
						viewingSession={viewingSession}
						totalMessages={totalMessages}
						isStarred={starredSessions.has(viewingSession.sessionId)}
						renamingSessionId={renamingSessionId}
						renameValue={renameValue}
						renameInputRef={renameInputRef}
						theme={theme}
						onClearViewingSession={clearViewingSession}
						onToggleStar={toggleStar}
						onResume={handleResume}
						onClose={onClose}
						onRenameChange={setRenameValue}
						onRenameKeyDown={(e) => {
							e.stopPropagation();
							if (e.key === 'Enter') {
								e.preventDefault();
								submitRename(viewingSession.sessionId);
							} else if (e.key === 'Escape') {
								e.preventDefault();
								cancelRename();
							}
						}}
						onRenameBlur={() => submitRename(viewingSession.sessionId)}
						onStartRenameNamed={(e) => {
							e.stopPropagation();
							beginRename(viewingSession);
						}}
						onStartRenameUnnamed={(e) => {
							e.stopPropagation();
							setRenamingSessionId(viewingSession.sessionId);
							setRenameValue('');
						}}
					/>
				) : (
					<SessionListHeader
						agentId={agentId}
						sessionName={activeSession?.name}
						activeAgentSessionId={activeAgentSessionId}
						theme={theme}
						onNewSession={onNewSession}
						onClose={onClose}
					/>
				)}
			</div>

			{(readError || resumeError) && (
				<div role="status" className="px-6 py-2 text-sm" style={{ color: theme.colors.textDim }}>
					{readError || resumeError}
				</div>
			)}

			{viewingSession ? (
				<div className="flex-1 flex flex-col overflow-hidden">
					<SessionDetailStatsPanel viewingSession={viewingSession} theme={theme} />
					<SessionMessagesView
						messages={messages}
						messagesLoading={messagesLoading}
						hasMoreMessages={hasMoreMessages}
						theme={theme}
						messagesContainerRef={messagesContainerRef}
						onScroll={handleMessagesScroll}
						onKeyDown={handleKeyDown}
						handleLoadMore={handleLoadMore}
					/>
				</div>
			) : (
				<div className="flex-1 flex flex-col overflow-hidden">
					<SessionListStatsBar
						loading={loading}
						sessionsCount={sessions.length}
						stats={stats}
						sessionSinceDate={sessionSinceDate}
						theme={theme}
					/>
					<SessionSearchBar
						showSearchPanel={showSearchPanel}
						search={search}
						searchMode={searchMode}
						isSearching={isSearching}
						namedOnly={namedOnly}
						showAllSessions={showAllSessions}
						searchModeDropdownOpen={searchModeDropdownOpen}
						searchModeDropdownRef={searchModeDropdownRef}
						inputRef={inputRef}
						activityEntries={activityEntries}
						graphLookbackHours={graphLookbackHours}
						theme={theme}
						onSearchChange={handleSearchChange}
						onSearchKeyDown={(e) => {
							if (e.key === 'Escape') {
								e.preventDefault();
								e.stopPropagation();
								setShowSearchPanel(false);
								handleSearchChange('');
							} else {
								handleKeyDown(e);
							}
						}}
						onToggleSearchPanel={() => {
							setShowSearchPanel(!showSearchPanel);
							if (!showSearchPanel) {
								setTimeout(() => inputRef.current?.focus(), 50);
							} else {
								handleSearchChange('');
							}
						}}
						onToggleNamedOnly={setNamedOnly}
						onToggleShowAll={setShowAllSessions}
						onSearchModeDropdownToggle={() => setSearchModeDropdownOpen(!searchModeDropdownOpen)}
						onSearchModeSelect={(mode) => {
							setSearchMode(mode);
							setSearchModeDropdownOpen(false);
						}}
						onGraphBarClick={handleGraphBarClick}
						onLookbackChange={setGraphLookbackHours}
					/>
					<SessionListView
						loading={loading}
						sessions={sessions}
						filteredSessions={filteredSessions}
						selectedIndex={selectedIndex}
						starredSessions={starredSessions}
						activeAgentSessionId={activeAgentSessionId}
						renamingSessionId={renamingSessionId}
						renameValue={renameValue}
						searchMode={searchMode}
						search={search}
						isLoadingMoreSessions={isLoadingMoreSessions}
						hasMoreSessions={hasMoreSessions}
						totalSessionCount={totalSessionCount}
						agentId={agentId}
						theme={theme}
						sessionsContainerRef={sessionsContainerRef}
						selectedItemRef={selectedItemRef}
						renameInputRef={renameInputRef}
						getSearchResultInfo={getSearchResultInfo}
						onSessionsScroll={handleSessionsScroll}
						onViewSession={handleViewSession}
						onToggleStar={toggleStar}
						onQuickResume={handleQuickResume}
						onStartRename={startRename}
						onRenameChange={setRenameValue}
						onSubmitRename={submitRename}
						onCancelRename={cancelRename}
					/>
				</div>
			)}
		</div>
	);
}
