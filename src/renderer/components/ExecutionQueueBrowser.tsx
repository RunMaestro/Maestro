import React, { useState, useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
	X,
	MessageSquare,
	Command,
	Trash2,
	Clock,
	Folder,
	FolderOpen,
	Copy,
	Check,
	Pause,
	Play,
	Pencil,
	Hammer,
} from 'lucide-react';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { useResizableModal } from '../hooks/ui/useResizableModal';
import { useEventListener } from '../hooks/utils/useEventListener';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import type { Session, Theme, QueuedItem } from '../types';
import { safeClipboardWrite } from '../utils/clipboard';
import { flashCopiedToClipboard } from '../utils/flashCopiedToClipboard';
import { useSettingsStore } from '../stores/settingsStore';
import {
	getForceSendEligibility,
	shouldOfferForceSend,
	resolveQueuedItemTabName,
	type ForceSendEligibility,
} from '../utils/executionQueue';
import { Modal, ModalFooter } from './ui/Modal';
import { QueuedItemEditModal } from './QueuedItemEditModal';
import { TurnSettingPills } from './ui/TurnSettingPills';
import {
	useQueueReorder,
	useQueueRowDrag,
	QueueDropZone,
	QueueDragHandle,
	QueueDragShimmer,
	queueDragCardStyle,
} from './queue/queueDrag';
import { ResizeHandles } from './ui/ResizeHandles';

interface ExecutionQueueBrowserProps {
	isOpen: boolean;
	onClose: () => void;
	sessions: Session[];
	activeSessionId: string | null;
	theme: Theme;
	onRemoveItem: (sessionId: string, itemId: string) => void;
	onSwitchSession: (sessionId: string, tabId?: string) => void;
	onReorderItems?: (sessionId: string, fromIndex: number, toIndex: number) => void;
	onToggleItemPause?: (sessionId: string, itemId: string) => void;
	onEditItem?: (
		sessionId: string,
		itemId: string,
		patch: { text: string; images: string[] }
	) => void;
	/** Dispatch a queued item immediately, out of queue order */
	onForceSendItem?: (sessionId: string, itemId: string) => void;
}

/**
 * Modal for browsing and managing the execution queue across all sessions.
 * Supports filtering by current project vs global view.
 */
export function ExecutionQueueBrowser({
	isOpen,
	onClose,
	sessions,
	activeSessionId,
	theme,
	onRemoveItem,
	onSwitchSession,
	onReorderItems,
	onToggleItemPause,
	onEditItem,
	onForceSendItem,
}: ExecutionQueueBrowserProps) {
	const [viewMode, setViewMode] = useState<'current' | 'global'>('current');
	// Force Send awaiting confirmation. Only the parallel case confirms - sending
	// alongside another tab's turn is what can put two agents on the same files.
	const [forceSendConfirm, setForceSendConfirm] = useState<{
		sessionId: string;
		item: QueuedItem;
	} | null>(null);
	const forceSendConfirmButtonRef = useRef<HTMLButtonElement>(null);
	const forcedParallelEnabled = useSettingsStore((s) => s.forcedParallelExecution);
	// The queued item currently being edited (with its owning session), or null.
	// While set, this browser suspends its own Escape layer so the edit modal's
	// layer stack (edit < lightbox < annotator) resolves Escape correctly - the
	// browser sits at a much higher priority (670) than the edit modal (145).
	const [editing, setEditing] = useState<{ sessionId: string; item: QueuedItem } | null>(null);
	// Keyboard cursor over the flattened list of visible rows. Up/Down walk it,
	// Enter opens the action menu for whatever it is sitting on.
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [actionMenuOpen, setActionMenuOpen] = useState(false);
	// Drag-to-reorder orchestration shared with the inline queued-items list.
	// The group key is the sessionId so each session's queue reorders independently.
	const { dragState, dropIndicator, isAnyDragging, startDrag, overDrag, endDrag, cancelDrag } =
		useQueueReorder(onReorderItems);
	const onCloseRef = useRef(onClose);
	const modalRef = useRef<HTMLDivElement>(null);
	onCloseRef.current = onClose;

	useModalLayer(
		MODAL_PRIORITIES.EXECUTION_QUEUE_BROWSER || 50,
		undefined,
		() => onCloseRef.current(),
		{ enabled: isOpen && !editing }
	);

	const resizableModal = useResizableModal({
		resizeKey: 'execution-queue',
		defaultSize: { width: 672, height: 640 },
		minSize: { width: 520, height: 360 },
		enabled: isOpen,
		externalRef: modalRef,
	});

	// Sessions with queued items, and the subset this view mode draws.
	const sessionsWithQueues = useMemo(
		() => sessions.filter((s) => s.executionQueue && s.executionQueue.length > 0),
		[sessions]
	);
	const filteredSessions = useMemo(
		() =>
			viewMode === 'current'
				? sessionsWithQueues.filter((s) => s.id === activeSessionId)
				: sessionsWithQueues,
		[sessionsWithQueues, viewMode, activeSessionId]
	);
	// Every visible row, flattened in RENDER order - arrow-key navigation walks
	// this, so it has to be built from the same list the body maps over or the
	// cursor moves somewhere the user is not looking.
	const flatItems = useMemo(
		() =>
			filteredSessions.flatMap((session) =>
				(session.executionQueue ?? []).map((item) => ({ session, item }))
			),
		[filteredSessions]
	);
	const flatIndexById = useMemo(() => {
		const map = new Map<string, number>();
		flatItems.forEach((entry, i) => map.set(entry.item.id, i));
		return map;
	}, [flatItems]);

	// Get total queue count for display
	const totalQueuedItems = useMemo(
		() => sessionsWithQueues.reduce((sum, s) => sum + (s.executionQueue?.length || 0), 0),
		[sessionsWithQueues]
	);

	const currentSessionItems = activeSessionId
		? sessions.find((s) => s.id === activeSessionId)?.executionQueue?.length || 0
		: 0;

	// Clamp at read time rather than in an effect: an item removed from the
	// queue must not leave the cursor pointing past the end for a render.
	const activeIndex = flatItems.length === 0 ? -1 : Math.min(selectedIndex, flatItems.length - 1);
	const selectedEntry = activeIndex >= 0 ? flatItems[activeIndex] : undefined;
	// The listener is registered once, so it reads the live cursor from a ref
	// instead of closing over a stale one.
	const navRef = useRef<{ count: number; index: number }>({ count: 0, index: -1 });
	navRef.current = { count: flatItems.length, index: activeIndex };

	// Reopening the browser, or switching between Current Agent / All Agents,
	// puts the cursor back on the first row of what is now on screen.
	useEffect(() => {
		setSelectedIndex(0);
		if (!isOpen) setActionMenuOpen(false);
	}, [isOpen, viewMode]);

	// One keydown listener for the whole browser - view cycling and row
	// navigation - so opening it never grows the window's listener set per row.
	useEventListener(
		'keydown',
		(e) => {
			const ke = e as KeyboardEvent;
			// Cmd/Ctrl+Shift+[ / ] cycles between the Current Agent / All Agents
			// tabs (matches the app-wide prev/next-tab shortcut). Use e.code so it
			// works regardless of the brace characters Shift produces on macOS.
			if ((ke.metaKey || ke.ctrlKey) && ke.shiftKey) {
				if (ke.code !== 'BracketLeft' && ke.code !== 'BracketRight') return;
				ke.preventDefault();
				setViewMode((prev) => (prev === 'current' ? 'global' : 'current'));
				return;
			}
			if (ke.metaKey || ke.ctrlKey || ke.altKey) return;
			const { count, index } = navRef.current;
			if (ke.key === 'ArrowDown' || ke.key === 'ArrowUp') {
				if (count === 0) return;
				ke.preventDefault();
				setSelectedIndex(
					index < 0
						? 0
						: ke.key === 'ArrowDown'
							? Math.min(index + 1, count - 1)
							: Math.max(index - 1, 0)
				);
				return;
			}
			if (ke.key === 'Enter') {
				if (index < 0) return;
				ke.preventDefault();
				setActionMenuOpen(true);
			}
		},
		{ enabled: isOpen && !editing && !actionMenuOpen && !forceSendConfirm }
	);

	if (!isOpen) return null;

	// Send now. A plain queue jump goes straight through; running alongside
	// another tab's in-flight turn asks first, since that is the case that can
	// put two agents on the same files.
	const requestForceSend = (
		session: Session,
		item: QueuedItem,
		eligibility: ForceSendEligibility
	) => {
		if (!onForceSendItem) return;
		if (eligibility.requiresParallel) {
			setForceSendConfirm({ sessionId: session.id, item });
			return;
		}
		onForceSendItem(session.id, item.id);
	};

	// Recomputed at render so the confirm dialog's busy-tab list stays live while open.
	const confirmSession = forceSendConfirm
		? sessions.find((s) => s.id === forceSendConfirm.sessionId)
		: undefined;
	const confirmEligibility =
		confirmSession && forceSendConfirm
			? getForceSendEligibility(confirmSession, forceSendConfirm.item, { forcedParallelEnabled })
			: null;

	// Actions for the Enter menu, built from the same availability rules the
	// row's own buttons use so the menu can never offer something the card
	// does not.
	const menuActions: QueueItemAction[] = [];
	if (actionMenuOpen && selectedEntry) {
		const { session, item } = selectedEntry;
		const eligibility = onForceSendItem
			? getForceSendEligibility(session, item, { forcedParallelEnabled })
			: null;
		if (onForceSendItem && eligibility?.canForce) {
			menuActions.push({
				id: 'send',
				label: 'Send Now',
				icon: <Hammer className="w-4 h-4" />,
				color: theme.colors.warning,
				run: () => requestForceSend(session, item, eligibility),
			});
		}
		if (onEditItem && item.type !== 'command') {
			menuActions.push({
				id: 'edit',
				label: 'Edit',
				icon: <Pencil className="w-4 h-4" />,
				run: () => setEditing({ sessionId: session.id, item }),
			});
		}
		menuActions.push({
			id: 'delete',
			label: 'Delete',
			icon: <Trash2 className="w-4 h-4" />,
			color: theme.colors.error,
			run: () => onRemoveItem(session.id, item.id),
		});
		if (onToggleItemPause) {
			menuActions.push({
				id: 'pause',
				label: item.paused ? 'Resume' : 'Hold',
				icon: item.paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />,
				run: () => onToggleItemPause(session.id, item.id),
			});
		}
		menuActions.push({
			id: 'copy',
			label: 'Copy',
			icon: <Copy className="w-4 h-4" />,
			run: () => {
				const text =
					item.type === 'command'
						? [item.command, item.commandArgs].filter(Boolean).join(' ')
						: (item.text ?? '');
				safeClipboardWrite(text).then((ok) => {
					if (ok) flashCopiedToClipboard();
				});
			},
		});
	}

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
			{/* Backdrop */}
			<div className="absolute inset-0 bg-black/60" style={{ backdropFilter: 'blur(2px)' }} />

			{/* Modal */}
			<div
				ref={modalRef}
				className="relative rounded-lg border shadow-2xl flex flex-col select-none"
				style={{
					...resizableModal.style,
					backgroundColor: theme.colors.bgMain,
					borderColor: theme.colors.border,
				}}
				data-modal-resize-key="execution-queue"
				onClick={(e) => e.stopPropagation()}
				role="dialog"
				aria-modal="true"
				aria-label="Execution Queue"
			>
				<ResizeHandles
					onResizeStart={resizableModal.onResizeStart}
					accentColor={theme.colors.accent}
					onResetSize={resizableModal.onResetSize}
					canReset={resizableModal.canReset}
				/>

				{/* Header */}
				<div
					className="flex items-center justify-between px-4 py-3 border-b"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-3">
						<h2 className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
							Execution Queue
						</h2>
						<span
							className="text-xs px-2 py-0.5 rounded"
							style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
						>
							{totalQueuedItems} total
						</span>
					</div>
					<button
						onClick={onClose}
						className="p-1.5 rounded-md hover:opacity-80 transition-opacity"
						style={{ color: theme.colors.textDim }}
					>
						<X className="w-5 h-5" />
					</button>
				</div>

				{/* View Toggle */}
				<div
					className="px-4 py-2 border-b flex items-center gap-2"
					style={{ borderColor: theme.colors.border }}
				>
					<button
						onClick={() => setViewMode('current')}
						className={`px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-1.5 transition-colors ${
							viewMode === 'current' ? '' : 'opacity-60 hover:opacity-80'
						}`}
						style={{
							backgroundColor: viewMode === 'current' ? theme.colors.accent : 'transparent',
							color: viewMode === 'current' ? theme.colors.bgMain : theme.colors.textMain,
						}}
					>
						<Folder className="w-3.5 h-3.5" />
						Current Agent
						{currentSessionItems > 0 && (
							<span className="ml-1 text-xs opacity-80">({currentSessionItems})</span>
						)}
					</button>
					<button
						onClick={() => setViewMode('global')}
						className={`px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-1.5 transition-colors ${
							viewMode === 'global' ? '' : 'opacity-60 hover:opacity-80'
						}`}
						style={{
							backgroundColor: viewMode === 'global' ? theme.colors.accent : 'transparent',
							color: viewMode === 'global' ? theme.colors.bgMain : theme.colors.textMain,
						}}
					>
						<FolderOpen className="w-3.5 h-3.5" />
						All Agents
						<span className="ml-1 text-xs opacity-80">({totalQueuedItems})</span>
					</button>
				</div>

				{/* Queue List */}
				<div className="flex-1 overflow-y-auto p-4 space-y-4">
					{filteredSessions.length === 0 ? (
						<div className="text-center py-12 text-sm" style={{ color: theme.colors.textDim }}>
							No items queued{viewMode === 'current' ? ' for this agent' : ''}
						</div>
					) : (
						filteredSessions.map((session) => (
							<div key={session.id} className="space-y-2">
								{/* Session Header - only show in global view */}
								{viewMode === 'global' && (
									<button
										onClick={() => {
											onSwitchSession(session.id);
											onClose();
										}}
										className="text-sm font-medium flex items-center gap-2 hover:underline"
										style={{ color: theme.colors.accent }}
									>
										<Folder className="w-3.5 h-3.5" />
										{session.name}
										<span
											className="text-xs px-1.5 py-0.5 rounded"
											style={{
												backgroundColor: theme.colors.bgActivity,
												color: theme.colors.textDim,
											}}
										>
											{session.executionQueue?.length || 0}
										</span>
									</button>
								)}

								{/* Queue Items */}
								<div className="space-y-0">
									{session.executionQueue?.map((item, index) => {
										const forceSend = onForceSendItem
											? getForceSendEligibility(session, item, { forcedParallelEnabled })
											: null;
										const flatIndex = flatIndexById.get(item.id) ?? -1;
										return (
											<React.Fragment key={item.id}>
												{/* Drop indicator before this item */}
												<QueueDropZone
													theme={theme}
													isActive={
														dropIndicator?.key === session.id && dropIndicator?.index === index
													}
													onDragOver={() => overDrag(session.id, index)}
												/>
												<QueueItemRow
													item={item}
													index={index}
													theme={theme}
													isSelected={flatIndex >= 0 && flatIndex === activeIndex}
													onSelect={() => setSelectedIndex(flatIndex)}
													tabLabel={resolveQueuedItemTabName(session, item)}
													forceSend={forceSend}
													onForceSend={
														forceSend?.canForce
															? () => requestForceSend(session, item, forceSend)
															: undefined
													}
													onRemove={() => onRemoveItem(session.id, item.id)}
													isPaused={!!item.paused}
													onTogglePause={
														onToggleItemPause
															? () => onToggleItemPause(session.id, item.id)
															: undefined
													}
													onEdit={
														onEditItem && item.type !== 'command'
															? () => setEditing({ sessionId: session.id, item })
															: undefined
													}
													onSwitchToSession={() => {
														onSwitchSession(session.id, item.tabId);
														onClose();
													}}
													isDragging={
														dragState?.key === session.id && dragState?.fromIndex === index
													}
													canDrag={!!onReorderItems && (session.executionQueue?.length || 0) > 1}
													isAnyDragging={isAnyDragging}
													onDragStart={() => startDrag(session.id, index)}
													onDragEnd={endDrag}
													onDragCancel={cancelDrag}
													onDragOverItem={(gapIndex) => overDrag(session.id, gapIndex)}
												/>
											</React.Fragment>
										);
									})}
									{/* Final drop zone after all items */}
									<QueueDropZone
										theme={theme}
										isActive={
											dropIndicator?.key === session.id &&
											dropIndicator?.index === (session.executionQueue?.length || 0)
										}
										onDragOver={() => overDrag(session.id, session.executionQueue?.length || 0)}
									/>
								</div>
							</div>
						))
					)}
				</div>

				{/* Footer */}
				<div
					className="px-4 py-3 border-t text-xs"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				>
					Up/Down selects a message, Enter opens its actions. Drag and drop to reorder, or Send Now
					to run one out of turn. Items are otherwise processed sequentially per agent to prevent
					file conflicts.
				</div>
			</div>

			{/* Force Send confirmation - only reached when the item would run
			    alongside another tab's in-flight turn. Sits at CONFIRM priority
			    (above this browser), so Escape resolves to it without the layer
			    suspension the lower-priority edit modal needs. */}
			{forceSendConfirm && confirmEligibility && onForceSendItem && (
				<div onClick={(e) => e.stopPropagation()}>
					<Modal
						theme={theme}
						title="Force Send Message?"
						headerIcon={<Hammer className="w-5 h-5" style={{ color: theme.colors.warning }} />}
						priority={MODAL_PRIORITIES.CONFIRM}
						onClose={() => setForceSendConfirm(null)}
						width={448}
						initialFocusRef={forceSendConfirmButtonRef}
						footer={
							<ModalFooter
								theme={theme}
								onCancel={() => setForceSendConfirm(null)}
								onConfirm={() => {
									onForceSendItem(forceSendConfirm.sessionId, forceSendConfirm.item.id);
									setForceSendConfirm(null);
								}}
								confirmLabel="Force Send"
								confirmButtonRef={forceSendConfirmButtonRef}
							/>
						}
					>
						<p className="text-sm mb-3" style={{ color: theme.colors.textDim }}>
							This will send the queued message immediately, running in parallel with the other tab
							{confirmEligibility.otherBusyTabs.length === 1 ? '' : 's'} currently working in this
							agent.
						</p>
						{confirmEligibility.otherBusyTabs.length > 0 && (
							<div className="p-3 rounded" style={{ backgroundColor: theme.colors.bgActivity }}>
								<div
									className="text-xs font-bold tracking-wider mb-2"
									style={{ color: theme.colors.warning }}
								>
									{confirmEligibility.otherBusyTabs.length} OTHER TAB
									{confirmEligibility.otherBusyTabs.length === 1 ? '' : 'S'} WORKING
								</div>
								<ul className="text-sm space-y-1" style={{ color: theme.colors.textMain }}>
									{confirmEligibility.otherBusyTabs.map((tab) => (
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
				</div>
			)}

			{/* Action menu for the keyboard cursor. Sits at CONFIRM priority, above
			    this browser, so Escape resolves to it without suspending the
			    browser's own layer. */}
			{actionMenuOpen && selectedEntry && (
				<div onClick={(e) => e.stopPropagation()}>
					<QueueItemActionMenu
						theme={theme}
						position={activeIndex + 1}
						actions={menuActions}
						onClose={() => setActionMenuOpen(false)}
					/>
				</div>
			)}

			{/* Edit modal - rendered outside the card so a click inside it doesn't
			    bubble to the backdrop's onClick (which would close the browser).
			    Stops propagation so backdrop clicks behind it are also contained. */}
			{editing && onEditItem && (
				<div onClick={(e) => e.stopPropagation()}>
					<QueuedItemEditModal
						item={editing.item}
						theme={theme}
						onClose={() => setEditing(null)}
						onSave={(patch) => onEditItem(editing.sessionId, editing.item.id, patch)}
					/>
				</div>
			)}
		</div>
	);
}

interface QueueItemRowProps {
	item: QueuedItem;
	index: number;
	theme: Theme;
	/** Row the keyboard cursor is on - Enter opens its action menu */
	isSelected?: boolean;
	/** Clicking the card moves the cursor here */
	onSelect?: () => void;
	/** Live tab name, resolved now rather than read off the item's stale snapshot */
	tabLabel?: string;
	/** Null when the browser has no Force Send handler wired */
	forceSend?: ForceSendEligibility | null;
	/** Set only when the item can actually be sent right now */
	onForceSend?: () => void;
	onRemove: () => void;
	isPaused?: boolean;
	onTogglePause?: () => void;
	onEdit?: () => void;
	onSwitchToSession: () => void;
	isDragging?: boolean;
	canDrag?: boolean;
	isAnyDragging?: boolean;
	onDragStart?: () => void;
	onDragEnd?: () => void;
	onDragCancel?: () => void;
	onDragOverItem?: (dropIndex: number) => void;
}

function QueueItemRow({
	item,
	index,
	theme,
	isSelected = false,
	onSelect,
	tabLabel,
	forceSend,
	onForceSend,
	onRemove,
	isPaused,
	onTogglePause,
	onEdit,
	onSwitchToSession,
	isDragging = false,
	canDrag = false,
	isAnyDragging = false,
	onDragStart,
	onDragEnd,
	onDragCancel,
	onDragOverItem,
}: QueueItemRowProps) {
	const [copied, setCopied] = useState(false);
	const copyResetTimerRef = useRef<NodeJS.Timeout | null>(null);

	// Shared drag mechanics + visual flags (handle, press-to-grab, drop detection).
	const { rowRef, visual, wrapperHandlers, cardHandlers } = useQueueRowDrag({
		index,
		canDrag,
		isDragging,
		isAnyDragging,
		onDragStart: () => onDragStart?.(),
		onDragEnd: () => onDragEnd?.(),
		onDragCancel: () => onDragCancel?.(),
		onDragOver: (gapIndex) => onDragOverItem?.(gapIndex),
	});
	const { showDragReady, showGrabbed, isDimmed } = visual;

	const isCommand = item.type === 'command';
	// Read up to the first 4k characters and let CSS line-clamp cap the card at
	// three lines. The native ellipsis fills the space without wrapping past the
	// card, so longer messages show as much as fits rather than a hard 100-char cut.
	const displayText = isCommand ? item.command : item.text?.slice(0, 4000);

	const timeSinceQueued = Date.now() - item.timestamp;
	const minutes = Math.floor(timeSinceQueued / 60000);
	const timeDisplay = minutes < 1 ? 'Just now' : `${minutes}m ago`;

	// Send Now stays visible (dimmed) only when the block is something the user
	// can go fix - see shouldOfferForceSend. A target tab that is already
	// mid-turn hides it, because the item is simply next in line.
	const canForceSend = !!forceSend?.canForce && !!onForceSend;
	const showForceSend = shouldOfferForceSend(forceSend);
	const otherBusyCount = forceSend?.otherBusyTabs.length ?? 0;
	const forceSendTitle =
		forceSend?.blockedReason === 'target-tab-busy'
			? 'This tab is already working - the message runs when the current turn finishes'
			: forceSend?.blockedReason === 'needs-forced-parallel'
				? `Another tab in this agent is working. Turn on Forced Parallel Execution in Settings to send anyway.`
				: forceSend?.requiresParallel
					? `Send now, running in parallel with ${otherBusyCount} other working tab${otherBusyCount === 1 ? '' : 's'}`
					: 'Send this message now, ahead of the rest of the queue';

	// Cleanup copy-feedback timer on unmount
	useEffect(() => {
		return () => {
			if (copyResetTimerRef.current) {
				clearTimeout(copyResetTimerRef.current);
			}
		};
	}, []);

	// Keep the keyboard cursor on screen as it walks past the visible window.
	useEffect(() => {
		if (isSelected) rowRef.current?.scrollIntoView({ block: 'nearest' });
	}, [isSelected, rowRef]);

	return (
		<div
			ref={rowRef}
			className="relative my-1"
			style={{
				zIndex: isDragging ? 50 : 1,
			}}
			{...wrapperHandlers}
		>
			<div
				className="flex items-start gap-3 px-3 py-2.5 rounded-lg border group select-none"
				data-selected={isSelected ? 'true' : undefined}
				onClick={() => onSelect?.()}
				style={{
					backgroundColor: isDragging ? theme.colors.bgMain : theme.colors.bgSidebar,
					borderColor: isDragging
						? theme.colors.accent
						: showGrabbed
							? theme.colors.accent + '80'
							: isSelected
								? theme.colors.accent
								: theme.colors.border,
					boxShadow: isSelected && !isDragging ? `0 0 0 1px ${theme.colors.accent}` : undefined,
					cursor: canDrag ? (isDragging ? 'grabbing' : 'grab') : 'default',
					...queueDragCardStyle(theme, { isDragging, showGrabbed }),
					opacity: isDragging ? 0.95 : isPaused ? 0.45 : isDimmed ? 0.5 : 1,
				}}
				{...cardHandlers}
			>
				{/* Drag handle indicator */}
				{canDrag && <QueueDragHandle theme={theme} visible={showDragReady || showGrabbed} />}

				{/* Position indicator */}
				<span
					className="text-xs font-mono mt-0.5 w-5 text-center transition-all duration-200"
					style={{
						color: theme.colors.textDim,
						transform: showGrabbed ? 'scale(1.1)' : 'scale(1)',
						fontWeight: showGrabbed ? 600 : 400,
					}}
				>
					#{index + 1}
				</span>

				{/* Type icon */}
				<div
					className="mt-0.5 transition-transform duration-200"
					style={{
						transform: showGrabbed ? 'scale(1.1)' : 'scale(1)',
					}}
				>
					{isCommand ? (
						<Command className="w-4 h-4" style={{ color: theme.colors.warning }} />
					) : (
						<MessageSquare className="w-4 h-4" style={{ color: theme.colors.accent }} />
					)}
				</div>

				{/* Content */}
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2">
						{tabLabel && (
							<button
								onClick={(e) => {
									e.stopPropagation();
									onSwitchToSession();
								}}
								className="text-xs px-1.5 py-0.5 rounded font-mono hover:opacity-80 transition-opacity cursor-pointer"
								style={{
									backgroundColor: theme.colors.accent + '25',
									color: theme.colors.textMain,
								}}
								title="Jump to this session"
							>
								{tabLabel}
							</button>
						)}
						<span
							className="text-xs flex items-center gap-1"
							style={{ color: theme.colors.textDim }}
						>
							<Clock className="w-3 h-3" />
							{timeDisplay}
						</span>
						{isPaused && (
							<span
								className="text-[10px] font-bold tracking-wider px-1.5 py-0.5 rounded"
								style={{
									backgroundColor: theme.colors.warning + '33',
									color: theme.colors.warning,
								}}
							>
								HELD
							</span>
						)}
					</div>
					<div
						className={`mt-1 text-sm line-clamp-3 break-words ${isCommand ? 'font-mono' : ''}`}
						style={{ color: theme.colors.textMain }}
					>
						{displayText}
					</div>
					{isCommand && item.commandDescription && (
						<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
							{item.commandDescription}
						</div>
					)}
					{item.images && item.images.length > 0 && (
						<div
							className="text-xs mt-1 flex items-center gap-1"
							style={{ color: theme.colors.textDim }}
						>
							+ {item.images.length} image{item.images.length > 1 ? 's' : ''}
						</div>
					)}

					{/* Action buttons - a horizontal row along the bottom of the card,
					    always visible, matching the inline queued-item footer in the AI
					    chat: Send Now on the left, controls on the right. Stacking these
					    vertically forced every card to reserve the height of the whole
					    button column, which wasted space on the short messages that make
					    up most of the queue. The three-column grid keeps the pills on
					    the card's center line (equal 1fr outer tracks) exactly like the
					    inline queue footer and the finished turn's pills. */}
					<div className="mt-1.5 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1">
						<div className="flex items-center gap-1 min-w-0">
							{showForceSend && (
								<button
									onClick={(e) => {
										e.stopPropagation();
										onForceSend?.();
									}}
									disabled={!canForceSend}
									className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium whitespace-nowrap transition-opacity hover:opacity-80 disabled:cursor-default"
									style={{
										backgroundColor: theme.colors.warning + (canForceSend ? '33' : '15'),
										color: theme.colors.warning,
										opacity: canForceSend ? 1 : 0.5,
									}}
									title={forceSendTitle}
								>
									<Hammer className="w-3.5 h-3.5" />
									Send Now
								</button>
							)}
						</div>
						{/* The model/effort frozen when this item was queued - what it
						    will spawn under, no matter what is selected by the time the
						    queue reaches it. */}
						<div className="flex items-center justify-center gap-1 min-w-0">
							<TurnSettingPills
								theme={theme}
								model={item.turnSettings?.model}
								effort={item.turnSettings?.effort}
							/>
						</div>
						<div className="flex items-center justify-end gap-1">
							{onEdit && (
								<button
									onClick={(e) => {
										e.stopPropagation();
										onEdit();
									}}
									className="p-1.5 rounded hover:bg-black/20 transition-all"
									style={{ color: theme.colors.textDim }}
									title="Edit message and images"
								>
									<Pencil className="w-4 h-4" />
								</button>
							)}
							{onTogglePause && (
								<button
									onClick={(e) => {
										e.stopPropagation();
										onTogglePause();
									}}
									className="p-1.5 rounded hover:bg-black/20 transition-all"
									style={{ color: isPaused ? theme.colors.warning : theme.colors.textDim }}
									title={
										isPaused ? 'Resume this message' : 'Hold this message (skip until resumed)'
									}
								>
									{isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
								</button>
							)}
							<button
								onClick={(e) => {
									e.stopPropagation();
									onRemove();
								}}
								className="p-1.5 rounded hover:bg-red-500/20 transition-all"
								style={{ color: theme.colors.error }}
								title="Remove from queue"
							>
								<Trash2 className="w-4 h-4" />
							</button>
							<button
								onClick={(e) => {
									e.stopPropagation();
									const text =
										item.type === 'command'
											? [item.command, item.commandArgs].filter(Boolean).join(' ')
											: (item.text ?? '');
									safeClipboardWrite(text).then((ok) => {
										if (ok) {
											setCopied(true);
											if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
											copyResetTimerRef.current = setTimeout(() => setCopied(false), 1500);
										}
									});
								}}
								className="p-1.5 rounded hover:bg-black/20 transition-all"
								style={{ color: copied ? theme.colors.success : theme.colors.textDim }}
								title="Copy to clipboard"
							>
								{copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
							</button>
						</div>
					</div>
				</div>
			</div>

			{/* Shimmer effect when grabbed */}
			<QueueDragShimmer theme={theme} visible={showGrabbed} />
		</div>
	);
}

interface QueueItemAction {
	id: string;
	label: string;
	icon: ReactNode;
	/** Accent for the row (destructive red, Send Now amber). Defaults to body text. */
	color?: string;
	run: () => void;
}

/**
 * Small action list for the queued item under the keyboard cursor. Up/Down
 * choose, Enter runs, Escape closes (via the layer stack). Keys are read off
 * the window rather than a focused element so the menu works no matter where
 * focus landed when it opened.
 */
function QueueItemActionMenu({
	theme,
	position,
	actions,
	onClose,
}: {
	theme: Theme;
	/** 1-based position of the item in the visible list, for the title */
	position: number;
	actions: QueueItemAction[];
	onClose: () => void;
}) {
	const [index, setIndex] = useState(0);
	const activeIndex = actions.length === 0 ? -1 : Math.min(index, actions.length - 1);
	const stateRef = useRef<{ index: number; actions: QueueItemAction[] }>({ index: -1, actions });
	stateRef.current = { index: activeIndex, actions };

	const runAction = (action: QueueItemAction) => {
		onClose();
		action.run();
	};

	useEventListener('keydown', (e) => {
		const ke = e as KeyboardEvent;
		if (ke.metaKey || ke.ctrlKey || ke.altKey) return;
		const { index: i, actions: list } = stateRef.current;
		if (ke.key === 'ArrowDown' || ke.key === 'ArrowUp') {
			if (list.length === 0) return;
			ke.preventDefault();
			setIndex(ke.key === 'ArrowDown' ? Math.min(i + 1, list.length - 1) : Math.max(i - 1, 0));
			return;
		}
		if (ke.key === 'Enter') {
			if (i < 0) return;
			ke.preventDefault();
			runAction(list[i]);
		}
	});

	return (
		<Modal
			theme={theme}
			title={`Message #${position}`}
			priority={MODAL_PRIORITIES.CONFIRM}
			onClose={onClose}
			width={280}
			closeOnBackdropClick
			contentClassName="p-2 overflow-y-auto flex-1"
			testId="queue-item-action-menu"
			footer={
				<div className="text-xs w-full text-center" style={{ color: theme.colors.textDim }}>
					Up/Down to choose, Enter to run
				</div>
			}
		>
			<div className="flex flex-col gap-0.5" role="menu">
				{actions.map((action, i) => (
					<button
						key={action.id}
						role="menuitem"
						data-testid={`queue-action-${action.id}`}
						data-selected={i === activeIndex ? 'true' : undefined}
						onClick={() => runAction(action)}
						onMouseEnter={() => setIndex(i)}
						className="flex items-center gap-2 px-2.5 py-2 rounded text-sm text-left transition-colors"
						style={{
							backgroundColor: i === activeIndex ? theme.colors.accent + '25' : 'transparent',
							color: action.color ?? theme.colors.textMain,
						}}
					>
						{action.icon}
						{action.label}
					</button>
				))}
			</div>
		</Modal>
	);
}
