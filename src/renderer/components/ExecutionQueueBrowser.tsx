import React, { useState, useEffect, useRef } from 'react';
import { X, MessageSquare, Command, Trash2, Clock, Folder, FolderOpen } from 'lucide-react';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import type { Session, Theme, QueuedItem } from '../types';

interface ExecutionQueueBrowserProps {
	isOpen: boolean;
	onClose: () => void;
	sessions: Session[];
	activeSessionId: string | null;
	theme: Theme;
	onRemoveItem: (sessionId: string, itemId: string) => void;
	onSwitchSession: (sessionId: string) => void;
	onReorderItems?: (sessionId: string, fromIndex: number, toIndex: number) => void;
}

interface DragState {
	sessionId: string;
	itemId: string;
	fromIndex: number;
}

interface DropIndicator {
	sessionId: string;
	index: number;
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
}: ExecutionQueueBrowserProps) {
	const [viewMode, setViewMode] = useState<'current' | 'global'>('current');
	const [dragState, setDragState] = useState<DragState | null>(null);
	const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
	const { registerLayer, unregisterLayer } = useLayerStack();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// Drag handlers
	const handleDragStart = (sessionId: string, itemId: string, index: number) => {
		setDragState({ sessionId, itemId, fromIndex: index });
	};

	const handleDragOver = (sessionId: string, index: number) => {
		// Allow dropping within the same session only (cross-session would require moving items)
		if (dragState && dragState.sessionId === sessionId) {
			setDropIndicator({ sessionId, index });
		}
	};

	const handleDragEnd = () => {
		if (dragState && dropIndicator && onReorderItems) {
			const { sessionId, fromIndex } = dragState;
			const toIndex = dropIndicator.index;

			// Only reorder if indices differ
			if (fromIndex !== toIndex && fromIndex !== toIndex - 1) {
				// Adjust toIndex if dropping after the dragged item
				const adjustedToIndex = toIndex > fromIndex ? toIndex - 1 : toIndex;
				onReorderItems(sessionId, fromIndex, adjustedToIndex);
			}
		}
		setDragState(null);
		setDropIndicator(null);
	};

	const handleDragCancel = () => {
		setDragState(null);
		setDropIndicator(null);
	};

	// Register with layer stack for proper escape handling
	useEffect(() => {
		if (isOpen) {
			const id = registerLayer({
				type: 'modal',
				priority: MODAL_PRIORITIES.EXECUTION_QUEUE_BROWSER || 50,
				blocksLowerLayers: true,
				capturesFocus: true,
				focusTrap: 'strict',
				onEscape: () => onCloseRef.current(),
			});
			return () => unregisterLayer(id);
		}
	}, [isOpen, registerLayer, unregisterLayer]);

	if (!isOpen) return null;

	// Get sessions with queued items
	const sessionsWithQueues = sessions.filter(
		(s) => s.executionQueue && s.executionQueue.length > 0
	);

	// Filter based on view mode
	const filteredSessions =
		viewMode === 'current'
			? sessionsWithQueues.filter((s) => s.id === activeSessionId)
			: sessionsWithQueues;

	// Get total queue count for display
	const totalQueuedItems = sessionsWithQueues.reduce(
		(sum, s) => sum + (s.executionQueue?.length || 0),
		0
	);

	const currentSessionItems = activeSessionId
		? sessions.find((s) => s.id === activeSessionId)?.executionQueue?.length || 0
		: 0;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
			{/* Backdrop */}
			<div className="absolute inset-0 bg-black/60" style={{ backdropFilter: 'blur(2px)' }} />

			{/* Modal */}
			<div
				className="relative w-full max-w-2xl max-h-[80vh] rounded-lg border shadow-2xl flex flex-col"
				style={{
					backgroundColor: theme.colors.bgMain,
					borderColor: theme.colors.border,
				}}
				onClick={(e) => e.stopPropagation()}
			>
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
									{session.executionQueue?.map((item, index) => (
										<React.Fragment key={item.id}>
											{/* Drop indicator before this item */}
											<DropZone
												theme={theme}
												isActive={
													dropIndicator?.sessionId === session.id && dropIndicator?.index === index
												}
												onDragOver={() => handleDragOver(session.id, index)}
											/>
											<QueueItemRow
												item={item}
												index={index}
												theme={theme}
												onRemove={() => onRemoveItem(session.id, item.id)}
												onSwitchToSession={() => {
													onSwitchSession(session.id);
													onClose();
												}}
												isDragging={dragState?.itemId === item.id}
												canDrag={!!onReorderItems && (session.executionQueue?.length || 0) > 1}
												isAnyDragging={!!dragState}
												onDragStart={() => handleDragStart(session.id, item.id, index)}
												onDragEnd={handleDragEnd}
												onDragCancel={handleDragCancel}
											/>
										</React.Fragment>
									))}
									{/* Final drop zone after all items */}
									<DropZone
										theme={theme}
										isActive={
											dropIndicator?.sessionId === session.id &&
											dropIndicator?.index === (session.executionQueue?.length || 0)
										}
										onDragOver={() =>
											handleDragOver(session.id, session.executionQueue?.length || 0)
										}
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
					Drag and drop to reorder. Items are processed sequentially per agent to prevent file
					conflicts.
				</div>
			</div>
		</div>
	);
}

interface DropZoneProps {
	theme: Theme;
	isActive: boolean;
	onDragOver: () => void;
}

function DropZone({ theme, isActive, onDragOver }: DropZoneProps) {
	return (
		<div className="relative h-1 -my-0.5 z-10" onMouseEnter={onDragOver}>
			<div
				className="absolute inset-x-3 top-1/2 -translate-y-1/2 h-0.5 rounded-full transition-all duration-200"
				style={{
					backgroundColor: isActive ? theme.colors.accent : 'transparent',
					boxShadow: isActive ? `0 0 8px ${theme.colors.accent}` : 'none',
					transform: `translateY(-50%) scaleX(${isActive ? 1 : 0})`,
				}}
			/>
		</div>
	);
}

interface QueueItemRowProps {
	item: QueuedItem;
	index: number;
	theme: Theme;
	onRemove: () => void;
	onSwitchToSession: () => void;
	isDragging?: boolean;
	canDrag?: boolean;
	isAnyDragging?: boolean;
	onDragStart?: () => void;
	onDragEnd?: () => void;
	onDragCancel?: () => void;
}

function QueueItemRow({
	item,
	index,
	theme,
	onRemove,
	onSwitchToSession,
	isDragging,
	canDrag,
	isAnyDragging,
	onDragStart,
	onDragEnd,
	onDragCancel,
}: QueueItemRowProps) {
	const [isPressed, setIsPressed] = useState(false);
	const [isHovered, setIsHovered] = useState(false);
	const pressTimerRef = useRef<NodeJS.Timeout | null>(null);
	const isDraggingRef = useRef(false);

	const isCommand = item.type === 'command';
	const displayText = isCommand
		? item.command
		: (item.text?.length || 0) > 100
			? item.text?.slice(0, 100) + '...'
			: item.text;

	const timeSinceQueued = Date.now() - item.timestamp;
	const minutes = Math.floor(timeSinceQueued / 60000);
	const timeDisplay = minutes < 1 ? 'Just now' : `${minutes}m ago`;

	// Handle mouse down for drag initiation
	const handleMouseDown = (e: React.MouseEvent) => {
		if (!canDrag || e.button !== 0) return;

		// Don't start drag if clicking on buttons
		if ((e.target as HTMLElement).closest('button')) return;

		setIsPressed(true);

		// Small delay before initiating drag to allow for click detection
		pressTimerRef.current = setTimeout(() => {
			isDraggingRef.current = true;
			onDragStart?.();
		}, 150);
	};

	const handleMouseUp = () => {
		if (pressTimerRef.current) {
			clearTimeout(pressTimerRef.current);
			pressTimerRef.current = null;
		}

		if (isDraggingRef.current) {
			onDragEnd?.();
			isDraggingRef.current = false;
		}

		setIsPressed(false);
	};

	const handleMouseLeave = () => {
		setIsHovered(false);

		if (pressTimerRef.current) {
			clearTimeout(pressTimerRef.current);
			pressTimerRef.current = null;
		}

		// Don't cancel drag on leave - let mouse up handle it
		if (!isDraggingRef.current) {
			setIsPressed(false);
		}
	};

	// Cleanup timer on unmount
	useEffect(() => {
		return () => {
			if (pressTimerRef.current) {
				clearTimeout(pressTimerRef.current);
			}
		};
	}, []);

	// Handle escape key to cancel drag
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && isDragging) {
				onDragCancel?.();
				isDraggingRef.current = false;
				setIsPressed(false);
			}
		};

		if (isDragging) {
			window.addEventListener('keydown', handleKeyDown);
			window.addEventListener('mouseup', handleMouseUp);
			return () => {
				window.removeEventListener('keydown', handleKeyDown);
				window.removeEventListener('mouseup', handleMouseUp);
			};
		}
	}, [isDragging, onDragCancel]);

	// Visual states
	const showDragReady = canDrag && isHovered && !isDragging && !isAnyDragging;
	const showGrabbed = isPressed || isDragging;
	const isDimmed = isAnyDragging && !isDragging;

	return (
		<div
			className="relative my-1"
			style={{
				zIndex: isDragging ? 50 : 1,
			}}
		>
			<div
				className="flex items-start gap-3 px-3 py-2.5 rounded-lg border group select-none"
				style={{
					backgroundColor: isDragging ? theme.colors.bgMain : theme.colors.bgSidebar,
					borderColor: isDragging
						? theme.colors.accent
						: showGrabbed
							? theme.colors.accent + '80'
							: theme.colors.border,
					cursor: canDrag ? (isDragging ? 'grabbing' : 'grab') : 'default',
					transform: isDragging
						? 'scale(1.02) rotate(1deg)'
						: showGrabbed
							? 'scale(1.01)'
							: 'scale(1)',
					boxShadow: isDragging
						? `0 8px 32px ${theme.colors.accent}40, 0 4px 16px rgba(0,0,0,0.3)`
						: showGrabbed
							? `0 4px 16px ${theme.colors.accent}20`
							: 'none',
					transition: isDragging ? 'none' : 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
					opacity: isDragging ? 0.95 : isDimmed ? 0.5 : 1,
				}}
				onMouseDown={handleMouseDown}
				onMouseUp={handleMouseUp}
				onMouseEnter={() => setIsHovered(true)}
				onMouseLeave={handleMouseLeave}
			>
				{/* Drag handle indicator */}
				{canDrag && (
					<div
						className="absolute left-1 top-1/2 -translate-y-1/2 flex flex-col gap-0.5 transition-opacity duration-200"
						style={{
							opacity: showDragReady || showGrabbed ? 0.6 : 0,
						}}
					>
						<div className="flex gap-0.5">
							<div
								className="w-1 h-1 rounded-full"
								style={{ backgroundColor: theme.colors.textDim }}
							/>
							<div
								className="w-1 h-1 rounded-full"
								style={{ backgroundColor: theme.colors.textDim }}
							/>
						</div>
						<div className="flex gap-0.5">
							<div
								className="w-1 h-1 rounded-full"
								style={{ backgroundColor: theme.colors.textDim }}
							/>
							<div
								className="w-1 h-1 rounded-full"
								style={{ backgroundColor: theme.colors.textDim }}
							/>
						</div>
						<div className="flex gap-0.5">
							<div
								className="w-1 h-1 rounded-full"
								style={{ backgroundColor: theme.colors.textDim }}
							/>
							<div
								className="w-1 h-1 rounded-full"
								style={{ backgroundColor: theme.colors.textDim }}
							/>
						</div>
					</div>
				)}

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
						{item.tabName && (
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
								{item.tabName}
							</button>
						)}
						<span
							className="text-xs flex items-center gap-1"
							style={{ color: theme.colors.textDim }}
						>
							<Clock className="w-3 h-3" />
							{timeDisplay}
						</span>
					</div>
					<div
						className={`mt-1 text-sm ${isCommand ? 'font-mono' : ''}`}
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
				</div>

				{/* Remove button */}
				<button
					onClick={(e) => {
						e.stopPropagation();
						onRemove();
					}}
					className="p-1.5 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/20 transition-all"
					style={{ color: theme.colors.error }}
					title="Remove from queue"
				>
					<Trash2 className="w-4 h-4" />
				</button>
			</div>

			{/* Shimmer effect when grabbed */}
			{showGrabbed && (
				<div
					className="absolute inset-0 rounded-lg pointer-events-none overflow-hidden"
					style={{
						background: `linear-gradient(90deg, transparent, ${theme.colors.accent}10, transparent)`,
						animation: 'shimmer 1.5s infinite',
					}}
				/>
			)}
		</div>
	);
}
