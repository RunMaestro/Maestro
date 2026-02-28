import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { X, CheckCircle, ChevronDown, ChevronRight, Maximize2, Minimize2, Bot } from 'lucide-react';
import type { Theme, SessionState } from '../../types';
import type { InboxItem, InboxFilterMode, InboxSortMode } from '../../types/agent-inbox';
import { STATUS_LABELS, STATUS_COLORS } from '../../types/agent-inbox';
import { formatRelativeTime } from '../../utils/formatters';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { getModalActions } from '../../stores/modalStore';

interface InboxListViewProps {
	theme: Theme;
	items: InboxItem[];
	selectedIndex: number;
	setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
	filterMode: InboxFilterMode;
	setFilterMode: (mode: InboxFilterMode) => void;
	sortMode: InboxSortMode;
	setSortMode: (mode: InboxSortMode) => void;
	onClose: () => void;
	onNavigateToSession?: (sessionId: string, tabId?: string) => void;
	onEnterFocus: (item: InboxItem) => void;
	containerRef: React.RefObject<HTMLDivElement | null>;
	keyDownRef?: React.MutableRefObject<((e: React.KeyboardEvent) => void) | null>;
	isExpanded: boolean;
	onToggleExpanded: (expanded: boolean | ((prev: boolean) => boolean)) => void;
}

const ITEM_HEIGHT = 132;
const GROUP_HEADER_HEIGHT = 36;
const MODAL_HEADER_HEIGHT = 80;
const MODAL_FOOTER_HEIGHT = 36;
const STATS_BAR_HEIGHT = 32;

// ============================================================================
// Empty state messages per filter mode
// ============================================================================
const EMPTY_STATE_MESSAGES: Record<InboxFilterMode, { text: string; showIcon: boolean }> = {
	all: { text: 'No active agents to show.', showIcon: true },
	unread: { text: 'No unread agents.', showIcon: false },
	read: { text: 'No read agents with activity.', showIcon: false },
	starred: { text: 'No starred agents.', showIcon: false },
};

// ============================================================================
// Grouped list model: interleaves group headers with items when sort = 'grouped'
// ============================================================================
type ListRow =
	| { type: 'header'; groupKey: string; groupName: string }
	| { type: 'item'; item: InboxItem; index: number };

function buildRows(items: InboxItem[], sortMode: InboxSortMode): ListRow[] {
	if (sortMode !== 'grouped' && sortMode !== 'byAgent') {
		return items.map((item, index) => ({ type: 'item' as const, item, index }));
	}
	const rows: ListRow[] = [];
	let lastGroupKey: string | null = null;
	let itemIndex = 0;
	for (const item of items) {
		// For 'grouped': group by Left Bar group name
		// For 'byAgent': group by sessionId (unique) and display sessionName
		const groupKey =
			sortMode === 'byAgent' ? item.sessionId : (item.groupId ?? item.groupName ?? 'Ungrouped');
		const groupName = sortMode === 'byAgent' ? item.sessionName : (item.groupName ?? 'Ungrouped');
		if (groupKey !== lastGroupKey) {
			rows.push({ type: 'header', groupKey, groupName });
			lastGroupKey = groupKey;
		}
		rows.push({ type: 'item', item, index: itemIndex });
		itemIndex++;
	}
	return rows;
}

/** Derive the collapse key for a given item row — must stay aligned with buildRows groupKey. */
function getGroupCollapseKey(item: InboxItem, sortMode: InboxSortMode): string {
	return sortMode === 'byAgent' ? item.sessionId : (item.groupId ?? item.groupName ?? 'Ungrouped');
}

// ============================================================================
// STATUS color resolver — maps STATUS_COLORS key to actual hex
// ============================================================================
function resolveStatusColor(state: SessionState, theme: Theme): string {
	const colorKey = STATUS_COLORS[state];
	const colorMap: Record<string, string> = {
		success: theme.colors.success,
		warning: theme.colors.warning,
		error: theme.colors.error,
		info: theme.colors.accent,
		textMuted: theme.colors.textDim,
	};
	return colorMap[colorKey] ?? theme.colors.textDim;
}

// ============================================================================
// Context usage color resolver — green/orange/red thresholds
// ============================================================================
export function resolveContextUsageColor(percentage: number, theme: Theme): string {
	if (percentage >= 80) return theme.colors.error;
	if (percentage >= 60) return theme.colors.warning;
	return theme.colors.success;
}

// ============================================================================
// InboxItemCard — rendered inside each row
// ============================================================================
function InboxItemCardContent({
	item,
	theme,
	isSelected,
	onClick,
	onDoubleClick,
}: {
	item: InboxItem;
	theme: Theme;
	isSelected: boolean;
	onClick: () => void;
	onDoubleClick?: () => void;
}) {
	const statusColor = resolveStatusColor(item.state, theme);
	const hasValidContext = item.contextUsage !== undefined && !isNaN(item.contextUsage);
	const contextColor = hasValidContext
		? resolveContextUsageColor(item.contextUsage!, theme)
		: undefined;

	return (
		<div
			role="option"
			aria-selected={isSelected}
			id={`inbox-item-${item.sessionId}-${item.tabId}`}
			tabIndex={isSelected ? 0 : -1}
			onClick={onClick}
			onDoubleClick={onDoubleClick}
			style={{
				height: ITEM_HEIGHT - 12,
				borderRadius: 8,
				cursor: 'pointer',
				backgroundColor: isSelected ? `${theme.colors.accent}15` : 'transparent',
				display: 'flex',
				flexDirection: 'column',
				justifyContent: 'space-between',
				overflow: 'hidden',
				position: 'relative',
			}}
			onFocus={(e) => {
				e.currentTarget.style.outline = `2px solid ${theme.colors.accent}`;
				e.currentTarget.style.outlineOffset = '-2px';
			}}
			onBlur={(e) => {
				e.currentTarget.style.outline = 'none';
			}}
		>
			{/* Card content — horizontal flex with agent icon + details */}
			<div
				style={{
					padding: '12px 16px',
					display: 'flex',
					alignItems: 'center',
					gap: 10,
					flex: 1,
				}}
			>
				{/* Agent icon */}
				<div
					style={{
						width: 28,
						height: 28,
						borderRadius: 6,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						backgroundColor: `${theme.colors.accent}15`,
						flexShrink: 0,
					}}
				>
					<Bot style={{ width: 14, height: 14, color: theme.colors.accent }} />
				</div>
				{/* Card details */}
				<div
					style={{
						display: 'flex',
						flexDirection: 'column',
						justifyContent: 'center',
						gap: 6,
						flex: 1,
						minWidth: 0,
					}}
				>
					{/* Row 1: GROUP | session | tab    timestamp */}
					<div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
						{item.groupName && (
							<>
								<span
									style={{
										fontSize: 12,
										color: theme.colors.textDim,
										whiteSpace: 'nowrap',
										textTransform: 'uppercase',
										letterSpacing: '0.5px',
									}}
								>
									{item.groupName}
								</span>
								<span style={{ fontSize: 12, color: theme.colors.textDim, padding: '0 6px' }}>
									|
								</span>
							</>
						)}
						<span
							style={{
								fontSize: 14,
								fontWeight: 600,
								color: theme.colors.textMain,
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								whiteSpace: 'nowrap',
								flex: 1,
							}}
						>
							{item.sessionName}
							{item.tabName && (
								<>
									<span
										style={{
											fontSize: 12,
											color: theme.colors.textDim,
											padding: '0 6px',
											fontWeight: 400,
										}}
									>
										|
									</span>
									<span style={{ fontWeight: 400, color: theme.colors.textDim }}>
										{item.tabName}
									</span>
								</>
							)}
						</span>
						<span
							style={{
								fontSize: 12,
								color: theme.colors.textDim,
								whiteSpace: 'nowrap',
								flexShrink: 0,
							}}
						>
							{formatRelativeTime(item.timestamp)}
						</span>
					</div>

					{/* Row 2: last message (2-line clamp) */}
					<div
						style={{
							fontSize: 12,
							color: theme.colors.textDim,
							overflow: 'hidden',
							display: '-webkit-box',
							WebkitLineClamp: 2,
							WebkitBoxOrient: 'vertical' as const,
							lineHeight: '1.4',
						}}
					>
						{item.lastMessage}
					</div>

					{/* Row 3: badges */}
					<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
						{item.gitBranch && (
							<span
								data-testid="git-branch-badge"
								style={{
									fontSize: 11,
									fontFamily: "'SF Mono', 'Menlo', monospace",
									padding: '1px 6px',
									borderRadius: 4,
									backgroundColor: `${theme.colors.accent}15`,
									color: theme.colors.accent,
									whiteSpace: 'nowrap',
									overflow: 'hidden',
									textOverflow: 'ellipsis',
									maxWidth: 200,
								}}
							>
								⎇{' '}
								{item.gitBranch.length > 25 ? item.gitBranch.slice(0, 25) + '...' : item.gitBranch}
							</span>
						)}
						<span
							data-testid="context-usage-text"
							style={{
								fontSize: 11,
								color: hasValidContext ? contextColor : theme.colors.textDim,
							}}
						>
							{hasValidContext ? `Context: ${item.contextUsage}%` : 'Context: \u2014'}
						</span>
						<span
							style={{
								fontSize: 11,
								padding: '1px 8px',
								borderRadius: 10,
								backgroundColor: `${statusColor}20`,
								color: statusColor,
								whiteSpace: 'nowrap',
							}}
						>
							{STATUS_LABELS[item.state]}
						</span>
					</div>
				</div>
			</div>

			{/* Context usage bar — 4px at bottom of card */}
			{hasValidContext && (
				<div
					data-testid="context-usage-bar"
					title={`Context window: ${item.contextUsage}% used`}
					style={{
						height: 4,
						width: '100%',
						backgroundColor: `${theme.colors.border}40`,
						flexShrink: 0,
					}}
				>
					<div
						style={{
							height: '100%',
							width: `${Math.min(Math.max(item.contextUsage!, 0), 100)}%`,
							backgroundColor: contextColor,
							borderRadius: item.contextUsage! >= 100 ? 0 : '0 2px 2px 0',
							transition: 'width 0.3s ease',
						}}
					/>
				</div>
			)}
		</div>
	);
}

// ============================================================================
// SegmentedControl
// ============================================================================
interface SegmentedControlProps<T extends string> {
	options: { value: T; label: string }[];
	value: T;
	onChange: (value: T) => void;
	theme: Theme;
	ariaLabel?: string;
}

function SegmentedControl<T extends string>({
	options,
	value,
	onChange,
	theme,
	ariaLabel,
}: SegmentedControlProps<T>) {
	return (
		<div
			aria-label={ariaLabel}
			style={{
				display: 'inline-flex',
				gap: 2,
				borderRadius: 8,
			}}
		>
			{options.map((opt) => {
				const isActive = value === opt.value;
				return (
					<button
						key={opt.value}
						aria-pressed={isActive}
						onClick={() => onChange(opt.value)}
						style={{
							padding: '4px 12px',
							fontSize: 12,
							border: 'none',
							borderRadius: 8,
							cursor: 'pointer',
							transition: 'background 150ms ease',
							backgroundColor: isActive ? `${theme.colors.accent}20` : 'transparent',
							color: isActive ? theme.colors.accent : theme.colors.textDim,
							outline: 'none',
						}}
						onMouseEnter={(e) => {
							if (!isActive) {
								e.currentTarget.style.backgroundColor = `${theme.colors.accent}10`;
							}
						}}
						onMouseLeave={(e) => {
							if (!isActive) {
								e.currentTarget.style.backgroundColor = 'transparent';
							}
						}}
						onFocus={(e) => {
							e.currentTarget.style.outline = `2px solid ${theme.colors.accent}`;
							e.currentTarget.style.outlineOffset = '-2px';
						}}
						onBlur={(e) => {
							e.currentTarget.style.outline = 'none';
						}}
					>
						{opt.label}
					</button>
				);
			})}
		</div>
	);
}

// ============================================================================
// InboxStatsStrip — compact 32px metric bar between header and list
// ============================================================================
function InboxStatsStrip({ items, theme }: { items: InboxItem[]; theme: Theme }) {
	const stats = useMemo(() => {
		const uniqueAgents = new Set(items.map((i) => i.sessionId)).size;
		const unread = items.filter((i) => i.hasUnread).length;
		const needsInput = items.filter((i) => i.state === 'waiting_input').length;
		const highContext = items.filter(
			(i) => i.contextUsage !== undefined && i.contextUsage >= 80
		).length;
		return { uniqueAgents, unread, needsInput, highContext };
	}, [items]);

	const metrics = [
		{ label: 'Agents', value: stats.uniqueAgents },
		{ label: 'Unread', value: stats.unread },
		{ label: 'Needs Input', value: stats.needsInput },
		{ label: 'Context \u226580%', value: stats.highContext },
	];

	return (
		<div
			className="flex items-center gap-4 px-6 py-1 border-b text-xs"
			style={{
				height: STATS_BAR_HEIGHT,
				backgroundColor: theme.colors.bgActivity,
				borderColor: theme.colors.border,
			}}
		>
			{metrics.map((m) => (
				<span key={m.label} className="flex items-center gap-1">
					<span
						style={{
							color: theme.colors.textDim,
							textTransform: 'uppercase',
							letterSpacing: '0.5px',
						}}
					>
						{m.label}
					</span>
					<span style={{ color: theme.colors.textMain, fontWeight: 600, marginLeft: 4 }}>
						{m.value}
					</span>
				</span>
			))}
		</div>
	);
}

// ============================================================================
// Human-readable agent display names for group headers
// ============================================================================
const TOOL_TYPE_LABELS: Record<string, string> = {
	'claude-code': 'Claude Code',
	codex: 'Codex',
	opencode: 'OpenCode',
	'factory-droid': 'Factory Droid',
	terminal: 'Terminal',
};

// ============================================================================
// InboxListView Component
// ============================================================================
const SORT_OPTIONS: { value: InboxSortMode; label: string }[] = [
	{ value: 'newest', label: 'Newest' },
	{ value: 'oldest', label: 'Oldest' },
	{ value: 'grouped', label: 'Grouped' },
	{ value: 'byAgent', label: 'By Agent' },
];

const FILTER_OPTIONS: { value: InboxFilterMode; label: string }[] = [
	{ value: 'all', label: 'All' },
	{ value: 'unread', label: 'Unread' },
	{ value: 'read', label: 'Read' },
	{ value: 'starred', label: 'Starred' },
];

// Track the identity of the selected row so we can re-find it after rows change
type RowIdentity =
	| { type: 'header'; groupKey: string }
	| { type: 'item'; sessionId: string; tabId: string };

export default function InboxListView({
	theme,
	items,
	selectedIndex,
	setSelectedIndex,
	filterMode,
	setFilterMode,
	sortMode,
	setSortMode,
	onClose,
	onNavigateToSession,
	onEnterFocus,
	containerRef,
	keyDownRef,
	isExpanded,
	onToggleExpanded,
}: InboxListViewProps) {
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

	// Initial mount flag — enables staggered entrance animation only on first render
	const [isInitialMount, setIsInitialMount] = useState(true);
	useEffect(() => {
		const timer = setTimeout(() => setIsInitialMount(false), 600);
		return () => clearTimeout(timer);
	}, []);

	// Write state changes back to modalStore for persistence
	useEffect(() => {
		const { updateAgentInboxData } = getModalActions();
		updateAgentInboxData({ filterMode, sortMode, isExpanded });
	}, [filterMode, sortMode, isExpanded]);

	const toggleGroup = useCallback((groupKey: string) => {
		setCollapsedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(groupKey)) {
				next.delete(groupKey);
			} else {
				next.add(groupKey);
			}
			return next;
		});
	}, []);

	// Auto-collapse zero-unread agents ONLY on initial transition into byAgent mode.
	// After that, manual toggles are preserved — items changes do NOT reset collapse state.
	const prevSortModeRef = useRef(sortMode);
	useEffect(() => {
		const prev = prevSortModeRef.current;
		prevSortModeRef.current = sortMode;

		if (sortMode === 'byAgent' && prev !== 'byAgent') {
			const agentUnreads = new Map<string, number>();
			for (const item of items) {
				const count = agentUnreads.get(item.sessionId) ?? 0;
				agentUnreads.set(item.sessionId, count + (item.hasUnread ? 1 : 0));
			}
			const toCollapse = new Set<string>();
			for (const [agent, count] of agentUnreads) {
				if (count === 0) toCollapse.add(agent);
			}
			setCollapsedGroups(toCollapse);
		} else if (sortMode !== 'byAgent' && prev === 'byAgent') {
			setCollapsedGroups(new Set());
		}
	}, [sortMode, items]);

	const allRows = useMemo(() => buildRows(items, sortMode), [items, sortMode]);
	const rows = useMemo(() => {
		if ((sortMode !== 'grouped' && sortMode !== 'byAgent') || collapsedGroups.size === 0)
			return allRows;
		return allRows.filter((row) => {
			if (row.type === 'header') return true;
			return !collapsedGroups.has(getGroupCollapseKey(row.item, sortMode));
		});
	}, [allRows, collapsedGroups, sortMode]);

	// Map from row index to visible-item-number (1-based, only for item rows)
	// Also build reverse map: visibleItemNumber -> row index (for Cmd+N)
	const { visibleItemNumbers, visibleItemByNumber } = useMemo(() => {
		const numbers = new Map<number, number>(); // rowIndex -> 1-based visible number
		const byNumber = new Map<number, number>(); // 1-based visible number -> rowIndex
		let counter = 0;
		for (let i = 0; i < rows.length; i++) {
			if (rows[i].type === 'item') {
				counter++;
				numbers.set(i, counter);
				byNumber.set(counter, i);
			}
		}
		return { visibleItemNumbers: numbers, visibleItemByNumber: byNumber };
	}, [rows]);

	// ============================================================================
	// Row-based navigation — navigates over rows (headers + items), no useListNavigation
	// ============================================================================
	// Initialize to first item row (skip leading headers)
	const firstItemRow = useMemo(() => {
		for (let i = 0; i < rows.length; i++) {
			if (rows[i].type === 'item') return i;
		}
		return 0;
	}, [rows]);
	const [selectedRowIndex, setSelectedRowIndex] = useState(firstItemRow);
	const selectedRowIdentityRef = useRef<RowIdentity | null>(null);

	// Keep the identity ref in sync with selectedRowIndex
	useEffect(() => {
		const row = rows[selectedRowIndex];
		if (!row) {
			selectedRowIdentityRef.current = null;
			return;
		}
		if (row.type === 'header') {
			selectedRowIdentityRef.current = { type: 'header', groupKey: row.groupKey };
		} else {
			selectedRowIdentityRef.current = {
				type: 'item',
				sessionId: row.item.sessionId,
				tabId: row.item.tabId,
			};
		}
	}, [selectedRowIndex, rows]);

	// Ref to the scrollable list container
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const headerRef = useRef<HTMLDivElement>(null);

	// Stabilize selectedRowIndex after rows change (collapse/expand/filter)
	useEffect(() => {
		if (rows.length === 0) {
			setSelectedRowIndex(0);
			return;
		}

		const identity = selectedRowIdentityRef.current;
		if (!identity) return;

		// Check if the current index still points at the same identity
		const currentRow = rows[selectedRowIndex];
		if (currentRow) {
			if (
				identity.type === 'header' &&
				currentRow.type === 'header' &&
				currentRow.groupKey === identity.groupKey
			) {
				return; // Still correct
			}
			if (
				identity.type === 'item' &&
				currentRow.type === 'item' &&
				currentRow.item.sessionId === identity.sessionId &&
				currentRow.item.tabId === identity.tabId
			) {
				return; // Still correct
			}
		}

		// Identity drifted — search for the old identity in the new rows
		for (let i = 0; i < rows.length; i++) {
			const r = rows[i];
			if (identity.type === 'header' && r.type === 'header' && r.groupKey === identity.groupKey) {
				setSelectedRowIndex(i);
				return;
			}
			if (
				identity.type === 'item' &&
				r.type === 'item' &&
				r.item.sessionId === identity.sessionId &&
				r.item.tabId === identity.tabId
			) {
				setSelectedRowIndex(i);
				return;
			}
		}

		// Old identity no longer in rows (collapsed away) — find nearest item or clamp
		const clamped = Math.min(selectedRowIndex, rows.length - 1);
		// Search downward from clamped position for an item row
		for (let i = clamped; i < rows.length; i++) {
			if (rows[i].type === 'item') {
				setSelectedRowIndex(i);
				return;
			}
		}
		// Search upward
		for (let i = clamped - 1; i >= 0; i--) {
			if (rows[i].type === 'item') {
				setSelectedRowIndex(i);
				return;
			}
		}
		// Only headers remain — select the first header
		setSelectedRowIndex(0);
	}, [rows, selectedRowIndex]);

	// When sort mode or filter mode changes, reset selection to first item row
	const prevSortForResetRef = useRef(sortMode);
	const prevFilterForResetRef = useRef(filterMode);
	useEffect(() => {
		if (sortMode !== prevSortForResetRef.current || filterMode !== prevFilterForResetRef.current) {
			prevSortForResetRef.current = sortMode;
			prevFilterForResetRef.current = filterMode;
			for (let i = 0; i < rows.length; i++) {
				if (rows[i].type === 'item') {
					setSelectedRowIndex(i);
					return;
				}
			}
			setSelectedRowIndex(0);
		}
	}, [sortMode, filterMode, rows]);

	// Sync selectedRowIndex -> parent selectedIndex (used by Focus Mode entry)
	useEffect(() => {
		const row = rows[selectedRowIndex];
		if (!row) return;

		if (row.type === 'item') {
			setSelectedIndex(row.index);
			return;
		}

		// Header selected — find nearest item below, then above
		for (let i = selectedRowIndex + 1; i < rows.length; i++) {
			const r = rows[i];
			if (r.type === 'header') break; // hit next group, stop
			if (r.type === 'item') {
				setSelectedIndex(r.index);
				return;
			}
		}
		// No item below in same group — search upward
		for (let i = selectedRowIndex - 1; i >= 0; i--) {
			const r = rows[i];
			if (r.type === 'item') {
				setSelectedIndex(r.index);
				return;
			}
		}
	}, [selectedRowIndex, rows, setSelectedIndex]);

	// Guard: ensure parent selectedIndex points to a visible item after collapse
	useEffect(() => {
		if (rows.length === 0) return;
		const visibleItemIndexes = new Set(
			rows.filter((row) => row.type === 'item').map((row) => row.index)
		);
		if (!visibleItemIndexes.has(selectedIndex)) {
			const firstItemRow = rows.find((row) => row.type === 'item');
			if (firstItemRow && firstItemRow.type === 'item') {
				setSelectedIndex(firstItemRow.index);
			}
		}
	}, [rows, selectedIndex, setSelectedIndex]);

	// Row height getter for variable-size rows
	const getRowHeight = useCallback(
		(index: number): number => {
			const row = rows[index];
			if (!row) return ITEM_HEIGHT;
			return row.type === 'header' ? GROUP_HEADER_HEIGHT : ITEM_HEIGHT;
		},
		[rows]
	);

	// Calculate list height
	const listHeight = useMemo(() => {
		if (typeof window === 'undefined') return 400;
		if (isExpanded) {
			return Math.min(
				window.innerHeight * 0.85 -
					MODAL_HEADER_HEIGHT -
					MODAL_FOOTER_HEIGHT -
					STATS_BAR_HEIGHT -
					80,
				1000
			);
		}
		return Math.min(
			window.innerHeight * 0.8 - MODAL_HEADER_HEIGHT - MODAL_FOOTER_HEIGHT - STATS_BAR_HEIGHT - 80,
			700
		);
	}, [isExpanded]);

	// Virtualizer
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollContainerRef.current,
		estimateSize: getRowHeight,
		overscan: 5,
	});

	// Scroll to selected row
	useEffect(() => {
		if (rows.length > 0 && selectedRowIndex < rows.length) {
			virtualizer.scrollToIndex(selectedRowIndex, { align: 'auto' });
		}
	}, [selectedRowIndex, rows.length, virtualizer]);

	const handleNavigate = useCallback(
		(item: InboxItem) => {
			if (onNavigateToSession) {
				onNavigateToSession(item.sessionId, item.tabId);
			}
			onClose();
		},
		[onNavigateToSession, onClose]
	);

	// Get the selected item's element ID for aria-activedescendant
	const selectedItemId = useMemo(() => {
		const row = rows[selectedRowIndex];
		if (!row || row.type !== 'item') return undefined;
		return `inbox-item-${row.item.sessionId}-${row.item.tabId}`;
	}, [rows, selectedRowIndex]);

	// Collect focusable header elements for Tab cycling
	const getHeaderFocusables = useCallback((): HTMLElement[] => {
		if (!headerRef.current) return [];
		return Array.from(
			headerRef.current.querySelectorAll<HTMLElement>(
				'button:not(:disabled), [tabindex="0"]:not([aria-disabled="true"])'
			)
		);
	}, []);

	// Row-based keyboard handler — arrows navigate rows (headers + items)
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			// Tab cycling for header controls
			if (e.key === 'Tab') {
				const focusables = getHeaderFocusables();
				if (focusables.length === 0) return;
				const active = document.activeElement;
				const focusIdx = focusables.indexOf(active as HTMLElement);

				if (e.shiftKey) {
					if (focusIdx <= 0) {
						e.preventDefault();
						containerRef.current?.focus();
					} else {
						e.preventDefault();
						focusables[focusIdx - 1].focus();
					}
				} else {
					if (focusIdx === -1) {
						e.preventDefault();
						focusables[0].focus();
					} else if (focusIdx >= focusables.length - 1) {
						e.preventDefault();
						containerRef.current?.focus();
					} else {
						e.preventDefault();
						focusables[focusIdx + 1].focus();
					}
				}
				return;
			}

			// Arrow navigation over rows (headers + items)
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				if (rows.length === 0) return;
				setSelectedRowIndex((prev) => Math.min(prev + 1, rows.length - 1));
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				if (rows.length === 0) return;
				setSelectedRowIndex((prev) => Math.max(prev - 1, 0));
				return;
			}

			// T / Enter on a header → toggle group
			// Enter on an item → navigate to session
			if (e.key === 'Enter') {
				e.preventDefault();
				const row = rows[selectedRowIndex];
				if (!row) return;
				if (row.type === 'header') {
					toggleGroup(row.groupKey);
				} else {
					handleNavigate(row.item);
				}
				return;
			}

			// T to toggle group (works on headers AND items)
			if ((e.key === 't' || e.key === 'T') && !e.metaKey && !e.ctrlKey && !e.altKey) {
				if (sortMode === 'grouped' || sortMode === 'byAgent') {
					e.preventDefault();
					const row = rows[selectedRowIndex];
					if (!row) return;
					if (row.type === 'header') {
						toggleGroup(row.groupKey);
					} else {
						toggleGroup(getGroupCollapseKey(row.item, sortMode));
					}
				}
				return;
			}

			// Cmd/Ctrl+1-9, 0 hotkeys for quick select (visible-item based)
			if (
				(e.metaKey || e.ctrlKey) &&
				['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].includes(e.key)
			) {
				e.preventDefault();
				const number = e.key === '0' ? 10 : parseInt(e.key);
				const targetRowIndex = visibleItemByNumber.get(number);
				if (targetRowIndex !== undefined) {
					const targetRow = rows[targetRowIndex];
					if (targetRow && targetRow.type === 'item') {
						handleNavigate(targetRow.item);
					}
				}
				return;
			}
		},
		[
			getHeaderFocusables,
			containerRef,
			rows,
			selectedRowIndex,
			sortMode,
			visibleItemByNumber,
			toggleGroup,
			handleNavigate,
		]
	);

	// Expose keyboard handler to shell via ref
	useEffect(() => {
		if (keyDownRef) keyDownRef.current = handleKeyDown;
		return () => {
			if (keyDownRef) keyDownRef.current = null;
		};
	}, [keyDownRef, handleKeyDown]);

	const actionCount = items.length;

	// Filter-aware count label
	const countLabel =
		filterMode === 'unread'
			? `${actionCount} unread`
			: filterMode === 'starred'
				? `${actionCount} starred`
				: filterMode === 'read'
					? `${actionCount} read`
					: `${actionCount} need action`;

	return (
		<>
			{/* Header — 80px, two rows */}
			<div
				ref={headerRef}
				className="px-4 py-3 border-b"
				style={{
					height: MODAL_HEADER_HEIGHT,
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
					display: 'flex',
					flexDirection: 'column',
					justifyContent: 'center',
					gap: 8,
				}}
			>
				{/* Header row 1: title + badge + close */}
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<Bot className="w-5 h-5" style={{ color: theme.colors.accent }} />
						<h2 className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
							Unified Inbox
						</h2>
						<span
							aria-live="polite"
							className="text-xs px-2 py-0.5 rounded-full"
							style={{
								backgroundColor: `${theme.colors.accent}20`,
								color: theme.colors.accent,
							}}
						>
							{countLabel}
						</span>
					</div>
					<div className="flex items-center gap-2">
						<button
							onClick={() => {
								if (items.length > 0 && items[selectedIndex]) {
									onEnterFocus(items[selectedIndex]);
								}
							}}
							disabled={items.length === 0}
							className="text-xs px-2.5 py-1 rounded transition-colors"
							style={{
								backgroundColor: items.length > 0 ? `${theme.colors.accent}15` : 'transparent',
								color: items.length > 0 ? theme.colors.accent : theme.colors.textDim,
								cursor: items.length > 0 ? 'pointer' : 'default',
								opacity: items.length === 0 ? 0.5 : 1,
							}}
							onMouseEnter={(e) => {
								if (items.length > 0) {
									e.currentTarget.style.backgroundColor = `${theme.colors.accent}25`;
								}
							}}
							onMouseLeave={(e) => {
								if (items.length > 0) {
									e.currentTarget.style.backgroundColor = `${theme.colors.accent}15`;
								}
							}}
							onFocus={(e) => {
								e.currentTarget.style.outline = `2px solid ${theme.colors.accent}`;
							}}
							onBlur={(e) => {
								e.currentTarget.style.outline = 'none';
							}}
							title="Enter Focus Mode (F)"
						>
							Focus ▶
						</button>
						<button
							onClick={() => onToggleExpanded((prev) => !prev)}
							className="p-1.5 rounded"
							style={{ color: theme.colors.textDim }}
							onMouseEnter={(e) =>
								(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
							}
							onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
							onFocus={(e) => {
								e.currentTarget.style.outline = `2px solid ${theme.colors.accent}`;
							}}
							onBlur={(e) => {
								e.currentTarget.style.outline = 'none';
							}}
							title={isExpanded ? 'Collapse' : 'Expand'}
							aria-label={isExpanded ? 'Collapse modal' : 'Expand modal'}
						>
							{isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
						</button>
						<button
							onClick={onClose}
							className="p-1.5 rounded"
							style={{ color: theme.colors.textDim }}
							onMouseEnter={(e) =>
								(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
							}
							onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
							onFocus={(e) => {
								e.currentTarget.style.outline = `2px solid ${theme.colors.accent}`;
							}}
							onBlur={(e) => {
								e.currentTarget.style.outline = 'none';
							}}
							title="Close (Esc)"
						>
							<X className="w-4 h-4" />
						</button>
					</div>
				</div>
				{/* Header row 2: sort + filter controls */}
				<div className="flex items-center justify-between">
					<SegmentedControl
						options={SORT_OPTIONS}
						value={sortMode}
						onChange={setSortMode}
						theme={theme}
						ariaLabel="Sort agents"
					/>
					<SegmentedControl
						options={FILTER_OPTIONS}
						value={filterMode}
						onChange={setFilterMode}
						theme={theme}
						ariaLabel="Filter agents"
					/>
				</div>
			</div>

			{/* Stats strip — 32px aggregate metrics */}
			<InboxStatsStrip items={items} theme={theme} />

			{/* Body — virtualized list */}
			<div
				ref={containerRef as React.RefObject<HTMLDivElement>}
				role="listbox"
				tabIndex={0}
				onKeyDown={handleKeyDown}
				aria-activedescendant={selectedItemId}
				aria-label="Inbox items"
				className="outline-none"
				style={{ flex: 1, overflow: 'hidden' }}
				onFocus={(e) => {
					e.currentTarget.style.outline = `2px solid ${theme.colors.accent}`;
					e.currentTarget.style.outlineOffset = '-2px';
				}}
				onBlur={(e) => {
					e.currentTarget.style.outline = 'none';
				}}
			>
				{rows.length === 0 ? (
					<div
						data-testid="inbox-empty-state"
						className="flex flex-col items-center justify-center gap-3"
						style={{ height: listHeight, color: theme.colors.textDim }}
					>
						{EMPTY_STATE_MESSAGES[filterMode].showIcon && (
							<CheckCircle
								data-testid="inbox-empty-icon"
								style={{
									width: 32,
									height: 32,
									color: theme.colors.textDim,
									opacity: 0.5,
								}}
							/>
						)}
						<span
							style={{
								fontSize: 14,
								color: theme.colors.textDim,
								maxWidth: 280,
								textAlign: 'center',
							}}
						>
							{EMPTY_STATE_MESSAGES[filterMode].text}
						</span>
					</div>
				) : (
					<div
						ref={scrollContainerRef}
						style={{
							height: listHeight,
							overflow: 'auto',
						}}
					>
						<div
							style={{
								height: `${virtualizer.getTotalSize()}px`,
								width: '100%',
								position: 'relative',
							}}
						>
							{virtualizer.getVirtualItems().map((virtualRow) => {
								const row = rows[virtualRow.index];
								if (!row) return null;
								const isRowSelected = virtualRow.index === selectedRowIndex;

								if (row.type === 'header') {
									const isCollapsed = collapsedGroups.has(row.groupKey);

									// For byAgent mode: derive agent type label and unread count from subsequent rows
									let agentToolType: string | undefined;
									let unreadCount = 0;
									if (sortMode === 'byAgent') {
										for (let i = virtualRow.index + 1; i < rows.length; i++) {
											const r = rows[i];
											if (r.type === 'header') break;
											if (r.type === 'item') {
												if (!agentToolType) agentToolType = r.item.toolType;
												if (r.item.hasUnread) unreadCount++;
											}
										}
									}

									return (
										<button
											type="button"
											key={`header-${row.groupKey}`}
											className="outline-none"
											onFocus={(e) => {
												e.currentTarget.style.boxShadow = `inset 0 0 0 2px ${theme.colors.accent}`;
											}}
											onBlur={(e) => {
												e.currentTarget.style.boxShadow = 'none';
											}}
											style={{
												position: 'absolute',
												top: 0,
												left: 0,
												width: '100%',
												height: `${virtualRow.size}px`,
												transform: `translateY(${virtualRow.start}px)`,
												display: 'flex',
												alignItems: 'center',
												paddingLeft: 16,
												paddingRight: 16,
												fontSize: 13,
												fontWeight: 600,
												color: isRowSelected ? theme.colors.accent : theme.colors.textDim,
												letterSpacing: '0.5px',
												textTransform: 'uppercase',
												borderBottom: `2px solid ${theme.colors.border}40`,
												borderLeft: isRowSelected
													? `3px solid ${theme.colors.accent}`
													: '3px solid transparent',
												backgroundColor: isRowSelected ? `${theme.colors.accent}10` : 'transparent',
												cursor: 'pointer',
												borderTop: 'none',
												borderRight: 'none',
												textAlign: 'left',
											}}
											onClick={() => toggleGroup(row.groupKey)}
											onKeyDown={(e) => {
												if (e.key === 'Enter' || e.key === ' ') {
													e.preventDefault();
													toggleGroup(row.groupKey);
												}
											}}
										>
											{isCollapsed ? (
												<ChevronRight
													style={{ width: 14, height: 14, marginRight: 4, flexShrink: 0 }}
												/>
											) : (
												<ChevronDown
													style={{ width: 14, height: 14, marginRight: 4, flexShrink: 0 }}
												/>
											)}
											{row.groupName}
											{sortMode === 'byAgent' && agentToolType && (
												<span
													style={{
														fontSize: 11,
														color: theme.colors.textDim,
														fontWeight: 400,
														marginLeft: 4,
													}}
												>
													({TOOL_TYPE_LABELS[agentToolType] ?? agentToolType})
												</span>
											)}
											{sortMode === 'byAgent' && unreadCount > 0 && (
												<span
													style={{
														fontSize: 11,
														marginLeft: 'auto',
														padding: '1px 6px',
														borderRadius: 10,
														backgroundColor: theme.colors.warning + '20',
														color: theme.colors.warning,
													}}
												>
													{unreadCount} unread
												</span>
											)}
										</button>
									);
								}

								const isLastRow = virtualRow.index === rows.length - 1;
								const visibleNum = visibleItemNumbers.get(virtualRow.index);
								const showNumber = visibleNum !== undefined && visibleNum >= 1 && visibleNum <= 10;
								const numberBadge = visibleNum === 10 ? 0 : visibleNum;

								// Stagger animation: only on initial mount, capped at 300ms (10 items)
								const animationDelay = isInitialMount
									? `${Math.min(virtualRow.index * 30, 300)}ms`
									: undefined;

								return (
									<div
										key={`item-${row.item.sessionId}-${row.item.tabId}`}
										className={isInitialMount ? 'inbox-card-enter' : undefined}
										style={{
											position: 'absolute',
											top: 0,
											left: 0,
											width: '100%',
											height: `${virtualRow.size}px`,
											transform: `translateY(${virtualRow.start}px)`,
											paddingLeft: 16,
											paddingRight: 16,
											paddingTop: 6,
											paddingBottom: 6,
											borderBottom: isLastRow ? undefined : `1px solid ${theme.colors.border}40`,
											animationDelay,
										}}
									>
										<div style={{ display: 'flex', alignItems: 'center', gap: 8, height: '100%' }}>
											{showNumber ? (
												<div
													className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-xs font-bold"
													style={{
														backgroundColor: theme.colors.bgMain,
														color: theme.colors.textDim,
														border: `1px solid ${theme.colors.border}`,
													}}
													data-testid="number-badge"
												>
													{numberBadge}
												</div>
											) : (
												<div className="flex-shrink-0 w-5 h-5" />
											)}
											<div style={{ flex: 1, minWidth: 0 }}>
												<InboxItemCardContent
													item={row.item}
													theme={theme}
													isSelected={isRowSelected}
													onClick={() => setSelectedRowIndex(virtualRow.index)}
													onDoubleClick={() => onEnterFocus(row.item)}
												/>
											</div>
										</div>
									</div>
								);
							})}
						</div>
					</div>
				)}
			</div>

			{/* Footer — 36px */}
			<div
				className="flex items-center justify-between px-4 py-2 border-t text-xs"
				style={{
					height: MODAL_FOOTER_HEIGHT,
					borderColor: theme.colors.border,
					color: theme.colors.textDim,
				}}
			>
				<span>{countLabel}</span>
				<span>{`↑↓ navigate • ${sortMode === 'grouped' || sortMode === 'byAgent' ? 'T collapse • ' : ''}F focus • Enter open • ${formatShortcutKeys(['Meta'])}1-9 quick select • Esc close`}</span>
			</div>
		</>
	);
}
