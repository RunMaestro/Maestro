import React, { useState, useCallback, useRef, memo } from 'react';
import {
	X,
	ChevronDown,
	ChevronUp,
	Copy,
	Check,
	Hammer,
	Pause,
	Play,
	Pencil,
	ImageIcon,
} from 'lucide-react';
import type { Theme, QueuedItem } from '../types';
import { safeClipboardWrite } from '../utils/clipboard';
import { Modal, ModalFooter } from './ui/Modal';
import { QueuedItemEditModal } from './QueuedItemEditModal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useEventListener } from '../hooks/utils/useEventListener';
import {
	useQueueReorder,
	useQueueRowDrag,
	QueueDropZone,
	QueueDragHandle,
	QueueDragShimmer,
	queueDragCardStyle,
} from './queue/queueDrag';

// Single group key: the inline list only ever renders one tab's queue at a time,
// so a constant identifies its lone drag group for the shared reorder hook.
const INLINE_QUEUE_KEY = 'inline-queue';

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
	onTogglePauseQueuedItem?: (itemId: string) => void;
	// Edit a queued message's prompt text and attached images. Only wired for
	// message items (commands have no image attachments).
	onEditQueuedItem?: (itemId: string, patch: { text: string; images: string[] }) => void;
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
	// Opens the shared full-screen image carousel for a queued item's attachments.
	// Reuses the same lightbox as history/staged images; pass 'history' source so
	// the images are read-only (navigable, no delete).
	onOpenLightbox?: (image: string, contextImages?: string[], source?: 'staged' | 'history') => void;
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
		onTogglePauseQueuedItem,
		onEditQueuedItem,
		onReorderItems,
		activeTabId,
		forcedParallelEnabled = false,
		onForceSendQueuedItem,
		getForceSendContext,
		onOpenLightbox,
	}: QueuedItemsListProps) => {
		// Filter to only show items for the active tab if activeTabId is provided
		const filteredQueue = activeTabId
			? executionQueue.filter((item) => item.tabId === activeTabId)
			: executionQueue;
		// Queue removal confirmation state
		const [queueRemoveConfirmId, setQueueRemoveConfirmId] = useState<string | null>(null);

		// Force Send confirmation state
		const [forceSendConfirmId, setForceSendConfirmId] = useState<string | null>(null);

		// Edit-message modal state (holds the id of the item being edited)
		const [editItemId, setEditItemId] = useState<string | null>(null);

		// Track which queued messages are expanded (for viewing full content)
		const [expandedQueuedMessages, setExpandedQueuedMessages] = useState<Set<string>>(new Set());

		// Drag-to-reorder orchestration, shared with the Execution Queue modal so the
		// handle, press-to-grab feel, and drop indicator look identical here.
		const { dragState, dropIndicator, isAnyDragging, startDrag, overDrag, endDrag, cancelDrag } =
			useQueueReorder((_key, fromIndex, toIndex) => onReorderItems?.(fromIndex, toIndex));

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

		// Keyboard shortcut bridge: when the user hits the Forced Parallel shortcut
		// with an empty input, useInputKeyDown dispatches this event. We find the
		// most recent eligible queued item (matching the same visibility rules as
		// the per-item Force Send button) and open the confirmation modal - the
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

				{/* Queued items (wrapped so drop-indicator lines align to the cards) */}
				<div className="mx-6">
					{filteredQueue.map((item, index) => {
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
							<React.Fragment key={item.id}>
								{/* Drop indicator before this item */}
								<QueueDropZone
									theme={theme}
									isActive={
										dropIndicator?.key === INLINE_QUEUE_KEY && dropIndicator?.index === index
									}
									onDragOver={() => overDrag(INLINE_QUEUE_KEY, index)}
								/>
								<QueuedItemRow
									item={item}
									index={index}
									theme={theme}
									canDrag={canDrag}
									isDragging={dragState?.key === INLINE_QUEUE_KEY && dragState?.fromIndex === index}
									isAnyDragging={isAnyDragging}
									onDragStart={() => startDrag(INLINE_QUEUE_KEY, index)}
									onDragEnd={endDrag}
									onDragCancel={cancelDrag}
									onDragOver={(gapIndex) => overDrag(INLINE_QUEUE_KEY, gapIndex)}
									isExpanded={expandedQueuedMessages.has(item.id)}
									onToggleExpand={() => toggleExpanded(item.id)}
									isCopied={copiedItemId === item.id}
									onCopy={() => handleCopy(item)}
									onEdit={
										onEditQueuedItem && item.type !== 'command'
											? () => setEditItemId(item.id)
											: undefined
									}
									showForceSendButton={showForceSendButton}
									onForceSend={() => setForceSendConfirmId(item.id)}
									onOpenLightbox={onOpenLightbox}
									onTogglePause={
										onTogglePauseQueuedItem ? () => onTogglePauseQueuedItem(item.id) : undefined
									}
									onRequestRemove={() => setQueueRemoveConfirmId(item.id)}
								/>
							</React.Fragment>
						);
					})}
					{/* Final drop zone after all items */}
					<QueueDropZone
						theme={theme}
						isActive={
							dropIndicator?.key === INLINE_QUEUE_KEY &&
							dropIndicator?.index === filteredQueue.length
						}
						onDragOver={() => overDrag(INLINE_QUEUE_KEY, filteredQueue.length)}
					/>
				</div>

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

				{/* Edit queued message modal */}
				{editItemId &&
					onEditQueuedItem &&
					(() => {
						const editItem = filteredQueue.find((item) => item.id === editItemId);
						if (!editItem) return null;
						return (
							<QueuedItemEditModal
								item={editItem}
								theme={theme}
								onClose={() => setEditItemId(null)}
								onSave={(patch) => onEditQueuedItem(editItem.id, patch)}
							/>
						);
					})()}
			</>
		);
	}
);

QueuedItemsList.displayName = 'QueuedItemsList';

// ============================================================================
// QueuedItemRow - a single draggable queued item in the inline chat list.
// Uses the shared queue-drag primitives so the handle, press-to-grab feel, and
// grabbed visual effect match the Execution Queue modal exactly.
// ============================================================================

interface QueuedItemRowProps {
	item: QueuedItem;
	index: number;
	theme: Theme;
	canDrag: boolean;
	isDragging: boolean;
	isAnyDragging: boolean;
	onDragStart: () => void;
	onDragEnd: () => void;
	onDragCancel: () => void;
	onDragOver: (gapIndex: number) => void;
	isExpanded: boolean;
	onToggleExpand: () => void;
	isCopied: boolean;
	onCopy: () => void;
	onEdit?: () => void;
	showForceSendButton: boolean;
	onForceSend: () => void;
	onTogglePause?: () => void;
	onRequestRemove: () => void;
	onOpenLightbox?: (image: string, contextImages?: string[], source?: 'staged' | 'history') => void;
}

function QueuedItemRow({
	item,
	index,
	theme,
	canDrag,
	isDragging,
	isAnyDragging,
	onDragStart,
	onDragEnd,
	onDragCancel,
	onDragOver,
	isExpanded,
	onToggleExpand,
	isCopied,
	onCopy,
	onEdit,
	showForceSendButton,
	onForceSend,
	onTogglePause,
	onRequestRemove,
	onOpenLightbox,
}: QueuedItemRowProps) {
	// Whether the inline thumbnail strip for attached images is expanded. Queued
	// cards are compact, so images stay collapsed behind a click-to-expand toggle.
	const [imagesExpanded, setImagesExpanded] = useState(false);
	const { rowRef, visual, wrapperHandlers, cardHandlers } = useQueueRowDrag({
		index,
		canDrag,
		isDragging,
		isAnyDragging,
		onDragStart,
		onDragEnd,
		onDragCancel,
		onDragOver,
	});
	const { showDragReady, showGrabbed, isDimmed } = visual;

	const isCommand = item.type === 'command';
	const isPaused = !!item.paused;
	const displayText = isCommand ? (item.command ?? '') : (item.text ?? '');
	const isLongMessage = displayText.length > 200;
	const accent = isCommand ? theme.colors.success : theme.colors.accent;

	return (
		<div
			ref={rowRef}
			className="relative mb-2"
			style={{ zIndex: isDragging ? 50 : 1 }}
			{...wrapperHandlers}
		>
			<div
				className="p-3 rounded-lg relative group flex flex-col select-none"
				style={{
					backgroundColor: accent + '20',
					borderLeft: `3px solid ${accent}`,
					cursor: canDrag ? (isDragging ? 'grabbing' : 'grab') : 'default',
					...queueDragCardStyle(theme, { isDragging, showGrabbed }),
					// Queued items render dimmed (they're pending); lift the grabbed one and
					// recede the rest while a drag is in progress.
					opacity: isDragging ? 0.95 : isPaused ? 0.35 : isDimmed ? 0.3 : 0.6,
				}}
				{...cardHandlers}
			>
				{/* Drag handle - only show when draggable */}
				{canDrag && <QueueDragHandle theme={theme} visible={showDragReady || showGrabbed} />}

				{/* HELD badge for paused items */}
				{isPaused && (
					<div className={canDrag ? 'pl-4 mb-1.5' : 'mb-1.5'}>
						<span
							className="px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider"
							style={{
								backgroundColor: theme.colors.warning + '33',
								color: theme.colors.warning,
							}}
						>
							HELD
						</span>
					</div>
				)}

				{/* Item content */}
				<div
					className={`text-sm whitespace-pre-wrap break-words ${canDrag ? 'pl-4' : ''}`}
					style={{ color: theme.colors.textMain }}
				>
					{isCommand && (
						<span className="flex items-baseline gap-1 overflow-hidden">
							<span className="shrink-0" style={{ color: theme.colors.success, fontWeight: 600 }}>
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
					{!isCommand &&
						(isLongMessage && !isExpanded ? displayText.substring(0, 200) + '...' : displayText)}
				</div>

				{/* Show more/less toggle for long messages */}
				{!isCommand && isLongMessage && (
					<button
						onClick={onToggleExpand}
						className="flex items-center gap-1 mt-2 text-xs px-2 py-1 rounded hover:opacity-70 transition-opacity"
						style={{
							color: theme.colors.accent,
							backgroundColor: theme.colors.bgActivity,
						}}
					>
						{isExpanded ? (
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

				{/* Images: click-to-expand indicator + inline thumbnail strip.
				    Each thumbnail opens the shared full-screen carousel. */}
				{item.images && item.images.length > 0 && (
					<div className={canDrag ? 'pl-4 mt-1.5' : 'mt-1.5'}>
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								setImagesExpanded((v) => !v);
							}}
							className="flex items-center gap-1 text-xs hover:opacity-80 transition-opacity"
							style={{ color: theme.colors.textDim }}
							title={imagesExpanded ? 'Hide thumbnails' : 'Show thumbnails'}
						>
							<ImageIcon className="w-3.5 h-3.5" />
							<span>
								{item.images.length} image{item.images.length > 1 ? 's' : ''} attached
							</span>
							{imagesExpanded ? (
								<ChevronUp className="w-3 h-3" />
							) : (
								<ChevronDown className="w-3 h-3" />
							)}
						</button>
						{imagesExpanded && (
							<div
								className="flex gap-2 mt-2 overflow-x-auto scrollbar-thin"
								style={{ overscrollBehavior: 'contain' }}
							>
								{item.images.map((img, imgIdx) => (
									<button
										key={`${item.id}-img-${imgIdx}`}
										type="button"
										className="shrink-0 p-0 bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
										onClick={(e) => {
											e.stopPropagation();
											onOpenLightbox?.(img, item.images, 'history');
										}}
										title="Click to view full size"
									>
										<img
											src={img}
											alt={`Queued attachment ${imgIdx + 1}`}
											className="h-16 rounded border block"
											style={{
												borderColor: theme.colors.border,
												objectFit: 'contain',
												maxWidth: '200px',
												cursor: onOpenLightbox ? 'zoom-in' : 'default',
											}}
										/>
									</button>
								))}
							</div>
						)}
					</div>
				)}

				{/* Bottom footer: Force Send anchored bottom-left, control
				    buttons anchored bottom-right (always visible). mt-auto
				    pushes the row to the bottom of the flex column. */}
				<div className={`mt-auto pt-2 flex items-center gap-2 ${canDrag ? 'pl-4' : ''}`}>
					{showForceSendButton && (
						<button
							onClick={onForceSend}
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
					)}

					<div className="ml-auto flex items-center gap-1">
						{/* Edit button */}
						{onEdit && (
							<button
								onClick={onEdit}
								className="p-1 rounded hover:bg-black/20 transition-colors"
								style={{ color: theme.colors.textDim }}
								title="Edit message and images"
							>
								<Pencil className="w-3.5 h-3.5" />
							</button>
						)}

						{/* Copy button */}
						<button
							onClick={onCopy}
							className="p-1 rounded hover:bg-black/20 transition-colors"
							style={{ color: isCopied ? theme.colors.success : theme.colors.textDim }}
							title="Copy to clipboard"
						>
							{isCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
						</button>

						{/* Hold/Resume button */}
						{onTogglePause && (
							<button
								onClick={onTogglePause}
								className="p-1 rounded hover:bg-black/20 transition-colors"
								style={{ color: isPaused ? theme.colors.warning : theme.colors.textDim }}
								title={
									isPaused
										? 'Resume this message (let it run when its turn comes)'
										: 'Hold this message (skip it until you resume)'
								}
							>
								{isPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
							</button>
						)}

						{/* Remove button */}
						<button
							onClick={onRequestRemove}
							className="p-1 rounded hover:bg-black/20 transition-colors"
							style={{ color: theme.colors.textDim }}
							title="Remove from queue"
						>
							<X className="w-4 h-4" />
						</button>
					</div>
				</div>

				{/* Shimmer effect when grabbed */}
				<QueueDragShimmer theme={theme} visible={showGrabbed} />
			</div>
		</div>
	);
}
