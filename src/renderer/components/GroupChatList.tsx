/**
 * @file GroupChatList.tsx
 * @description Left panel component for displaying and managing Group Chats.
 * Appears below the Ungrouped Agents section in the left sidebar.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { MessageSquare, ChevronDown, ChevronRight, Edit3, Trash2, Settings } from 'lucide-react';
import type { Theme, GroupChat, GroupChatState } from '../types';
import { useClickOutside } from '../hooks';
import { getStatusColor } from '../utils/theme';

// ============================================================================
// GroupChatContextMenu - Right-click context menu for group chat items
// ============================================================================

interface GroupChatContextMenuProps {
	x: number;
	y: number;
	theme: Theme;
	onEdit: () => void;
	onRename: () => void;
	onDelete: () => void;
	onClose: () => void;
}

function GroupChatContextMenu({
	x,
	y,
	theme,
	onEdit,
	onRename,
	onDelete,
	onClose,
}: GroupChatContextMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);

	// Close on click outside
	useClickOutside(menuRef, onClose);

	// Close on Escape
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				onClose();
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [onClose]);

	// Adjust menu position to stay within viewport
	const adjustedPosition = {
		left: Math.min(x, window.innerWidth - 150),
		top: Math.min(y, window.innerHeight - 100),
	};

	return (
		<div
			ref={menuRef}
			className="fixed z-50 py-1 rounded-md shadow-xl border"
			style={{
				left: adjustedPosition.left,
				top: adjustedPosition.top,
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
				minWidth: '120px',
			}}
		>
			<button
				onClick={() => {
					onEdit();
					onClose();
				}}
				className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
				style={{ color: theme.colors.textMain }}
			>
				<Settings className="w-3.5 h-3.5" />
				Edit
			</button>
			<button
				onClick={() => {
					onRename();
					onClose();
				}}
				className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
				style={{ color: theme.colors.textMain }}
			>
				<Edit3 className="w-3.5 h-3.5" />
				Rename
			</button>
			<button
				onClick={() => {
					onDelete();
					onClose();
				}}
				className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
				style={{ color: theme.colors.error }}
			>
				<Trash2 className="w-3.5 h-3.5" />
				Delete
			</button>
		</div>
	);
}

// ============================================================================
// GroupChatList - Main component for Group Chat list in left sidebar
// ============================================================================

interface GroupChatListProps {
	theme: Theme;
	groupChats: GroupChat[];
	activeGroupChatId: string | null;
	onOpenGroupChat: (id: string) => void;
	onNewGroupChat: () => void;
	onEditGroupChat: (id: string) => void;
	onRenameGroupChat: (id: string) => void;
	onDeleteGroupChat: (id: string) => void;
	/** Controlled expanded state (lifted to parent for keyboard navigation) */
	isExpanded?: boolean;
	/** Callback when expanded state changes */
	onExpandedChange?: (expanded: boolean) => void;
	/** Current state of the active group chat (for status indicator) */
	groupChatState?: GroupChatState;
	/** Per-participant working states for the active group chat */
	participantStates?: Map<string, 'idle' | 'working'>;
	/** State for ALL group chats (groupChatId -> state), for showing busy indicator when not active */
	groupChatStates?: Map<string, GroupChatState>;
	/** Participant states for ALL group chats (groupChatId -> Map<participantName, state>) */
	allGroupChatParticipantStates?: Map<string, Map<string, 'idle' | 'working'>>;
}

export function GroupChatList({
	theme,
	groupChats,
	activeGroupChatId,
	onOpenGroupChat,
	onNewGroupChat,
	onEditGroupChat,
	onRenameGroupChat,
	onDeleteGroupChat,
	isExpanded: controlledIsExpanded,
	onExpandedChange,
	groupChatState = 'idle',
	participantStates,
	groupChatStates,
	allGroupChatParticipantStates,
}: GroupChatListProps): JSX.Element {
	// Support both controlled and uncontrolled modes
	// If isExpanded prop is provided, use it as controlled state
	// Otherwise, use internal state (default: expanded if there are group chats)
	const [internalIsExpanded, setInternalIsExpanded] = useState(groupChats.length > 0);
	const isExpanded = controlledIsExpanded !== undefined ? controlledIsExpanded : internalIsExpanded;

	const setIsExpanded = useCallback(
		(expanded: boolean) => {
			if (onExpandedChange) {
				onExpandedChange(expanded);
			} else {
				setInternalIsExpanded(expanded);
			}
		},
		[onExpandedChange]
	);

	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		chatId: string;
	} | null>(null);

	// Track previous count to detect when chats are added
	const prevCountRef = useRef(groupChats.length);

	// Auto-expand when a new chat is added
	useEffect(() => {
		if (groupChats.length > prevCountRef.current) {
			// A chat was added, expand the list
			setIsExpanded(true);
		}
		prevCountRef.current = groupChats.length;
	}, [groupChats.length, setIsExpanded]);

	const handleContextMenu = (e: React.MouseEvent, chatId: string) => {
		e.preventDefault();
		setContextMenu({ x: e.clientX, y: e.clientY, chatId });
	};

	// Sort group chats alphabetically by name (case-insensitive)
	const sortedGroupChats = useMemo(() => {
		return [...groupChats].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
	}, [groupChats]);

	return (
		<div className="border-t mt-4" style={{ borderColor: theme.colors.border }}>
			{/* Header - Collapsible with count badge and New button */}
			<div
				className="px-3 py-2 flex items-center justify-between cursor-pointer hover:bg-white/5 group"
				onClick={() => setIsExpanded(!isExpanded)}
			>
				<div
					className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider"
					style={{ color: theme.colors.textDim }}
				>
					{isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
					<MessageSquare className="w-3.5 h-3.5" />
					<span>Group Chats</span>
					{groupChats.length > 0 && (
						<span
							className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
							style={{
								backgroundColor: theme.colors.border,
								color: theme.colors.textDim,
							}}
						>
							{groupChats.length}
						</span>
					)}
				</div>
				<button
					onClick={(e) => {
						e.stopPropagation();
						onNewGroupChat();
					}}
					className="px-2 py-0.5 rounded-full text-[10px] font-medium hover:opacity-80 transition-opacity flex items-center gap-1"
					style={{
						backgroundColor: theme.colors.accent + '20',
						color: theme.colors.accent,
						border: `1px solid ${theme.colors.accent}40`,
					}}
					title="New Group Chat"
				>
					<span>+ New Chat</span>
				</button>
			</div>

			{/* List of Group Chats */}
			{isExpanded && (
				<div className="px-2 pb-2">
					{groupChats.length === 0 ? (
						<div className="text-xs px-3 py-2 italic" style={{ color: theme.colors.textDim }}>
							No group chats yet
						</div>
					) : (
						<div
							className="flex flex-col border-l ml-4"
							style={{ borderColor: theme.colors.border }}
						>
							{sortedGroupChats.map((chat) => {
								const isActive = activeGroupChatId === chat.id;
								// Determine status for this group chat
								// For active chat, use the direct state props; for inactive chats, use the per-chat maps
								const chatState = isActive
									? groupChatState
									: groupChatStates?.get(chat.id) || 'idle';
								const isBusy = chatState !== 'idle';
								// Check if any participant is working
								const chatParticipantStates = isActive
									? participantStates
									: allGroupChatParticipantStates?.get(chat.id);
								const hasWorkingParticipant =
									chatParticipantStates &&
									Array.from(chatParticipantStates.values()).some((s) => s === 'working');
								// Show busy indicator if moderator is thinking OR any participant is working
								const showBusy = isBusy || hasWorkingParticipant;
								// Map to session state for getStatusColor compatibility
								const effectiveState = showBusy ? 'busy' : 'idle';
								const statusColor = getStatusColor(effectiveState, theme);

								return (
									<div
										key={chat.id}
										className="flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors hover:bg-white/5"
										style={{
											backgroundColor: isActive ? `${theme.colors.accent}20` : 'transparent',
										}}
										onDoubleClick={() => onOpenGroupChat(chat.id)}
										onClick={() => onOpenGroupChat(chat.id)}
										onContextMenu={(e) => handleContextMenu(e, chat.id)}
									>
										<MessageSquare
											className="w-4 h-4 shrink-0"
											style={{ color: isActive ? theme.colors.accent : theme.colors.textDim }}
										/>
										<span
											className="text-sm truncate flex-1"
											style={{ color: theme.colors.textMain }}
										>
											{chat.name}
										</span>
										{chat.participants.length > 0 && (
											<span
												className="text-[10px] px-1.5 py-0.5 rounded-full"
												style={{
													backgroundColor: theme.colors.border,
													color: theme.colors.textDim,
												}}
												title={`${chat.participants.length} participant${chat.participants.length !== 1 ? 's' : ''}`}
											>
												{chat.participants.length}
											</span>
										)}
										{/* Status indicator circle - on right side to align with session indicators */}
										<div
											className={`w-2 h-2 rounded-full shrink-0 ${showBusy ? 'animate-pulse' : ''}`}
											style={{ backgroundColor: statusColor }}
											title={showBusy ? 'Thinking...' : 'Idle'}
										/>
									</div>
								);
							})}
						</div>
					)}
				</div>
			)}

			{/* Context Menu */}
			{contextMenu && (
				<GroupChatContextMenu
					x={contextMenu.x}
					y={contextMenu.y}
					theme={theme}
					onEdit={() => onEditGroupChat(contextMenu.chatId)}
					onRename={() => onRenameGroupChat(contextMenu.chatId)}
					onDelete={() => onDeleteGroupChat(contextMenu.chatId)}
					onClose={() => setContextMenu(null)}
				/>
			)}
		</div>
	);
}
