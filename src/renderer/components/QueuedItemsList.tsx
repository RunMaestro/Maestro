import React, { useState, useCallback, useRef, memo } from 'react';
import { X, ChevronDown, ChevronUp, GripVertical, Copy, Check, Hammer } from 'lucide-react';
import type { Theme, QueuedItem } from '../types';
import { safeClipboardWrite } from '../utils/clipboard';
import { Modal, ModalFooter } from './ui/Modal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useEventListener } from '../hooks/utils/useEventListener';

// ============================================================================
// QueuedItemsList - Displays queued execution items with expand/collapse
// ============================================================================

export interface BusyTabSummary {
	id: string;
	displayName: string;
}

interface QueuedItemsListProps {
	executionQueue: QueuedItem[];
	theme: Theme;
	onRemoveQueuedItem?: (itemId: string) => void;
	onReorderItems?: (fromIndex: number, toIndex: number) => void;
	activeTabId?: string; // If provided, only show queued items for this tab
	// Force Send support: when forcedParallelExecution is enabled, allow the user
	// to bypass the cross-tab queue wait for an individual queued item.
	forcedParallelEnabled?: boolean;
	onForceSendQueuedItem?: (itemId: string) => void;
	// Lookup for tab state/name used by the Force Send button + confirm modal.
	// Returns the tab's current busy state, the other tabs currently busy in the
	// same agent, and the item's own target tab display name.
	getForceSendContext?: (item: QueuedItem) => {
		targetTabBusy: boolean;
		otherBusyTabs: BusyTabSummary[];
	} | null;
}

/**
 * QueuedItemsList displays the execution queue with:
 * - Queued message separator with count
 * - Individual queued items (commands/messages)
 * - Long message expand/collapse functionality
 * - Image attachment indicators
 * - Remove button with confirmation modal
 * - Drag-and-drop reordering
 * - Force Send button (when forcedParallelExecution is enabled)
 */
export const QueuedItemsList = memo(
	({
		executionQueue,
		theme,
		onRemoveQueuedItem,
		onReorderItems,
		activeTabId,
		forcedParallelEnabled = false,
		onForceSendQueuedItem,
		getForceSendContext,
	}: QueuedItemsListProps) => {
		// Filter to only show items for the active tab if activeTabId is provided
		const filteredQueue = activeTabId
			? executionQueue.filter((item) => item.tabId === activeTabId)
			: executionQueue;
		// Queue removal confirmation state
		const [queueRemoveConfirmId, setQueueRemoveConfirmId] = useState<string | null>(null);

		// Force Send confirmation state
		const [forceSendConfirmId, setForceSendConfirmId] = useState<string | null>(null);

		// Track which queued messages are expanded (for viewing full content)
		const [expandedQueuedMessages, setExpandedQueuedMessages] = useState<Set<string>>(new Set());

		// Drag state
		const [dragIndex, setDragIndex] = useState<number | null>(null);
		const [dropIndex, setDropIndex] = useState<number | null>(null);
		const dragItemRef = useRef<number | null>(null);

		// Refs for confirm-button focus management in confirmation modals
		const removeConfirmButtonRef = useRef<HTMLButtonElement>(null);
		const forceSendConfirmButtonRef = useRef<HTMLButtonElement>(null);

		// Can only drag if we have reorder handler and more than 1 item
		const canDrag = !!onReorderItems && filteredQueue.length > 1;

		// Copy feedback state
		const [copiedItemId, setCopiedItemId] = useState<string | null>(null);
		const copyResetTimerRef = useRef<NodeJS.Timeout | null>(null);

		const handleCopy = useCallback((item: QueuedItem) => {
			const text =
				item.type === 'command'
					? [item.command, item.commandArgs].filter(Boolean).join(' ')
					: (item.text ?? '');
			safeClipboardWrite(text).then((ok) => {
				if (ok) {
					setCopiedItemId(item.id);
					if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
					copyResetTimerRef.current = setTimeout(() => setCopiedItemId(null), 1500);
				}
			});
		}, []);

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

		// Handle confirm removal
		const handleConfirmRemove = useCallback(() => {
			if (onRemoveQueuedItem && queueRemoveConfirmId) {
				onRemoveQueuedItem(queueRemoveConfirmId);
			}
			setQueueRemoveConfirmId(null);
		}, [onRemoveQueuedItem, queueRemoveConfirmId]);

		const handleConfirmForceSend = useCallback(() => {
			if (onForceSendQueuedItem && forceSendConfirmId) {
				onForceSendQueuedItem(forceSendConfirmId);
			}
			setForceSendConfirmId(null);
		}, [onForceSendQueuedItem, forceSendConfirmId]);

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

		// Keyboard shortcut bridge: when the user hits the Forced Parallel shortcut
		// with an empty input, useInputKeyDown dispatches this event. We find the
		// most recent eligible queued item (matching the same visibility rules as
		// the per-item Force Send button) and open the confirmation modal — the
		// keyboard equivalent of clicking the button.
		useEventListener('maestro:triggerForceSendQueued', () => {
			if (
				!forcedParallelEnabled ||
				!onForceSendQueuedItem ||
				!getForceSendContext ||
				filteredQueue.length === 0
			) {
				return;
			}
			for (let i = filteredQueue.length - 1; i >= 0; i--) {
				const item = filteredQueue[i];
				if (item.forceParallel) continue;
				const ctx = getForceSendContext(item);
				if (!ctx || ctx.targetTabBusy || ctx.otherBusyTabs.length === 0) continue;
				setForceSendConfirmId(item.id);
				return;
			}
		});

		if (!filteredQueue || filteredQueue.length === 0) {
			return null;
		}

		// Snapshot of busy-tab context for the item awaiting Force Send confirmation.
		// Computed at render time so tab state stays live while the modal is open.
		const forceSendConfirmItem =
			forceSendConfirmId != null
				? filteredQueue.find((item) => item.id === forceSendConfirmId)
				: undefined;
		const forceSendConfirmContext =
			forceSendConfirmItem && getForceSendContext
				? getForceSendContext(forceSendConfirmItem)
				: null;

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

					// Force Send visibility: setting enabled, item not already forceParallel,
					// a handler is wired, the target tab is idle (force-parallel only helps
					// when *this* tab can dispatch), and at least one other tab is busy
					// (otherwise nothing to bypass).
					const forceSendContext =
						forcedParallelEnabled &&
						onForceSendQueuedItem &&
						getForceSendContext &&
						!item.forceParallel
							? getForceSendContext(item)
							: null;
					const showForceSendButton =
						!!forceSendContext &&
						!forceSendContext.targetTabBusy &&
						forceSendContext.otherBusyTabs.length > 0;

					return (
						<div
							key={item.id}
							draggable={canDrag}
							onDragStart={() => handleDragStart(index)}
							onDragOver={(e) => handleDragOver(e, index)}
							onDragEnd={handleDragEnd}
							onDragLeave={handleDragLeave}
							className="mx-6 mb-2 p-3 rounded-lg relative group transition-all flex flex-col"
							style={{
								// Reserve enough vertical room for the stacked top-right
								// Remove (X) and Copy buttons, plus the bottom-right Force
								// Send button when shown, without overlap.
								// X+Copy stack: 8 + 24 + 4 + 22 = 58px from top.
								// Force Send (pushed to bottom via mt-auto): ~28px button.
								minHeight: showForceSendButton ? '7rem' : '4.25rem',
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

							{/* Top-right: Remove button */}
							<button
								onClick={() => setQueueRemoveConfirmId(item.id)}
								className="absolute top-2 right-2 p-1 rounded hover:bg-black/20 transition-colors opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
								style={{ color: theme.colors.textDim }}
								title="Remove from queue"
							>
								<X className="w-4 h-4" />
							</button>

							{/* Copy button - directly under the Remove (X) button */}
							<button
								onClick={() => handleCopy(item)}
								className="absolute top-9 right-2 p-1 rounded hover:bg-black/20 transition-colors opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
								style={{
									color: copiedItemId === item.id ? theme.colors.success : theme.colors.textDim,
								}}
								title="Copy to clipboard"
							>
								{copiedItemId === item.id ? (
									<Check className="w-3.5 h-3.5" />
								) : (
									<Copy className="w-3.5 h-3.5" />
								)}
							</button>

							{/* Item content */}
							<div
								className={`text-sm pr-8 whitespace-pre-wrap break-words ${canDrag ? 'pl-4' : ''}`}
								style={{ color: theme.colors.textMain }}
							>
								{item.type === 'command' && (
									<span className="flex items-baseline gap-1 overflow-hidden">
										<span
											className="shrink-0"
											style={{ color: theme.colors.success, fontWeight: 600 }}
										>
											{item.command}
										</span>
										<span
											className="truncate min-w-0"
											style={{
												color: item.commandArgs ? theme.colors.textMain : theme.colors.textDim,
											}}
										>
											{item.commandArgs || item.commandDescription}
										</span>
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

							{/* Bottom-right: Force Send button (mt-auto pushes to bottom of flex column) */}
							{showForceSendButton && (
								<div className="mt-auto pt-2 flex justify-end">
									<button
										onClick={() => setForceSendConfirmId(item.id)}
										className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium hover:opacity-80 transition-opacity"
										style={{
											backgroundColor: theme.colors.warning + '33',
											color: theme.colors.warning,
										}}
										title="Force send this message now (skips cross-tab wait)"
									>
										<Hammer className="w-3.5 h-3.5" />
										Force Send
									</button>
								</div>
							)}
						</div>
					);
				})}

				{/* Queue removal confirmation modal */}
				{queueRemoveConfirmId && (
					<Modal
						theme={theme}
						title="Remove Queued Message?"
						priority={MODAL_PRIORITIES.CONFIRM}
						onClose={() => setQueueRemoveConfirmId(null)}
						width={448}
						initialFocusRef={removeConfirmButtonRef}
						footer={
							<ModalFooter
								theme={theme}
								onCancel={() => setQueueRemoveConfirmId(null)}
								onConfirm={handleConfirmRemove}
								confirmLabel="Remove"
								destructive
								confirmButtonRef={removeConfirmButtonRef}
							/>
						}
					>
						<p className="text-sm" style={{ color: theme.colors.textDim }}>
							This message will be removed from the queue and will not be sent.
						</p>
					</Modal>
				)}

				{/* Force Send confirmation modal */}
				{forceSendConfirmId && forceSendConfirmItem && (
					<Modal
						theme={theme}
						title="Force Send Message?"
						headerIcon={<Hammer className="w-5 h-5" style={{ color: theme.colors.warning }} />}
						priority={MODAL_PRIORITIES.CONFIRM}
						onClose={() => setForceSendConfirmId(null)}
						width={448}
						initialFocusRef={forceSendConfirmButtonRef}
						footer={
							<ModalFooter
								theme={theme}
								onCancel={() => setForceSendConfirmId(null)}
								onConfirm={handleConfirmForceSend}
								confirmLabel="Force Send"
								confirmButtonRef={forceSendConfirmButtonRef}
							/>
						}
					>
						<p className="text-sm mb-3" style={{ color: theme.colors.textDim }}>
							This will send the queued message immediately, running in parallel with the other tab
							{forceSendConfirmContext && forceSendConfirmContext.otherBusyTabs.length === 1
								? ''
								: 's'}{' '}
							currently working in this agent.
						</p>
						{forceSendConfirmContext && forceSendConfirmContext.otherBusyTabs.length > 0 && (
							<div className="p-3 rounded" style={{ backgroundColor: theme.colors.bgActivity }}>
								<div
									className="text-xs font-bold tracking-wider mb-2"
									style={{ color: theme.colors.warning }}
								>
									{forceSendConfirmContext.otherBusyTabs.length} OTHER TAB
									{forceSendConfirmContext.otherBusyTabs.length === 1 ? '' : 'S'} WORKING
								</div>
								<ul className="text-sm space-y-1" style={{ color: theme.colors.textMain }}>
									{forceSendConfirmContext.otherBusyTabs.map((tab) => (
										<li key={tab.id} className="flex items-center gap-2">
											<span
												className="inline-block w-2 h-2 rounded-full"
												style={{ backgroundColor: theme.colors.warning }}
											/>
											<span className="font-mono">{tab.displayName}</span>
										</li>
									))}
								</ul>
							</div>
						)}
					</Modal>
				)}
			</>
		);
	}
);

QueuedItemsList.displayName = 'QueuedItemsList';
