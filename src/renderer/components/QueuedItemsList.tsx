import React, { useState, useCallback, useRef, memo } from 'react';
import { X, ChevronDown, ChevronUp, GripVertical } from 'lucide-react';
import type { Theme, QueuedItem } from '../types';

// ============================================================================
// QueuedItemsList - Displays queued execution items with expand/collapse
// ============================================================================

interface QueuedItemsListProps {
	executionQueue: QueuedItem[];
	theme: Theme;
	onRemoveQueuedItem?: (itemId: string) => void;
	onReorderItems?: (fromIndex: number, toIndex: number) => void;
	activeTabId?: string; // If provided, only show queued items for this tab
}

/**
 * QueuedItemsList displays the execution queue with:
 * - Queued message separator with count
 * - Individual queued items (commands/messages)
 * - Long message expand/collapse functionality
 * - Image attachment indicators
 * - Remove button with confirmation modal
 * - Drag-and-drop reordering
 */
export const QueuedItemsList = memo(
	({
		executionQueue,
		theme,
		onRemoveQueuedItem,
		onReorderItems,
		activeTabId,
	}: QueuedItemsListProps) => {
		// Filter to only show items for the active tab if activeTabId is provided
		const filteredQueue = activeTabId
			? executionQueue.filter((item) => item.tabId === activeTabId)
			: executionQueue;
		// Queue removal confirmation state
		const [queueRemoveConfirmId, setQueueRemoveConfirmId] = useState<string | null>(null);

		// Track which queued messages are expanded (for viewing full content)
		const [expandedQueuedMessages, setExpandedQueuedMessages] = useState<Set<string>>(new Set());

		// Drag state
		const [dragIndex, setDragIndex] = useState<number | null>(null);
		const [dropIndex, setDropIndex] = useState<number | null>(null);
		const dragItemRef = useRef<number | null>(null);

		// Can only drag if we have reorder handler and more than 1 item
		const canDrag = !!onReorderItems && filteredQueue.length > 1;

		// Toggle expanded state for a queued message
		const toggleExpanded = useCallback((itemId: string) => {
			setExpandedQueuedMessages((prev) => {
				const newSet = new Set(prev);
				if (newSet.has(itemId)) {
					newSet.delete(itemId);
				} else {
					newSet.add(itemId);
				}
				return newSet;
			});
		}, []);

		// Handle keyboard events on confirmation modal
		const handleModalKeyDown = useCallback(
			(e: React.KeyboardEvent) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					if (onRemoveQueuedItem && queueRemoveConfirmId) {
						onRemoveQueuedItem(queueRemoveConfirmId);
					}
					setQueueRemoveConfirmId(null);
				} else if (e.key === 'Escape') {
					e.preventDefault();
					setQueueRemoveConfirmId(null);
				}
			},
			[onRemoveQueuedItem, queueRemoveConfirmId]
		);

		// Handle confirm removal
		const handleConfirmRemove = useCallback(() => {
			if (onRemoveQueuedItem && queueRemoveConfirmId) {
				onRemoveQueuedItem(queueRemoveConfirmId);
			}
			setQueueRemoveConfirmId(null);
		}, [onRemoveQueuedItem, queueRemoveConfirmId]);

		// Drag handlers
		const handleDragStart = useCallback((index: number) => {
			dragItemRef.current = index;
			setDragIndex(index);
		}, []);

		const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
			e.preventDefault();
			if (dragItemRef.current !== null && dragItemRef.current !== index) {
				setDropIndex(index);
			}
		}, []);

		const handleDragEnd = useCallback(() => {
			if (dragItemRef.current !== null && dropIndex !== null && dragItemRef.current !== dropIndex) {
				onReorderItems?.(dragItemRef.current, dropIndex);
			}
			dragItemRef.current = null;
			setDragIndex(null);
			setDropIndex(null);
		}, [dropIndex, onReorderItems]);

		const handleDragLeave = useCallback(() => {
			setDropIndex(null);
		}, []);

		if (!filteredQueue || filteredQueue.length === 0) {
			return null;
		}

		return (
			<>
				{/* QUEUED separator */}
				<div className="mx-6 my-3 flex items-center gap-3">
					<div className="flex-1 h-px" style={{ backgroundColor: theme.colors.border }} />
					<span
						className="text-xs font-bold tracking-wider"
						style={{ color: theme.colors.warning }}
					>
						QUEUED ({filteredQueue.length})
					</span>
					<div className="flex-1 h-px" style={{ backgroundColor: theme.colors.border }} />
				</div>

				{/* Queued items */}
				{filteredQueue.map((item, index) => {
					const displayText = item.type === 'command' ? (item.command ?? '') : (item.text ?? '');
					const isLongMessage = displayText.length > 200;
					const isQueuedExpanded = expandedQueuedMessages.has(item.id);
					const isDragging = dragIndex === index;
					const isDropTarget = dropIndex === index;

					return (
						<div
							key={item.id}
							draggable={canDrag}
							onDragStart={() => handleDragStart(index)}
							onDragOver={(e) => handleDragOver(e, index)}
							onDragEnd={handleDragEnd}
							onDragLeave={handleDragLeave}
							className="mx-6 mb-2 p-3 rounded-lg relative group transition-all"
							style={{
								backgroundColor:
									item.type === 'command'
										? theme.colors.success + '20'
										: theme.colors.accent + '20',
								borderLeft: `3px solid ${item.type === 'command' ? theme.colors.success : theme.colors.accent}`,
								opacity: isDragging ? 0.4 : 0.6,
								transform: isDropTarget ? 'translateY(4px)' : 'none',
								boxShadow: isDropTarget ? `0 -2px 0 0 ${theme.colors.accent}` : 'none',
								cursor: canDrag ? 'grab' : 'default',
							}}
						>
							{/* Drag handle - only show when draggable */}
							{canDrag && (
								<div
									className="absolute left-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-50 transition-opacity"
									style={{ color: theme.colors.textDim }}
								>
									<GripVertical className="w-4 h-4" />
								</div>
							)}

							{/* Remove button */}
							<button
								onClick={() => setQueueRemoveConfirmId(item.id)}
								className="absolute top-2 right-2 p-1 rounded hover:bg-black/20 transition-colors"
								style={{ color: theme.colors.textDim }}
								title="Remove from queue"
							>
								<X className="w-4 h-4" />
							</button>

							{/* Item content */}
							<div
								className={`text-sm pr-8 whitespace-pre-wrap break-words ${canDrag ? 'pl-4' : ''}`}
								style={{ color: theme.colors.textMain }}
							>
								{item.type === 'command' && (
									<span style={{ color: theme.colors.success, fontWeight: 600 }}>
										{item.command}
									</span>
								)}
								{item.type === 'message' &&
									(isLongMessage && !isQueuedExpanded
										? displayText.substring(0, 200) + '...'
										: displayText)}
							</div>

							{/* Show more/less toggle for long messages */}
							{item.type === 'message' && isLongMessage && (
								<button
									onClick={() => toggleExpanded(item.id)}
									className="flex items-center gap-1 mt-2 text-xs px-2 py-1 rounded hover:opacity-70 transition-opacity"
									style={{
										color: theme.colors.accent,
										backgroundColor: theme.colors.bgActivity,
									}}
								>
									{isQueuedExpanded ? (
										<>
											<ChevronUp className="w-3 h-3" />
											Show less
										</>
									) : (
										<>
											<ChevronDown className="w-3 h-3" />
											Show all ({displayText.split('\n').length} lines)
										</>
									)}
								</button>
							)}

							{/* Images indicator */}
							{item.images && item.images.length > 0 && (
								<div className="mt-1 text-xs" style={{ color: theme.colors.textDim }}>
									{item.images.length} image{item.images.length > 1 ? 's' : ''} attached
								</div>
							)}
						</div>
					);
				})}

				{/* Queue removal confirmation modal */}
				{queueRemoveConfirmId && (
					<div
						className="fixed inset-0 flex items-center justify-center z-50"
						style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
						onClick={() => setQueueRemoveConfirmId(null)}
						onKeyDown={handleModalKeyDown}
					>
						<div
							className="p-4 rounded-lg shadow-xl max-w-md mx-4"
							style={{ backgroundColor: theme.colors.bgMain }}
							onClick={(e) => e.stopPropagation()}
							tabIndex={-1}
							ref={(el) => el?.focus()}
						>
							<h3 className="text-lg font-semibold mb-2" style={{ color: theme.colors.textMain }}>
								Remove Queued Message?
							</h3>
							<p className="text-sm mb-4" style={{ color: theme.colors.textDim }}>
								This message will be removed from the queue and will not be sent.
							</p>
							<div className="flex gap-2 justify-end">
								<button
									onClick={() => setQueueRemoveConfirmId(null)}
									className="px-3 py-1.5 rounded text-sm"
									style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textMain }}
								>
									Cancel
								</button>
								<button
									onClick={handleConfirmRemove}
									className="px-3 py-1.5 rounded text-sm"
									style={{ backgroundColor: theme.colors.error, color: 'white' }}
									autoFocus
								>
									Remove
								</button>
							</div>
						</div>
					</div>
				)}
			</>
		);
	}
);

QueuedItemsList.displayName = 'QueuedItemsList';
