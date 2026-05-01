/**
 * KanbanBoard — Agent Dispatch desktop kanban board.
 *
 * Columns correspond to canonical Work Graph lifecycle statuses.
 * Cards support drag/drop to change status (calls lifecycle APIs) and
 * drag to an agent lane to create a manual claim.
 *
 * Performance: columns with many cards are virtualized via @tanstack/react-virtual.
 */

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Inbox, Loader2, RefreshCw, ServerCrash } from 'lucide-react';
import type { Theme, WorkItem, WorkItemStatus } from '../../types';
import type { AgentDispatchFleetEntry } from '../../../shared/agent-dispatch-types';
import { agentDispatchService } from '../../services/agentDispatch';
import { workGraphService } from '../../services/workGraph';
import { notifyToast } from '../../stores/notificationStore';
import { EmptyState, InlineHelp } from '../ui';
import { DispatchCard } from './DispatchCard';
import { DispatchCardDetail } from './DispatchCardDetail';
import { DispatchFilters, EMPTY_FILTERS, hasActiveFilters } from './DispatchFilters';
import type { KanbanFilters } from './DispatchFilters';

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

interface ColumnDef {
	status: WorkItemStatus;
	label: string;
	accentKey: 'success' | 'warning' | 'error' | 'accent' | 'textDim';
}

const COLUMNS: ColumnDef[] = [
	{ status: 'ready', label: 'Ready', accentKey: 'success' },
	{ status: 'claimed', label: 'Claimed', accentKey: 'warning' },
	{ status: 'in_progress', label: 'In Progress', accentKey: 'accent' },
	{ status: 'blocked', label: 'Blocked', accentKey: 'error' },
	{ status: 'review', label: 'Review', accentKey: 'accent' },
	{ status: 'done', label: 'Done', accentKey: 'textDim' },
];

const VALID_DROP_STATUSES: WorkItemStatus[] = COLUMNS.map((c) => c.status);

// ---------------------------------------------------------------------------
// Virtualized column
// ---------------------------------------------------------------------------

interface VirtualColumnProps {
	items: WorkItem[];
	column: ColumnDef;
	theme: Theme;
	draggingId: string | null;
	dropTargetStatus: WorkItemStatus | null;
	onDragStart: (e: React.DragEvent<HTMLDivElement>, item: WorkItem) => void;
	onDragOver: (e: React.DragEvent<HTMLDivElement>, status: WorkItemStatus) => void;
	onDrop: (e: React.DragEvent<HTMLDivElement>, status: WorkItemStatus) => void;
	onDragLeave: () => void;
	onSelect: (item: WorkItem) => void;
}

const CARD_ESTIMATED_HEIGHT = 96;
const CARD_GAP = 8;

const VirtualColumn = memo(function VirtualColumn({
	items,
	column,
	theme,
	draggingId,
	dropTargetStatus,
	onDragStart,
	onDragOver,
	onDrop,
	onDragLeave,
	onSelect,
}: VirtualColumnProps) {
	const listRef = useRef<HTMLDivElement>(null);
	const accentColor = theme.colors[column.accentKey];
	const isDropTarget = dropTargetStatus === column.status;

	const virtualizer = useVirtualizer({
		count: items.length,
		getScrollElement: () => listRef.current,
		estimateSize: () => CARD_ESTIMATED_HEIGHT,
		gap: CARD_GAP,
		overscan: 3,
		initialRect: { width: 220, height: 600 },
	});

	return (
		<div
			className="flex flex-col shrink-0 rounded border"
			style={{
				width: 240,
				borderColor: isDropTarget ? accentColor : theme.colors.border,
				backgroundColor: isDropTarget ? `${accentColor}08` : theme.colors.bgSidebar,
				transition: 'border-color 0.15s, background-color 0.15s',
			}}
			onDragOver={(e) => onDragOver(e, column.status)}
			onDrop={(e) => onDrop(e, column.status)}
			onDragLeave={onDragLeave}
		>
			{/* Column header */}
			<div
				className="flex items-center justify-between px-3 py-2 border-b shrink-0"
				style={{ borderColor: theme.colors.border }}
			>
				<span className="text-xs font-bold" style={{ color: accentColor }}>
					{column.label}
				</span>
				<span
					className="text-[10px] rounded-full px-1.5 py-0.5 font-bold"
					style={{ backgroundColor: `${accentColor}20`, color: accentColor }}
				>
					{items.length}
				</span>
			</div>

			{/* Virtualized card list */}
			<div
				ref={listRef}
				className="flex-1 overflow-y-auto px-2 py-2 scrollbar-thin"
				style={{ minHeight: 120, maxHeight: 'calc(100vh - 280px)' }}
			>
				{items.length === 0 ? (
					<EmptyState
						theme={theme}
						icon={<Inbox className="w-6 h-6" />}
						title="No items"
						className="py-4"
					/>
				) : (
					<div
						style={{
							height: virtualizer.getTotalSize(),
							width: '100%',
							position: 'relative',
						}}
					>
						{virtualizer.getVirtualItems().map((virtualRow) => {
							const item = items[virtualRow.index];
							return (
								<div
									key={item.id}
									data-index={virtualRow.index}
									ref={virtualizer.measureElement}
									style={{
										position: 'absolute',
										top: 0,
										left: 0,
										width: '100%',
										transform: `translateY(${virtualRow.start}px)`,
									}}
								>
									<DispatchCard
										item={item}
										theme={theme}
										isDragging={draggingId === item.id}
										onSelect={onSelect}
										onDragStart={onDragStart}
									/>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
});

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

function applyFilters(items: WorkItem[], filters: KanbanFilters): WorkItem[] {
	if (!hasActiveFilters(filters)) return items;
	return items.filter((item) => {
		if (filters.statuses.length > 0 && !filters.statuses.includes(item.status)) return false;
		if (filters.types.length > 0 && !filters.types.includes(item.type)) return false;
		if (filters.tags.length > 0 && !filters.tags.some((t) => item.tags.includes(t))) return false;
		if (filters.ownerIds.length > 0 && (!item.owner || !filters.ownerIds.includes(item.owner.id)))
			return false;
		if (
			filters.capabilities.length > 0 &&
			!filters.capabilities.some((c) => item.capabilities?.includes(c))
		)
			return false;
		if (
			filters.claimHolderIds.length > 0 &&
			(!item.claim ||
				item.claim.status !== 'active' ||
				!item.claim.owner ||
				!filters.claimHolderIds.includes(item.claim.owner.id))
		)
			return false;
		if (filters.projectPaths.length > 0 && !filters.projectPaths.includes(item.projectPath))
			return false;
		return true;
	});
}

function deriveAvailableValues(items: WorkItem[]) {
	const tagSet = new Set<string>();
	const ownerMap = new Map<string, string>();
	const capSet = new Set<string>();
	const claimMap = new Map<string, string>();
	const projectSet = new Set<string>();

	for (const item of items) {
		item.tags.forEach((t) => tagSet.add(t));
		if (item.owner) ownerMap.set(item.owner.id, item.owner.name ?? item.owner.id);
		(item.capabilities ?? []).forEach((c) => capSet.add(c));
		if (item.claim?.status === 'active' && item.claim.owner) {
			claimMap.set(item.claim.owner.id, item.claim.owner.name ?? item.claim.owner.id);
		}
		if (item.projectPath) projectSet.add(item.projectPath);
	}

	return {
		tags: Array.from(tagSet).sort(),
		owners: Array.from(ownerMap.entries()).map(([id, name]) => ({ id, name })),
		capabilities: Array.from(capSet).sort(),
		claimHolders: Array.from(claimMap.entries()).map(([id, name]) => ({ id, name })),
		projects: Array.from(projectSet).sort(),
	};
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

export interface KanbanBoardProps {
	theme: Theme;
}

export const KanbanBoard = memo(function KanbanBoard({ theme }: KanbanBoardProps) {
	const [allItems, setAllItems] = useState<WorkItem[]>([]);
	const [fleet, setFleet] = useState<AgentDispatchFleetEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [filters, setFilters] = useState<KanbanFilters>(EMPTY_FILTERS);
	const [filtersOpen, setFiltersOpen] = useState(false);
	const [selectedItem, setSelectedItem] = useState<WorkItem | null>(null);
	const [draggingId, setDraggingId] = useState<string | null>(null);
	const [dropTargetStatus, setDropTargetStatus] = useState<WorkItemStatus | null>(null);

	// ---------------------------------------------------------------------------
	// Data fetching
	// ---------------------------------------------------------------------------

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [boardResult, fleetResult] = await Promise.all([
				// #444: getBoard() takes no filters — returns in-memory ClaimTracker state.
				agentDispatchService.getBoard(),
				agentDispatchService.getFleet(),
			]);
			setAllItems(boardResult.items as WorkItem[]);
			setFleet(fleetResult);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	// ---------------------------------------------------------------------------
	// Derived data
	// ---------------------------------------------------------------------------

	const filteredItems = useMemo(() => applyFilters(allItems, filters), [allItems, filters]);

	const columnItems = useMemo<Record<WorkItemStatus, WorkItem[]>>(() => {
		const map = Object.fromEntries(COLUMNS.map((c) => [c.status, [] as WorkItem[]])) as Record<
			WorkItemStatus,
			WorkItem[]
		>;
		for (const item of filteredItems) {
			if (map[item.status]) {
				map[item.status].push(item);
			}
		}
		return map;
	}, [filteredItems]);

	const available = useMemo(() => deriveAvailableValues(allItems), [allItems]);

	// ---------------------------------------------------------------------------
	// Drag/drop
	// ---------------------------------------------------------------------------

	const handleDragStart = useCallback((_e: React.DragEvent<HTMLDivElement>, item: WorkItem) => {
		setDraggingId(item.id);
	}, []);

	const handleDragOver = useCallback(
		(e: React.DragEvent<HTMLDivElement>, status: WorkItemStatus) => {
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			setDropTargetStatus(status);
		},
		[]
	);

	const handleDragLeave = useCallback(() => {
		setDropTargetStatus(null);
	}, []);

	const handleDrop = useCallback(
		async (e: React.DragEvent<HTMLDivElement>, targetStatus: WorkItemStatus) => {
			e.preventDefault();
			setDropTargetStatus(null);
			const workItemId = e.dataTransfer.getData('workItemId');
			if (!workItemId) return;

			const item = allItems.find((i) => i.id === workItemId);
			if (!item || item.status === targetStatus) {
				setDraggingId(null);
				return;
			}

			if (!VALID_DROP_STATUSES.includes(targetStatus)) {
				setDraggingId(null);
				return;
			}

			// Optimistic update
			setAllItems((prev) =>
				prev.map((i) => (i.id === workItemId ? { ...i, status: targetStatus } : i))
			);
			setDraggingId(null);

			// If dropped on the claimed column, we attempt a manual assign to a ready agent
			if (targetStatus === 'claimed') {
				const readyAgent = fleet.find((a) => a.readiness === 'ready' || a.readiness === 'idle');
				const droppedItem = allItems.find((i) => i.id === workItemId);
				if (readyAgent && droppedItem) {
					try {
						await agentDispatchService.assignManually({
							workItemId,
							workItem: droppedItem,
							agent: readyAgent,
							userInitiated: true,
						});
					} catch (err) {
						notifyToast({
							color: 'red',
							title: 'Auto-assign failed',
							message: err instanceof Error ? err.message : String(err),
							dismissible: true,
						});
						// Revert optimistic update
						void load();
					}
					return;
				}
			}

			// Status-only update via Work Graph
			try {
				await workGraphService.updateItem({ id: workItemId, patch: { status: targetStatus } });
			} catch (err) {
				notifyToast({
					color: 'red',
					title: 'Status update failed',
					message: err instanceof Error ? err.message : String(err),
					dismissible: true,
				});
				void load();
			}
		},
		[allItems, fleet, load]
	);

	const handleDragEnd = useCallback(() => {
		setDraggingId(null);
		setDropTargetStatus(null);
	}, []);

	// ---------------------------------------------------------------------------
	// Selection
	// ---------------------------------------------------------------------------

	const handleSelect = useCallback((item: WorkItem) => {
		setSelectedItem((prev) => (prev?.id === item.id ? null : item));
	}, []);

	const handleCloseDetail = useCallback(() => setSelectedItem(null), []);

	// ---------------------------------------------------------------------------
	// Render
	// ---------------------------------------------------------------------------

	return (
		<div
			className="flex flex-col h-full overflow-hidden"
			style={{ backgroundColor: theme.colors.bgMain }}
			onDragEnd={handleDragEnd}
		>
			{/* Toolbar */}
			<div
				className="flex items-center justify-between px-4 py-2 border-b shrink-0"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex items-center gap-2">
					<span className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
						Agent Dispatch
					</span>
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						{filteredItems.length !== allItems.length
							? `${filteredItems.length} / ${allItems.length} items`
							: `${allItems.length} items`}
					</span>
				</div>
				<div className="flex items-center gap-2">
					<button
						onClick={() => setFiltersOpen((o) => !o)}
						className="text-xs rounded px-2 py-1 border transition-colors hover:opacity-80"
						style={{
							borderColor: hasActiveFilters(filters) ? theme.colors.accent : theme.colors.border,
							color: hasActiveFilters(filters) ? theme.colors.accent : theme.colors.textDim,
							backgroundColor: hasActiveFilters(filters)
								? `${theme.colors.accent}10`
								: 'transparent',
						}}
					>
						Filters{hasActiveFilters(filters) ? ' (active)' : ''}
					</button>
					<button
						onClick={() => void load()}
						disabled={loading}
						className="p-1.5 rounded border transition-colors hover:opacity-80 disabled:opacity-50"
						style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
						aria-label="Refresh board"
					>
						{loading ? (
							<Loader2 className="w-3.5 h-3.5 animate-spin" />
						) : (
							<RefreshCw className="w-3.5 h-3.5" />
						)}
					</button>
				</div>
			</div>

			{/* Filters */}
			{filtersOpen && (
				<DispatchFilters
					filters={filters}
					onChange={setFilters}
					theme={theme}
					availableTags={available.tags}
					availableOwners={available.owners}
					availableCapabilities={available.capabilities}
					availableClaimHolders={available.claimHolders}
					availableProjects={available.projects}
				/>
			)}

			{/* Error */}
			{error && (
				<EmptyState
					theme={theme}
					icon={<ServerCrash className="w-10 h-10" />}
					title="Failed to load board"
					description={error}
					primaryAction={{ label: 'Retry', onClick: () => void load() }}
					helpHref="https://docs.runmaestro.ai/agent-dispatch"
					helpLabel="Agent Dispatch docs"
					className="flex-1"
				/>
			)}

			{/* Board + Detail */}
			{!error && (
				<div className="flex flex-1 min-h-0">
					{/* Columns */}
					<div className="flex-1 overflow-x-auto overflow-y-hidden">
						{!loading && allItems.length === 0 ? (
							<div className="flex flex-col items-center justify-center h-full">
								<EmptyState
									theme={theme}
									icon={<Inbox className="w-10 h-10" />}
									title="No work items yet"
									description="Add tasks to the Work Graph to start dispatching."
									helpHref="https://docs.runmaestro.ai/agent-dispatch"
									helpLabel="Learn about Agent Dispatch"
								/>
								<div className="mt-1">
									<InlineHelp label="What is Agent Dispatch?">
										Agent Dispatch routes Work Graph items to agents automatically. Create tasks via
										the Delivery Planner or Work Graph MCP tools, then come back here to watch them
										move through the board.
									</InlineHelp>
								</div>
							</div>
						) : (
							<div className="flex gap-3 p-4 h-full" style={{ minWidth: COLUMNS.length * 256 }}>
								{COLUMNS.map((col) => (
									<VirtualColumn
										key={col.status}
										column={col}
										items={columnItems[col.status] ?? []}
										theme={theme}
										draggingId={draggingId}
										dropTargetStatus={dropTargetStatus}
										onDragStart={handleDragStart}
										onDragOver={handleDragOver}
										onDrop={handleDrop}
										onDragLeave={handleDragLeave}
										onSelect={handleSelect}
									/>
								))}
							</div>
						)}
					</div>

					{/* Detail panel */}
					{selectedItem && (
						<DispatchCardDetail
							item={selectedItem}
							theme={theme}
							fleet={fleet}
							onClose={handleCloseDetail}
							onRefresh={() => void load()}
						/>
					)}
				</div>
			)}
		</div>
	);
});
