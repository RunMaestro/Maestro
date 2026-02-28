import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import InboxListView from './InboxListView';
import FocusModeView from './FocusModeView';
import type { Theme, Session, Group, ThinkingMode } from '../../types';
import type {
	InboxItem,
	InboxViewMode,
	InboxFilterMode,
	InboxSortMode,
} from '../../types/agent-inbox';
import { isValidFilterMode, isValidSortMode } from '../../types/agent-inbox';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useModalStore, selectModalData } from '../../stores/modalStore';
import { useAgentInbox } from '../../hooks/useAgentInbox';

// Re-export so existing test imports don't break
export { resolveContextUsageColor } from './InboxListView';

interface AgentInboxProps {
	theme: Theme;
	sessions: Session[];
	groups: Group[];
	enterToSendAI?: boolean;
	slashCommands?: Array<{
		command: string;
		description: string;
		terminalOnly?: boolean;
		aiOnly?: boolean;
	}>;
	onClose: () => void;
	onNavigateToSession?: (sessionId: string, tabId?: string) => void;
	onQuickReply?: (sessionId: string, tabId: string, text: string) => void;
	onOpenAndReply?: (sessionId: string, tabId: string, text: string) => void;
	onMarkAsRead?: (sessionId: string, tabId: string) => void;
	onToggleThinking?: (sessionId: string, tabId: string, mode: ThinkingMode) => void;
}

export default function AgentInbox({
	theme,
	sessions,
	groups,
	enterToSendAI,
	slashCommands: slashCommandsProp,
	onClose,
	onNavigateToSession,
	onQuickReply,
	onOpenAndReply,
	onMarkAsRead,
	onToggleThinking,
}: AgentInboxProps) {
	// ---- Focus restoration ----
	// Capture trigger element synchronously during initial render (before child effects)
	const triggerRef = useRef<HTMLElement | null>(
		document.activeElement instanceof HTMLElement ? document.activeElement : null
	);

	const handleClose = useCallback(() => {
		const trigger = triggerRef.current;
		onClose();
		// Schedule focus restoration after React unmounts the modal.
		// No cleanup needed — the RAF fires once post-unmount and is harmless if trigger is gone.
		requestAnimationFrame(() => {
			trigger?.focus();
		});
	}, [onClose]);

	// ---- View mode state ----
	const [viewMode, setViewMode] = useState<InboxViewMode>('list');
	// Identity-based focus tracking: survives items array reordering/membership changes.
	// Prevents focus disruption when agents respond and items re-enter the filtered list.
	const [focusId, setFocusId] = useState<{ sessionId: string; tabId: string } | null>(null);
	// Sync ref for rapid keyboard navigation (prevents stale closure reads)
	const focusIdRef = useRef(focusId);
	focusIdRef.current = focusId;
	const [selectedIndex, setSelectedIndex] = useState(0);

	// ---- Filter/sort state (lifted from InboxListView for shared access) ----
	const inboxData = useModalStore(selectModalData('agentInbox'));
	const [filterMode, setFilterMode] = useState<InboxFilterMode>(
		isValidFilterMode(inboxData?.filterMode) ? inboxData.filterMode : 'unread'
	);
	const [sortMode, setSortMode] = useState<InboxSortMode>(
		isValidSortMode(inboxData?.sortMode) ? inboxData.sortMode : 'newest'
	);

	// ---- Compute live items (used in list mode) ----
	const liveItems = useAgentInbox(sessions, groups, filterMode, sortMode);

	// ---- Frozen snapshot for Focus Mode ----
	// Simple ref-based approach: freeze item order on entry, resolve against live data
	// for real-time updates (logs, status), but keep the ORDER stable.
	const frozenOrderRef = useRef<{ sessionId: string; tabId: string }[]>([]);

	// Resolve frozen order against live items (live data, frozen order)
	const resolveFrozenItems = useCallback(
		(frozen: { sessionId: string; tabId: string }[]): InboxItem[] => {
			const liveMap = new Map<string, InboxItem>();
			for (const item of liveItems) {
				liveMap.set(`${item.sessionId}:${item.tabId}`, item);
			}
			const resolved: InboxItem[] = [];
			for (const key of frozen) {
				const live = liveMap.get(`${key.sessionId}:${key.tabId}`);
				if (live) resolved.push(live);
			}
			return resolved.length > 0 ? resolved : liveItems;
		},
		[liveItems]
	);

	// Items: in focus mode use frozen-order resolved against live data, else live
	const items =
		viewMode === 'focus' && frozenOrderRef.current.length > 0
			? resolveFrozenItems(frozenOrderRef.current)
			: liveItems;

	// Derive numeric index from identity at render time.
	// If focusId's item left the array (deleted session), fall back to nearest valid index.
	const safeFocusIndex = useMemo(() => {
		if (!focusId || items.length === 0) return 0;
		const idx = items.findIndex(
			(i) => i.sessionId === focusId.sessionId && i.tabId === focusId.tabId
		);
		return idx >= 0 ? idx : Math.min(items.length - 1, 0);
	}, [focusId, items]);

	const handleSetFilterMode = useCallback(
		(mode: InboxFilterMode) => {
			setFilterMode(mode);
			if (viewMode === 'focus') {
				// Re-snapshot: resolve new filter results immediately
				// We need a render with the new filterMode first, so defer the snapshot
				frozenOrderRef.current = [];
				setFocusId(null);
			}
		},
		[viewMode]
	);

	const handleExitFocus = useCallback(() => {
		setViewMode('list');
		frozenOrderRef.current = [];
	}, []);

	// Re-snapshot after filter change empties the ref (needs liveItems from new filter).
	// Also recover focusId when null (after filter change) to avoid permanent empty state.
	useEffect(() => {
		if (viewMode === 'focus' && frozenOrderRef.current.length === 0 && liveItems.length > 0) {
			frozenOrderRef.current = liveItems.map((i) => ({
				sessionId: i.sessionId,
				tabId: i.tabId,
			}));
			// Recover focusId: after a filter change clears it, point to the first item
			if (!focusIdRef.current && liveItems[0]) {
				setFocusId({ sessionId: liveItems[0].sessionId, tabId: liveItems[0].tabId });
			}
		}
	}, [viewMode, liveItems]);

	const handleEnterFocus = useCallback(
		(item: InboxItem) => {
			setFocusId({ sessionId: item.sessionId, tabId: item.tabId });
			// Freeze current order as simple identity pairs
			frozenOrderRef.current = liveItems.map((i) => ({
				sessionId: i.sessionId,
				tabId: i.tabId,
			}));
			setViewMode('focus');
		},
		[liveItems]
	);

	// ---- Navigate item wrapper (keeps numeric contract with FocusModeView) ----
	const handleNavigateItem = useCallback(
		(idx: number) => {
			const target = items[idx];
			if (target) {
				setFocusId({ sessionId: target.sessionId, tabId: target.tabId });
			}
		},
		[items]
	);

	// ---- Layer stack: viewMode-aware Escape ----
	const handleLayerEscape = useCallback(() => {
		if (viewMode === 'focus') {
			handleExitFocus();
		} else {
			handleClose();
		}
	}, [viewMode, handleExitFocus, handleClose]);

	useModalLayer(MODAL_PRIORITIES.AGENT_INBOX, 'Unified Inbox', handleLayerEscape);

	// ---- Container ref for keyboard focus ----
	const containerRef = useRef<HTMLDivElement>(null);

	// Auto-focus container on mount for immediate keyboard navigation
	useEffect(() => {
		const raf = requestAnimationFrame(() => {
			containerRef.current?.focus();
		});
		return () => cancelAnimationFrame(raf);
	}, []);

	// ---- Expanded state (lifted to shell for dialog width control) ----
	const [isExpanded, setIsExpanded] = useState(inboxData?.isExpanded ?? false);

	// ---- Compute dialog dimensions (focus mode or expanded → wide) ----
	const isWide = isExpanded || viewMode === 'focus';
	const dialogWidth = '75vw';
	const dialogHeight = viewMode === 'focus' ? '85vh' : undefined;
	const dialogMaxHeight = viewMode === 'focus' ? undefined : isWide ? '90vh' : '80vh';

	// ---- Keyboard handler ref from InboxListView ----
	const listKeyDownRef = useRef<((e: React.KeyboardEvent) => void) | null>(null);

	// ---- CAPTURE phase: Cmd+[/] must fire BEFORE textarea consumes the event ----
	const handleCaptureKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (viewMode !== 'focus') return;
			if ((e.metaKey || e.ctrlKey) && (e.key === '[' || e.key === ']')) {
				e.preventDefault();
				e.stopPropagation();
				if (items.length > 1) {
					// Read from ref for accurate position during rapid keypresses
					const currentId = focusIdRef.current;
					const currentIdx = currentId
						? items.findIndex(
								(i) => i.sessionId === currentId.sessionId && i.tabId === currentId.tabId
							)
						: 0;
					const safeIdx = currentIdx >= 0 ? currentIdx : 0;
					const newIdx =
						e.key === '[' ? Math.max(safeIdx - 1, 0) : Math.min(safeIdx + 1, items.length - 1);
					const target = items[newIdx];
					if (target) {
						const newId = { sessionId: target.sessionId, tabId: target.tabId };
						focusIdRef.current = newId; // Sync ref immediately for next rapid keypress
						setFocusId(newId);
					}
				}
			}
		},
		[viewMode, items]
	);

	// ---- BUBBLE phase: all other keyboard shortcuts ----
	const handleShellKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (viewMode === 'focus') {
				switch (e.key) {
					case 'Escape':
						e.preventDefault();
						e.stopPropagation();
						handleExitFocus();
						return;
					case 'Backspace':
					case 'b':
					case 'B':
						// Guard: only exit if NOT typing in the reply textarea
						if (document.activeElement?.tagName !== 'TEXTAREA') {
							e.preventDefault();
							handleExitFocus();
						}
						return;
				}
				return;
			}

			// List mode: F to enter focus
			if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey) {
				e.preventDefault();
				if (items.length > 0 && items[selectedIndex]) {
					handleEnterFocus(items[selectedIndex]);
				}
				return;
			}

			// Delegate only when the shell container itself is focused.
			// Avoid re-processing events already handled inside InboxListView.
			if (
				viewMode === 'list' &&
				listKeyDownRef.current &&
				!e.defaultPrevented &&
				e.target === e.currentTarget
			) {
				e.stopPropagation();
				listKeyDownRef.current(e);
			}
		},
		[viewMode, items, selectedIndex, handleEnterFocus, handleExitFocus]
	);

	return (
		<div
			className="fixed inset-0 modal-overlay flex items-center justify-center z-[9999] animate-in fade-in duration-100"
			style={{ backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
			onClick={handleClose}
		>
			<div
				ref={containerRef}
				tabIndex={-1}
				role="dialog"
				aria-modal="true"
				aria-label="Unified Inbox"
				className="rounded-xl shadow-2xl border overflow-hidden flex flex-col outline-none"
				style={{
					backgroundColor: theme.colors.bgActivity,
					borderColor: theme.colors.border,
					width: dialogWidth,
					maxWidth: '95vw',
					height: dialogHeight,
					maxHeight: dialogMaxHeight,
					transition: 'width 200ms ease, height 200ms ease, max-height 200ms ease',
				}}
				onClick={(e) => e.stopPropagation()}
				onKeyDownCapture={handleCaptureKeyDown}
				onKeyDown={handleShellKeyDown}
				onFocus={() => {}}
				onBlur={() => {}}
			>
				<div className="flex-1 flex flex-col overflow-hidden" style={{ minHeight: 0 }}>
					{viewMode === 'list' ? (
						<InboxListView
							theme={theme}
							items={items}
							selectedIndex={selectedIndex}
							setSelectedIndex={setSelectedIndex}
							filterMode={filterMode}
							setFilterMode={handleSetFilterMode}
							sortMode={sortMode}
							setSortMode={setSortMode}
							onClose={handleClose}
							onNavigateToSession={onNavigateToSession}
							onEnterFocus={handleEnterFocus}
							containerRef={containerRef}
							keyDownRef={listKeyDownRef}
							isExpanded={isExpanded}
							onToggleExpanded={setIsExpanded}
						/>
					) : items[safeFocusIndex] ? (
						<FocusModeView
							theme={theme}
							item={items[safeFocusIndex]}
							items={items}
							sessions={sessions}
							currentIndex={safeFocusIndex}
							enterToSendAI={enterToSendAI}
							slashCommands={slashCommandsProp}
							filterMode={filterMode}
							setFilterMode={handleSetFilterMode}
							sortMode={sortMode}
							onClose={handleClose}
							onExitFocus={handleExitFocus}
							onNavigateItem={handleNavigateItem}
							onNavigateToSession={onNavigateToSession}
							onQuickReply={onQuickReply}
							onOpenAndReply={onOpenAndReply}
							onMarkAsRead={onMarkAsRead}
							onToggleThinking={onToggleThinking}
						/>
					) : (
						<div
							style={{ color: theme.colors.textDim, padding: 40, textAlign: 'center' }}
							className="flex flex-col items-center gap-3"
						>
							<span className="text-sm">
								{filterMode === 'unread'
									? 'No unread items'
									: filterMode === 'starred'
										? 'No starred items'
										: 'No items to focus on'}
							</span>
							{filterMode !== 'all' && (
								<button
									onClick={() => handleSetFilterMode('all')}
									className="text-xs px-3 py-1.5 rounded-full"
									style={{
										backgroundColor: `${theme.colors.accent}20`,
										color: theme.colors.accent,
										border: 'none',
										cursor: 'pointer',
									}}
								>
									Show all items
								</button>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
