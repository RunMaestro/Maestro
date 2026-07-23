/**
 * @file GroupChatList.tsx
 * @description Left panel component for displaying and managing Group Chats.
 * Appears below the Ungrouped Agents section in the left sidebar.
 */

import { memo, useState, useRef, useMemo, useCallback } from 'react';
import { useEventListener } from '../hooks/utils/useEventListener';
import {
	MessageSquare,
	ChevronDown,
	ChevronRight,
	Edit3,
	Trash2,
	Settings,
	Archive,
	ArchiveRestore,
	Clock,
	ArrowDownAZ,
} from 'lucide-react';
import type { Theme, GroupChat, GroupChatState } from '../types';
import { useClickOutside, useContextMenuPosition } from '../hooks';
import { getStatusColor } from '../utils/theme';

// ============================================================================
// GroupChatContextMenu - Right-click context menu for group chat items
// ============================================================================

interface GroupChatContextMenuProps {
	x: number;
	y: number;
	theme: Theme;
	isArchived: boolean;
	onEdit: () => void;
	onRename: () => void;
	onArchive?: () => void;
	onDelete: () => void;
	onClose: () => void;
}

function GroupChatContextMenu({
	x,
	y,
	theme,
	isArchived,
	onEdit,
	onRename,
	onArchive,
	onDelete,
	onClose,
}: GroupChatContextMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);

	// Close on click outside
	useClickOutside(menuRef, onClose);

	// Close on Escape
	useEventListener(
		'keydown',
		(e) => {
			if ((e as KeyboardEvent).key === 'Escape') onClose();
		},
		{ target: document }
	);

	// Measure menu and adjust position to stay within viewport
	const { left, top, ready } = useContextMenuPosition(menuRef, x, y);

	return (
		<div
			ref={menuRef}
			className="fixed z-50 py-1 rounded-md shadow-xl border"
			style={{
				left,
				top,
				opacity: ready ? 1 : 0,
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
			{onArchive && (
				<button
					onClick={() => {
						onArchive();
						onClose();
					}}
					className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
					style={{ color: theme.colors.textMain }}
				>
					{isArchived ? (
						<ArchiveRestore className="w-3.5 h-3.5" />
					) : (
						<Archive className="w-3.5 h-3.5" />
					)}
					{isArchived ? 'Unarchive' : 'Archive'}
				</button>
			)}
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
	/** Chat currently under the keyboard-navigation cursor (sidebar arrow keys), or null. */
	keyboardSelectedChatId?: string | null;
	onOpenGroupChat: (id: string) => void;
	onNewGroupChat: () => void;
	onEditGroupChat: (id: string) => void;
	onRenameGroupChat: (id: string) => void;
	onDeleteGroupChat: (id: string) => void;
	onArchiveGroupChat?: (id: string, archived: boolean) => void;
	onDeleteAllArchivedGroupChats?: () => void;
	/** Controlled expanded state (lifted to parent for keyboard navigation) */
	isExpanded?: boolean;
	/** Callback when expanded state changes */
	onExpandedChange?: (expanded: boolean) => void;
	/** When true, sort chats alphabetically by name instead of by most recent activity */
	sortAlphabetical?: boolean;
	/** Callback to toggle the alphabetical/most-recent sort order */
	onSortAlphabeticalChange?: (sortAlphabetical: boolean) => void;
	/** Current state of the active group chat (for status indicator) */
	groupChatState?: GroupChatState;
	/** Per-participant working states for the active group chat */
	participantStates?: Map<string, 'idle' | 'working'>;
	/** State for ALL group chats (groupChatId -> state), for showing busy indicator when not active */
	groupChatStates?: Map<string, GroupChatState>;
	/** Participant states for ALL group chats (groupChatId -> Map<participantName, state>) */
	allGroupChatParticipantStates?: Map<string, Map<string, 'idle' | 'working'>>;
	/** When true, only show group chats that are busy (moderator/participant working) or the active chat */
	showUnreadAgentsOnly?: boolean;
}

function GroupChatListInner({
	theme,
	groupChats,
	activeGroupChatId,
	keyboardSelectedChatId,
	onOpenGroupChat,
	onNewGroupChat,
	onEditGroupChat,
	onRenameGroupChat,
	onDeleteGroupChat,
	onArchiveGroupChat,
	onDeleteAllArchivedGroupChats,
	isExpanded: controlledIsExpanded,
	onExpandedChange,
	sortAlphabetical = false,
	onSortAlphabeticalChange,
	groupChatState = 'idle',
	participantStates,
	groupChatStates,
	allGroupChatParticipantStates,
	showUnreadAgentsOnly = false,
}: GroupChatListProps): JSX.Element | null {
	// Support both controlled and uncontrolled modes
	// If isExpanded prop is provided, use it as controlled state
	// Otherwise, use internal state (default: expanded if there are group chats)
	const [internalIsExpanded, setInternalIsExpanded] = useState(groupChats.length > 0);
	const isExpanded = controlledIsExpanded !== undefined ? controlledIsExpanded : internalIsExpanded;

	const [showArchived, setShowArchived] = useState(false);

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

	const handleContextMenu = (e: React.MouseEvent, chatId: string) => {
		e.preventDefault();
		setContextMenu({ x: e.clientX, y: e.clientY, chatId });
	};

	const archivedCount = useMemo(() => groupChats.filter((c) => c.archived).length, [groupChats]);
	const activeCount = groupChats.length - archivedCount;

	// Determine which chats are busy (moderator thinking or any participant working).
	// Mirrors the per-chat status logic in the render below so the unread filter
	// matches what the user sees as a non-green status dot.
	const isChatBusy = useCallback(
		(chatId: string): boolean => {
			const isActive = activeGroupChatId === chatId;
			const chatState = isActive ? groupChatState : groupChatStates?.get(chatId) || 'idle';
			if (chatState !== 'idle') return true;
			const chatParticipantStates = isActive
				? participantStates
				: allGroupChatParticipantStates?.get(chatId);
			if (!chatParticipantStates) return false;
			for (const s of chatParticipantStates.values()) {
				if (s === 'working') return true;
			}
			return false;
		},
		[
			activeGroupChatId,
			groupChatState,
			groupChatStates,
			participantStates,
			allGroupChatParticipantStates,
		]
	);

	// Filter and sort group chats: show active chats, plus archived if toggled.
	// When the unread-agents filter is on, also drop idle chats (keeping the
	// active one so the user doesn't lose their place).
	const sortedGroupChats = useMemo(() => {
		return [...groupChats]
			.filter((c) => (showArchived ? true : !c.archived))
			.filter((c) => {
				if (!showUnreadAgentsOnly) return true;
				if (c.id === activeGroupChatId) return true;
				return isChatBusy(c.id);
			})
			.sort((a, b) => {
				// When showing archived, group active chats first
				if (showArchived && a.archived !== b.archived) {
					return a.archived ? 1 : -1;
				}
				if (sortAlphabetical) {
					return a.name.localeCompare(b.name);
				}
				return (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt);
			});
	}, [
		groupChats,
		showArchived,
		showUnreadAgentsOnly,
		activeGroupChatId,
		isChatBusy,
		sortAlphabetical,
	]);

	// When the unread-agents filter hides everything, drop the section entirely
	// rather than leaving an empty header dangling at the bottom of the sidebar.
	if (showUnreadAgentsOnly && sortedGroupChats.length === 0) return null;

	return (
		<div className="border-t mt-4" style={{ borderColor: theme.colors.border }}>
			{/* Header - Collapsible, with count badge and New Chat button.
			    This row must always stay on ONE line as the sidebar narrows; it
			    used to wrap onto a second row and shove the list down.

			    Two mechanisms keep it single-line:
			      - Structural: whitespace-nowrap/truncate on the title and
			        shrink-0 on the controls. This alone prevents wrapping.
			      - Progressive: `gc-header-container` opens a container-query
			        context, and the `@container gcheader` rules in index.css
			        drop the count badge, then the archived count, then the
			        "New Chat" label as space runs out.

			    IMPORTANT: if you add another control to this row, add a matching
			    drop rule in index.css - otherwise the row grows wide again with
			    nothing to shed at the 280px sidebar minimum. The hook class goes
			    on a label/count *inside* a button, never on the button itself, so
			    the affordance stays clickable when its text is hidden.
			    Contract is pinned by GroupChatList.test.tsx and
			    groupChatHeaderResponsive.regression.test.ts. */}
			<div
				className="gc-header-container px-3 py-2 flex items-center justify-between cursor-pointer hover:bg-white/5 group"
				onClick={() => setIsExpanded(!isExpanded)}
			>
				<div
					className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider whitespace-nowrap min-w-0"
					style={{ color: theme.colors.textDim }}
				>
					{isExpanded ? (
						<ChevronDown className="w-3 h-3 shrink-0" />
					) : (
						<ChevronRight className="w-3 h-3 shrink-0" />
					)}
					<MessageSquare className="w-3.5 h-3.5 shrink-0" />
					<span className="truncate">Group Chats</span>
					{activeCount > 0 && (
						<span
							className="gc-count-badge text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0"
							style={{
								backgroundColor: theme.colors.border,
								color: theme.colors.textDim,
							}}
						>
							{activeCount}
						</span>
					)}
				</div>
				<div className="flex items-center gap-1.5 shrink-0">
					{onSortAlphabeticalChange && activeCount > 1 && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								onSortAlphabeticalChange(!sortAlphabetical);
							}}
							className="px-2 py-0.5 rounded-full text-[10px] font-medium hover:opacity-80 transition-opacity flex items-center gap-1"
							style={{
								backgroundColor: 'transparent',
								color: theme.colors.textDim,
								border: `1px solid ${theme.colors.border}`,
							}}
							title={
								sortAlphabetical
									? 'Sorting alphabetically (click to sort by most recent)'
									: 'Sorting by most recent (click to sort alphabetically)'
							}
						>
							{sortAlphabetical ? (
								<ArrowDownAZ className="w-3 h-3" />
							) : (
								<Clock className="w-3 h-3" />
							)}
						</button>
					)}
					{onArchiveGroupChat && archivedCount > 0 && (
						<button
							onClick={(e) => {
								e.stopPropagation();
								setShowArchived(!showArchived);
							}}
							className="px-2 py-0.5 rounded-full text-[10px] font-medium hover:opacity-80 transition-opacity flex items-center gap-1"
							style={{
								backgroundColor: showArchived ? `${theme.colors.textDim}20` : 'transparent',
								color: theme.colors.textDim,
								border: `1px solid ${theme.colors.border}`,
							}}
							title={
								showArchived
									? 'Hide archived chats'
									: `Show ${archivedCount} archived chat${archivedCount !== 1 ? 's' : ''}`
							}
						>
							<Archive className="w-3 h-3 shrink-0" />
							<span className="gc-archived-count">{archivedCount}</span>
						</button>
					)}
					<button
						onClick={(e) => {
							e.stopPropagation();
							// Creating a chat is a deliberate action, so expand to reveal it.
							setIsExpanded(true);
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
						<span aria-hidden="true">+</span>
						<span className="gc-newchat-label">New Chat</span>
					</button>
				</div>
			</div>

			{/* List of Group Chats */}
			{isExpanded && (
				<div className="px-2 pb-2">
					{sortedGroupChats.length === 0 ? (
						<div className="text-xs px-3 py-2 italic" style={{ color: theme.colors.textDim }}>
							{groupChats.length === 0 ? 'No group chats yet' : 'All group chats are archived'}
						</div>
					) : (
						<div
							className="flex flex-col border-l ml-4"
							style={{ borderColor: theme.colors.border }}
						>
							{sortedGroupChats.map((chat) => {
								const isActive = activeGroupChatId === chat.id;
								const isKeyboardSelected = keyboardSelectedChatId === chat.id;
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
										data-nav-key={`groupchat:${chat.id}`}
										className="flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors hover:bg-white/5"
										style={{
											backgroundColor: isActive
												? `${theme.colors.accent}20`
												: isKeyboardSelected
													? `${theme.colors.bgActivity}40`
													: 'transparent',
											boxShadow: isKeyboardSelected
												? `inset 2px 0 0 0 ${theme.colors.accent}`
												: undefined,
											opacity: chat.archived ? 0.5 : 1,
										}}
										onDoubleClick={() => onOpenGroupChat(chat.id)}
										onClick={() => onOpenGroupChat(chat.id)}
										onContextMenu={(e) => handleContextMenu(e, chat.id)}
									>
										{chat.archived ? (
											<Archive
												className="w-4 h-4 shrink-0"
												style={{ color: theme.colors.textDim }}
											/>
										) : (
											<MessageSquare
												className="w-4 h-4 shrink-0"
												style={{ color: isActive ? theme.colors.accent : theme.colors.textDim }}
											/>
										)}
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
					{/* Delete All Archived button */}
					{showArchived && archivedCount > 0 && onDeleteAllArchivedGroupChats && (
						<button
							onClick={onDeleteAllArchivedGroupChats}
							className="flex items-center gap-1.5 w-full px-3 py-1.5 mt-1 text-xs rounded hover:opacity-80 transition-opacity"
							style={{
								color: theme.colors.error,
								backgroundColor: `${theme.colors.error}10`,
							}}
						>
							<Trash2 className="w-3 h-3" />
							<span>Delete All Archived</span>
						</button>
					)}
				</div>
			)}

			{/* Context Menu */}
			{contextMenu && (
				<GroupChatContextMenu
					x={contextMenu.x}
					y={contextMenu.y}
					theme={theme}
					isArchived={!!groupChats.find((c) => c.id === contextMenu.chatId)?.archived}
					onEdit={() => onEditGroupChat(contextMenu.chatId)}
					onRename={() => onRenameGroupChat(contextMenu.chatId)}
					onArchive={
						onArchiveGroupChat
							? () => {
									const chat = groupChats.find((c) => c.id === contextMenu.chatId);
									if (chat) onArchiveGroupChat(chat.id, !chat.archived);
								}
							: undefined
					}
					onDelete={() => onDeleteGroupChat(contextMenu.chatId)}
					onClose={() => setContextMenu(null)}
				/>
			)}
		</div>
	);
}

export const GroupChatList = memo(GroupChatListInner);
