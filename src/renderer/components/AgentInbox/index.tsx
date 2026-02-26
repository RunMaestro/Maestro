/* POLISH-04 Token Audit (@architect)
 * Line 267: bgActivity for dialog container — CORRECT (content)
 * All other usages: CORRECT
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import InboxListView from './InboxListView';
import FocusModeView from './FocusModeView';
import type { Theme, Session, Group, ThinkingMode } from '../../types';
import type {
	InboxItem,
	InboxViewMode,
	InboxFilterMode,
	InboxSortMode,
} from '../../types/agent-inbox';
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
	onClose,
	onNavigateToSession,
	onQuickReply,
	onOpenAndReply,
	onMarkAsRead,
	onToggleThinking,
}: AgentInboxProps) {
	// ---- Focus restoration ----
	// Capture trigger element synchronously during initial render (before child effects)
	const triggerRef = useRef<Element | null>(document.activeElement);
	const rafIdRef = useRef<number | null>(null);
	useEffect(() => {
		return () => {
			if (rafIdRef.current !== null) {
				cancelAnimationFrame(rafIdRef.current);
			}
		};
	}, []);

	const handleClose = useCallback(() => {
		onClose();
		rafIdRef.current = requestAnimationFrame(() => {
			rafIdRef.current = null;
			if (triggerRef.current && triggerRef.current instanceof HTMLElement) {
				triggerRef.current.focus();
			}
		});
	}, [onClose]);

	// ---- View mode state ----
	const [viewMode, setViewMode] = useState<InboxViewMode>('list');
	const [focusIndex, setFocusIndex] = useState(0);
	const [selectedIndex, setSelectedIndex] = useState(0);

	// ---- Filter/sort state (lifted from InboxListView for shared access) ----
	const inboxData = useModalStore(selectModalData('agentInbox'));
	const [filterMode, setFilterMode] = useState<InboxFilterMode>(
		(inboxData?.filterMode as InboxFilterMode) ?? 'unread'
	);
	const [sortMode, setSortMode] = useState<InboxSortMode>(
		(inboxData?.sortMode as InboxSortMode) ?? 'newest'
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
			const resolved: InboxItem[] = [];
			for (const key of frozen) {
				const live = liveItems.find((i) => i.sessionId === key.sessionId && i.tabId === key.tabId);
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

	const handleSetFilterMode = useCallback(
		(mode: InboxFilterMode) => {
			setFilterMode(mode);
			if (viewMode === 'focus') {
				// Re-snapshot: resolve new filter results immediately
				// We need a render with the new filterMode first, so defer the snapshot
				frozenOrderRef.current = [];
				setFocusIndex(0);
			}
		},
		[viewMode]
	);

	const handleExitFocus = useCallback(() => {
		setViewMode('list');
		frozenOrderRef.current = [];
	}, []);

	// Re-snapshot after filter change empties the ref (needs liveItems from new filter)
	useEffect(() => {
		if (viewMode === 'focus' && frozenOrderRef.current.length === 0 && liveItems.length > 0) {
			frozenOrderRef.current = liveItems.map((i) => ({
				sessionId: i.sessionId,
				tabId: i.tabId,
			}));
		}
	}, [viewMode, liveItems]);

	// ---- Edge case: items shrink while in focus mode ----
	useEffect(() => {
		if (viewMode === 'focus' && items.length > 0 && focusIndex >= items.length) {
			setFocusIndex(items.length - 1);
		}
	}, [items.length, focusIndex, viewMode]);

	const handleEnterFocus = useCallback(
		(item: InboxItem) => {
			const idx = liveItems.findIndex(
				(i) => i.sessionId === item.sessionId && i.tabId === item.tabId
			);
			setFocusIndex(idx >= 0 ? idx : 0);
			// Freeze current order as simple identity pairs
			frozenOrderRef.current = liveItems.map((i) => ({
				sessionId: i.sessionId,
				tabId: i.tabId,
			}));
			setViewMode('focus');
		},
		[liveItems]
	);

	// ---- Navigate item wrapper ----
	const handleNavigateItem = useCallback((idx: number) => {
		setFocusIndex(idx);
	}, []);

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
	const expandedWidth = Math.min(
		typeof window !== 'undefined' ? window.innerWidth * 0.92 : 1400,
		1400
	);
	const dialogWidth = viewMode === 'focus' ? expandedWidth : isWide ? expandedWidth : 780;
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
					setFocusIndex((prev) =>
						e.key === '[' ? Math.max(prev - 1, 0) : Math.min(prev + 1, items.length - 1)
					);
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

			// Delegate to InboxListView's keyboard handler in list mode
			if (viewMode === 'list' && listKeyDownRef.current) {
				listKeyDownRef.current(e);
			}
		},
		[viewMode, items, selectedIndex, handleEnterFocus, handleExitFocus]
	);

	return (
		<div
			className="fixed inset-0 modal-overlay flex items-center justify-center z-[9999] animate-in fade-in duration-100"
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
					) : items[focusIndex] ? (
						<FocusModeView
							theme={theme}
							item={items[focusIndex]}
							items={items}
							sessions={sessions}
							currentIndex={focusIndex}
							enterToSendAI={enterToSendAI}
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
