import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { List, type ListImperativeAPI } from 'react-window';
import { X } from 'lucide-react';
import type { Theme, Session, Group, SessionState } from '../types';
import type { InboxItem, InboxFilterMode, InboxSortMode } from '../types/agent-inbox';
import { STATUS_LABELS, STATUS_COLORS } from '../types/agent-inbox';
import { useAgentInbox } from '../hooks/useAgentInbox';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { formatRelativeTime } from '../utils/formatters';

interface AgentInboxProps {
	theme: Theme;
	sessions: Session[];
	groups: Group[];
	onClose: () => void;
	onNavigateToSession?: (sessionId: string, tabId?: string) => void;
}

const ITEM_HEIGHT = 80;
const GROUP_HEADER_HEIGHT = 36;
const MODAL_HEADER_HEIGHT = 48;
const MODAL_FOOTER_HEIGHT = 36;

// ============================================================================
// Grouped list model: interleaves group headers with items when sort = 'grouped'
// ============================================================================
type ListRow =
	| { type: 'header'; groupName: string }
	| { type: 'item'; item: InboxItem; index: number };

function buildRows(items: InboxItem[], sortMode: InboxSortMode): ListRow[] {
	if (sortMode !== 'grouped') {
		return items.map((item, index) => ({ type: 'item' as const, item, index }));
	}
	const rows: ListRow[] = [];
	let lastGroup: string | undefined | null = null;
	let itemIndex = 0;
	for (const item of items) {
		const group = item.groupName ?? null;
		if (group !== lastGroup) {
			rows.push({ type: 'header', groupName: group ?? 'Ungrouped' });
			lastGroup = group;
		}
		rows.push({ type: 'item', item, index: itemIndex });
		itemIndex++;
	}
	return rows;
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
// InboxItemCard — rendered inside each row
// ============================================================================
function InboxItemCardContent({
	item,
	theme,
	isSelected,
	onClick,
}: {
	item: InboxItem;
	theme: Theme;
	isSelected: boolean;
	onClick: () => void;
}) {
	const statusColor = resolveStatusColor(item.state, theme);

	return (
		<div
			role="option"
			aria-selected={isSelected}
			id={`inbox-item-${item.sessionId}-${item.tabId}`}
			onClick={onClick}
			style={{
				height: ITEM_HEIGHT - 12,
				padding: '8px 12px',
				borderRadius: 8,
				cursor: 'pointer',
				backgroundColor: isSelected ? `${theme.colors.accent}15` : 'transparent',
				display: 'flex',
				flexDirection: 'column',
				justifyContent: 'center',
				gap: 4,
				outline: isSelected ? `2px solid ${theme.colors.accent}` : 'none',
				outlineOffset: -2,
			}}
		>
			{/* Row 1: group / session name + timestamp */}
			<div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
				{item.groupName && (
					<>
						<span style={{ fontSize: 12, color: theme.colors.textDim, whiteSpace: 'nowrap' }}>
							{item.groupName}
						</span>
						<span style={{ fontSize: 12, color: theme.colors.textDim }}>/</span>
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
				</span>
				<span style={{ fontSize: 12, color: theme.colors.textDim, whiteSpace: 'nowrap', flexShrink: 0 }}>
					{formatRelativeTime(item.timestamp)}
				</span>
			</div>

			{/* Row 2: last message */}
			<div
				style={{
					fontSize: 13,
					color: theme.colors.textDim,
					overflow: 'hidden',
					textOverflow: 'ellipsis',
					whiteSpace: 'nowrap',
				}}
			>
				{item.lastMessage}
			</div>

			{/* Row 3: badges */}
			<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
				{item.gitBranch && (
					<span
						style={{
							fontSize: 11,
							fontFamily: 'monospace',
							padding: '1px 6px',
							borderRadius: 4,
							backgroundColor: `${theme.colors.accent}15`,
							color: theme.colors.accent,
							whiteSpace: 'nowrap',
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							maxWidth: 160,
						}}
					>
						{item.gitBranch}
					</span>
				)}
				{item.contextUsage !== undefined && (
					<span style={{ fontSize: 11, color: theme.colors.textDim }}>
						Context: {item.contextUsage}%
					</span>
				)}
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
}

function SegmentedControl<T extends string>({
	options,
	value,
	onChange,
	theme,
}: SegmentedControlProps<T>) {
	return (
		<div
			style={{
				display: 'inline-flex',
				borderRadius: 6,
				border: `1px solid ${theme.colors.border}`,
				overflow: 'hidden',
			}}
		>
			{options.map((opt) => (
				<button
					key={opt.value}
					onClick={() => onChange(opt.value)}
					style={{
						padding: '3px 10px',
						fontSize: 12,
						border: 'none',
						cursor: 'pointer',
						backgroundColor: value === opt.value ? theme.colors.accent : 'transparent',
						color: value === opt.value ? theme.colors.accentForeground : theme.colors.textDim,
						outline: 'none',
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
			))}
		</div>
	);
}

// ============================================================================
// Row component for react-window v2 List
// ============================================================================
interface RowExtraProps {
	rows: ListRow[];
	theme: Theme;
	selectedIndex: number;
	onNavigate: (item: InboxItem) => void;
}

function InboxRow({
	index,
	style,
	rows,
	theme,
	selectedIndex,
	onNavigate,
}: {
	ariaAttributes: { 'aria-posinset': number; 'aria-setsize': number; role: 'listitem' };
	index: number;
	style: React.CSSProperties;
} & RowExtraProps) {
	const row = rows[index];
	if (!row) return null;

	if (row.type === 'header') {
		return (
			<div
				style={{
					...style,
					display: 'flex',
					alignItems: 'center',
					paddingLeft: 16,
					fontSize: 12,
					fontWeight: 600,
					color: theme.colors.textDim,
					letterSpacing: '0.5px',
					textTransform: 'uppercase',
				}}
			>
				{row.groupName}
			</div>
		);
	}

	return (
		<div
			style={{
				...style,
				paddingLeft: 16,
				paddingRight: 16,
				paddingTop: 6,
				paddingBottom: 6,
			}}
		>
			<InboxItemCardContent
				item={row.item}
				theme={theme}
				isSelected={row.index === selectedIndex}
				onClick={() => onNavigate(row.item)}
			/>
		</div>
	);
}

// ============================================================================
// AgentInbox Component
// ============================================================================
const SORT_OPTIONS: { value: InboxSortMode; label: string }[] = [
	{ value: 'newest', label: 'Newest' },
	{ value: 'oldest', label: 'Oldest' },
	{ value: 'grouped', label: 'Grouped' },
];

const FILTER_OPTIONS: { value: InboxFilterMode; label: string }[] = [
	{ value: 'all', label: 'All' },
	{ value: 'needs_input', label: 'Needs Input' },
	{ value: 'ready', label: 'Ready' },
];

export default function AgentInbox({
	theme,
	sessions,
	groups,
	onClose,
	onNavigateToSession,
}: AgentInboxProps) {
	const [filterMode, setFilterMode] = useState<InboxFilterMode>('all');
	const [sortMode, setSortMode] = useState<InboxSortMode>('newest');
	const [selectedIndex, setSelectedIndex] = useState(0);

	const items = useAgentInbox(sessions, groups, filterMode, sortMode);
	const rows = useMemo(() => buildRows(items, sortMode), [items, sortMode]);

	// Store trigger element ref for focus restoration
	const triggerRef = useRef<Element | null>(null);
	useEffect(() => {
		triggerRef.current = document.activeElement;
	}, []);

	// Restore focus on close
	const handleClose = useCallback(() => {
		onClose();
		requestAnimationFrame(() => {
			if (triggerRef.current && triggerRef.current instanceof HTMLElement) {
				triggerRef.current.focus();
			}
		});
	}, [onClose]);

	// Layer stack registration via useModalLayer
	useModalLayer(MODAL_PRIORITIES.AGENT_INBOX, 'Agent Inbox', handleClose);

	// Ref to the virtualized list
	const listRef = useRef<ListImperativeAPI | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	// Reset selection when items change
	useEffect(() => {
		setSelectedIndex(0);
	}, [items]);

	// Focus the container on mount for keyboard nav
	useEffect(() => {
		containerRef.current?.focus();
	}, []);

	// Scroll to selected item
	useEffect(() => {
		if (listRef.current && rows.length > 0) {
			const rowIndex = findRowIndexForItem(selectedIndex);
			if (rowIndex >= 0) {
				listRef.current.scrollToRow({ index: rowIndex, align: 'smart' });
			}
		}
	}, [selectedIndex, rows]);

	// Map item index → row index (accounts for group headers)
	const findRowIndexForItem = useCallback(
		(itemIdx: number): number => {
			for (let i = 0; i < rows.length; i++) {
				const row = rows[i];
				if (row.type === 'item' && row.index === itemIdx) return i;
			}
			return 0;
		},
		[rows]
	);

	// Get the selected item's element ID for aria-activedescendant
	const selectedItemId = useMemo(() => {
		if (items.length === 0) return undefined;
		const item = items[selectedIndex];
		if (!item) return undefined;
		return `inbox-item-${item.sessionId}-${item.tabId}`;
	}, [items, selectedIndex]);

	const handleNavigate = useCallback(
		(item: InboxItem) => {
			if (onNavigateToSession) {
				onNavigateToSession(item.sessionId, item.tabId);
			}
			handleClose();
		},
		[onNavigateToSession, handleClose]
	);

	// Keyboard navigation
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (items.length === 0) return;

			switch (e.key) {
				case 'ArrowUp':
					e.preventDefault();
					setSelectedIndex((prev) => (prev <= 0 ? items.length - 1 : prev - 1));
					break;
				case 'ArrowDown':
					e.preventDefault();
					setSelectedIndex((prev) => (prev >= items.length - 1 ? 0 : prev + 1));
					break;
				case 'Enter':
					e.preventDefault();
					if (items[selectedIndex]) {
						handleNavigate(items[selectedIndex]);
					}
					break;
			}
		},
		[items, selectedIndex, handleNavigate]
	);

	// Row height getter for variable-size rows
	const getRowHeight = useCallback(
		(index: number): number => {
			const row = rows[index];
			if (!row) return ITEM_HEIGHT;
			return row.type === 'header' ? GROUP_HEADER_HEIGHT : ITEM_HEIGHT;
		},
		[rows]
	);

	// Row props passed to react-window v2 List
	const rowProps: RowExtraProps = useMemo(
		() => ({
			rows,
			theme,
			selectedIndex,
			onNavigate: handleNavigate,
		}),
		[rows, theme, selectedIndex, handleNavigate]
	);

	// Calculate list height
	const listHeight = useMemo(() => {
		if (typeof window === 'undefined') return 400;
		return Math.min(
			window.innerHeight * 0.8 - MODAL_HEADER_HEIGHT - MODAL_FOOTER_HEIGHT - 80,
			600
		);
	}, []);

	const actionCount = items.length;

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
				aria-label="Agent Inbox"
				className="w-[600px] rounded-xl shadow-2xl border overflow-hidden flex flex-col outline-none"
				style={{
					backgroundColor: theme.colors.bgActivity,
					borderColor: theme.colors.border,
					maxHeight: '80vh',
				}}
				onClick={(e) => e.stopPropagation()}
				onKeyDown={handleKeyDown}
			>
				{/* Header — 48px */}
				<div
					className="flex items-center justify-between px-4 border-b"
					style={{
						height: MODAL_HEADER_HEIGHT,
						borderColor: theme.colors.border,
					}}
				>
					<div className="flex items-center gap-3">
						<h2 className="text-base font-semibold" style={{ color: theme.colors.textMain }}>
							Inbox
						</h2>
						<span
							aria-live="polite"
							className="text-xs px-2 py-0.5 rounded-full"
							style={{
								backgroundColor: `${theme.colors.accent}20`,
								color: theme.colors.accent,
							}}
						>
							{actionCount} need action
						</span>
					</div>
					<div className="flex items-center gap-2">
						<SegmentedControl
							options={SORT_OPTIONS}
							value={sortMode}
							onChange={setSortMode}
							theme={theme}
						/>
						<SegmentedControl
							options={FILTER_OPTIONS}
							value={filterMode}
							onChange={setFilterMode}
							theme={theme}
						/>
						<button
							onClick={handleClose}
							className="p-1.5 rounded"
							style={{ color: theme.colors.textDim }}
							onMouseEnter={(e) =>
								(e.currentTarget.style.backgroundColor = `${theme.colors.accent}20`)
							}
							onMouseLeave={(e) =>
								(e.currentTarget.style.backgroundColor = 'transparent')
							}
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

				{/* Body — virtualized list */}
				<div
					role="listbox"
					aria-activedescendant={selectedItemId}
					aria-label="Inbox items"
					style={{ flex: 1, overflow: 'hidden' }}
				>
					{rows.length === 0 ? (
						<div
							className="flex items-center justify-center"
							style={{ height: 120, color: theme.colors.textDim, fontSize: 14 }}
						>
							No items match the current filter
						</div>
					) : (
						<List
							listRef={listRef}
							rowComponent={InboxRow}
							rowCount={rows.length}
							rowHeight={getRowHeight}
							rowProps={rowProps}
							style={{ height: listHeight }}
						/>
					)}
				</div>

				{/* Footer — 36px */}
				<div
					className="flex items-center justify-center gap-6 px-4 border-t text-xs"
					style={{
						height: MODAL_FOOTER_HEIGHT,
						borderColor: theme.colors.border,
						color: theme.colors.textDim,
					}}
				>
					<span>↑↓ Navigate</span>
					<span>Enter Open</span>
					<span>Esc Close</span>
				</div>
			</div>
		</div>
	);
}
