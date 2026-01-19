import React, { useState, useEffect, useRef, useMemo, memo, useCallback } from 'react';
import {
	Wand2,
	Plus,
	Settings,
	ChevronRight,
	ChevronDown,
	ChevronUp,
	X,
	Keyboard,
	Radio,
	Copy,
	ExternalLink,
	PanelLeftClose,
	PanelLeftOpen,
	Folder,
	FolderPlus,
	Info,
	GitBranch,
	Bot,
	Clock,
	ScrollText,
	Cpu,
	Menu,
	Bookmark,
	Trophy,
	Trash2,
	Edit3,
	FolderInput,
	Download,
	Compass,
	Globe,
	GitPullRequest,
	BookOpen,
	BarChart3,
	Server,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import type {
	Session,
	Group,
	Theme,
	Shortcut,
	AutoRunStats,
	GroupChat,
	GroupChatState,
	SettingsTab,
	FocusArea,
} from '../types';
import { getBadgeForTime } from '../constants/conductorBadges';
import { getStatusColor, getContextColor, formatActiveTime } from '../utils/theme';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { SessionItem } from './SessionItem';
import { GroupChatList } from './GroupChatList';
import { useLiveOverlay, useClickOutside } from '../hooks';
import { useGitFileStatus } from '../contexts/GitStatusContext';

// ============================================================================
// SessionContextMenu - Right-click context menu for session items
// ============================================================================

interface SessionContextMenuProps {
	x: number;
	y: number;
	theme: Theme;
	session: Session;
	groups: Group[];
	hasWorktreeChildren: boolean; // Whether this parent has worktree sub-agents
	onRename: () => void;
	onEdit: () => void;
	onDuplicate: () => void; // Opens New Agent dialog with pre-filled config
	onToggleBookmark: () => void;
	onMoveToGroup: (groupId: string) => void;
	onDelete: () => void;
	onDismiss: () => void;
	onCreatePR?: () => void; // For worktree child sessions
	onQuickCreateWorktree?: () => void; // Opens small modal for quick worktree creation
	onConfigureWorktrees?: () => void; // Opens full worktree config modal
	onDeleteWorktree?: () => void; // For worktree child sessions to delete
	onCreateGroup?: () => void; // Creates a new group from the Move to Group submenu
}

function SessionContextMenu({
	x,
	y,
	theme,
	session,
	groups,
	hasWorktreeChildren,
	onRename,
	onEdit,
	onDuplicate,
	onToggleBookmark,
	onMoveToGroup,
	onDelete,
	onDismiss,
	onCreatePR,
	onQuickCreateWorktree,
	onConfigureWorktrees,
	onDeleteWorktree,
	onCreateGroup,
}: SessionContextMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);
	const moveToGroupRef = useRef<HTMLDivElement>(null);
	const submenuTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [showMoveSubmenu, setShowMoveSubmenu] = useState(false);
	const [submenuPosition, setSubmenuPosition] = useState<{
		vertical: 'below' | 'above';
		horizontal: 'right' | 'left';
	}>({ vertical: 'below', horizontal: 'right' });

	// Use ref to avoid re-registering listener when onDismiss changes
	const onDismissRef = useRef(onDismiss);
	onDismissRef.current = onDismiss;

	// Close on click outside
	useClickOutside(menuRef, onDismiss);

	// Close on Escape - stable listener that never re-registers
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				onDismissRef.current();
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, []);

	// Adjust menu position to stay within viewport
	const adjustedPosition = {
		left: Math.min(x, window.innerWidth - 200),
		top: Math.min(y, window.innerHeight - 250),
	};

	// Calculate submenu position when showing
	const handleMoveToGroupHover = () => {
		// Clear any pending close timeout
		if (submenuTimeoutRef.current) {
			clearTimeout(submenuTimeoutRef.current);
			submenuTimeoutRef.current = null;
		}
		setShowMoveSubmenu(true);

		if (moveToGroupRef.current) {
			const rect = moveToGroupRef.current.getBoundingClientRect();
			// Estimate submenu height: ~28px per item + 8px padding + divider
			const itemHeight = 28;
			const submenuHeight = (groups.length + 1) * itemHeight + 16 + (groups.length > 0 ? 8 : 0);
			const submenuWidth = 160; // minWidth + some padding
			const spaceBelow = window.innerHeight - rect.top;
			const spaceRight = window.innerWidth - rect.right;

			// Determine vertical position
			const vertical = spaceBelow < submenuHeight && rect.top > submenuHeight ? 'above' : 'below';

			// Determine horizontal position
			const horizontal = spaceRight < submenuWidth && rect.left > submenuWidth ? 'left' : 'right';

			setSubmenuPosition({ vertical, horizontal });
		}
	};

	// Delayed close for submenu to allow mouse to travel to it
	const handleMoveToGroupLeave = () => {
		submenuTimeoutRef.current = setTimeout(() => {
			setShowMoveSubmenu(false);
		}, 300); // 300ms delay to move mouse to submenu
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
				minWidth: '160px',
			}}
		>
			{/* Rename */}
			<button
				onClick={() => {
					onRename();
					onDismiss();
				}}
				className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
				style={{ color: theme.colors.textMain }}
			>
				<Edit3 className="w-3.5 h-3.5" />
				Rename
			</button>

			{/* Edit Agent */}
			<button
				onClick={() => {
					onEdit();
					onDismiss();
				}}
				className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
				style={{ color: theme.colors.textMain }}
			>
				<Settings className="w-3.5 h-3.5" />
				Edit Agent...
			</button>

			{/* Duplicate */}
			<button
				onClick={() => {
					onDuplicate();
					onDismiss();
				}}
				className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
				style={{ color: theme.colors.textMain }}
			>
				<Copy className="w-3.5 h-3.5" />
				Duplicate...
			</button>

			{/* Toggle Bookmark - only for non-worktree sessions */}
			{!session.parentSessionId && (
				<button
					onClick={() => {
						onToggleBookmark();
						onDismiss();
					}}
					className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
					style={{ color: theme.colors.textMain }}
				>
					<Bookmark className="w-3.5 h-3.5" fill={session.bookmarked ? 'currentColor' : 'none'} />
					{session.bookmarked ? 'Remove Bookmark' : 'Add Bookmark'}
				</button>
			)}

			{/* Move to Group - only for non-worktree sessions, no separator */}
			{!session.parentSessionId && (
				<div
					ref={moveToGroupRef}
					className="relative"
					onMouseEnter={handleMoveToGroupHover}
					onMouseLeave={handleMoveToGroupLeave}
				>
					<button
						className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center justify-between"
						style={{ color: theme.colors.textMain }}
					>
						<span className="flex items-center gap-2">
							<FolderInput className="w-3.5 h-3.5" />
							Move to Group
						</span>
						<ChevronRight className="w-3 h-3" />
					</button>

					{/* Submenu */}
					{showMoveSubmenu && (
						<div
							className="absolute py-1 rounded-md shadow-xl border"
							style={{
								backgroundColor: theme.colors.bgSidebar,
								borderColor: theme.colors.border,
								minWidth: '140px',
								...(submenuPosition.vertical === 'above' ? { bottom: 0 } : { top: 0 }),
								...(submenuPosition.horizontal === 'left'
									? { right: '100%', marginRight: 4 }
									: { left: '100%', marginLeft: 4 }),
							}}
						>
							{/* No Group option */}
							<button
								onClick={() => {
									onMoveToGroup('');
									onDismiss();
								}}
								className={`w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2 ${!session.groupId ? 'opacity-50' : ''}`}
								style={{ color: theme.colors.textMain }}
								disabled={!session.groupId}
							>
								<Folder className="w-3.5 h-3.5" />
								Ungrouped
								{!session.groupId && <span className="text-[10px] opacity-50">(current)</span>}
							</button>

							{/* Divider if there are groups */}
							{groups.length > 0 && (
								<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
							)}

							{/* Group options */}
							{groups.map((group) => (
								<button
									key={group.id}
									onClick={() => {
										onMoveToGroup(group.id);
										onDismiss();
									}}
									className={`w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2 ${session.groupId === group.id ? 'opacity-50' : ''}`}
									style={{ color: theme.colors.textMain }}
									disabled={session.groupId === group.id}
								>
									<span>{group.emoji}</span>
									<span className="truncate">{group.name}</span>
									{session.groupId === group.id && (
										<span className="text-[10px] opacity-50">(current)</span>
									)}
								</button>
							))}

							{/* Divider before Create New Group */}
							{onCreateGroup && (
								<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
							)}

							{/* Create New Group option */}
							{onCreateGroup && (
								<button
									onClick={() => {
										onCreateGroup();
										onDismiss();
									}}
									className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
									style={{ color: theme.colors.accent }}
								>
									<FolderPlus className="w-3.5 h-3.5" />
									Create New Group
								</button>
							)}
						</div>
					)}
				</div>
			)}

			{/* Worktree section - for parent sessions */}
			{(hasWorktreeChildren || session.isGitRepo) &&
				!session.parentSessionId &&
				(onQuickCreateWorktree || onConfigureWorktrees) && (
					<>
						<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
						{/* Only show Create Worktree if worktrees have been configured */}
						{onQuickCreateWorktree && session.worktreeConfig && (
							<button
								onClick={() => {
									onQuickCreateWorktree();
									onDismiss();
								}}
								className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
								style={{ color: theme.colors.accent }}
							>
								<GitBranch className="w-3.5 h-3.5" />
								Create Worktree
							</button>
						)}
						{onConfigureWorktrees && (
							<button
								onClick={() => {
									onConfigureWorktrees();
									onDismiss();
								}}
								className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
								style={{ color: theme.colors.accent }}
							>
								<Settings className="w-3.5 h-3.5" />
								Configure Worktrees
							</button>
						)}
					</>
				)}

			{/* Worktree child session actions */}
			{session.parentSessionId && session.worktreeBranch && (
				<>
					<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
					{onCreatePR && (
						<button
							onClick={() => {
								onCreatePR();
								onDismiss();
							}}
							className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
							style={{ color: theme.colors.accent }}
						>
							<GitPullRequest className="w-3.5 h-3.5" />
							Create Pull Request
						</button>
					)}
					{onDeleteWorktree && (
						<button
							onClick={() => {
								onDeleteWorktree();
								onDismiss();
							}}
							className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
							style={{ color: theme.colors.error }}
						>
							<Trash2 className="w-3.5 h-3.5" />
							Remove Worktree
						</button>
					)}
				</>
			)}

			{/* Remove Agent - only for non-worktree sessions */}
			{!session.parentSessionId && (
				<>
					<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
					<button
						onClick={() => {
							onDelete();
							onDismiss();
						}}
						className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
						style={{ color: theme.colors.error }}
					>
						<Trash2 className="w-3.5 h-3.5" />
						Remove Agent
					</button>
				</>
			)}
		</div>
	);
}

// ============================================================================
// HamburgerMenuContent - Shared menu content for expanded/collapsed sidebar
// ============================================================================

interface HamburgerMenuContentProps {
	theme: Theme;
	shortcuts: Record<string, Shortcut>;
	openWizard?: () => void;
	startTour?: () => void;
	setShortcutsHelpOpen: (open: boolean) => void;
	setSettingsModalOpen: (open: boolean) => void;
	setSettingsTab: (tab: SettingsTab) => void;
	setLogViewerOpen: (open: boolean) => void;
	setProcessMonitorOpen: (open: boolean) => void;
	setUsageDashboardOpen: (open: boolean) => void;
	setUpdateCheckModalOpen: (open: boolean) => void;
	setAboutModalOpen: (open: boolean) => void;
	setMenuOpen: (open: boolean) => void;
}

function HamburgerMenuContent({
	theme,
	shortcuts,
	openWizard,
	startTour,
	setShortcutsHelpOpen,
	setSettingsModalOpen,
	setSettingsTab,
	setLogViewerOpen,
	setProcessMonitorOpen,
	setUsageDashboardOpen,
	setUpdateCheckModalOpen,
	setAboutModalOpen,
	setMenuOpen,
}: HamburgerMenuContentProps) {
	return (
		<div className="p-1">
			{openWizard && (
				<button
					onClick={() => {
						openWizard();
						setMenuOpen(false);
					}}
					className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
				>
					<Wand2 className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<div className="flex-1">
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							New Agent Wizard
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Get started with AI
						</div>
					</div>
					<span
						className="text-xs font-mono px-1.5 py-0.5 rounded"
						style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
					>
						{shortcuts.openWizard ? formatShortcutKeys(shortcuts.openWizard.keys) : '⇧⌘N'}
					</span>
				</button>
			)}
			{startTour && (
				<button
					onClick={() => {
						startTour();
						setMenuOpen(false);
					}}
					className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
				>
					<Compass className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<div className="flex-1">
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Introductory Tour
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Learn how to use Maestro
						</div>
					</div>
				</button>
			)}
			<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
			<button
				onClick={() => {
					setShortcutsHelpOpen(true);
					setMenuOpen(false);
				}}
				className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
			>
				<Keyboard className="w-5 h-5" style={{ color: theme.colors.accent }} />
				<div className="flex-1">
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Keyboard Shortcuts
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						View all available shortcuts
					</div>
				</div>
				<span
					className="text-xs font-mono px-1.5 py-0.5 rounded"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
				>
					{formatShortcutKeys(shortcuts.help.keys)}
				</span>
			</button>
			<button
				onClick={() => {
					setSettingsModalOpen(true);
					setSettingsTab('general');
					setMenuOpen(false);
				}}
				className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
			>
				<Settings className="w-5 h-5" style={{ color: theme.colors.accent }} />
				<div className="flex-1">
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Settings
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Configure preferences
					</div>
				</div>
				<span
					className="text-xs font-mono px-1.5 py-0.5 rounded"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
				>
					{formatShortcutKeys(shortcuts.settings.keys)}
				</span>
			</button>
			<button
				onClick={() => {
					setLogViewerOpen(true);
					setMenuOpen(false);
				}}
				className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
			>
				<ScrollText className="w-5 h-5" style={{ color: theme.colors.accent }} />
				<div className="flex-1">
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						System Logs
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						View application logs
					</div>
				</div>
				<span
					className="text-xs font-mono px-1.5 py-0.5 rounded"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
				>
					{formatShortcutKeys(shortcuts.systemLogs.keys)}
				</span>
			</button>
			<button
				onClick={() => {
					setProcessMonitorOpen(true);
					setMenuOpen(false);
				}}
				className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
			>
				<Cpu className="w-5 h-5" style={{ color: theme.colors.accent }} />
				<div className="flex-1">
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Process Monitor
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						View running processes
					</div>
				</div>
				<span
					className="text-xs font-mono px-1.5 py-0.5 rounded"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
				>
					{formatShortcutKeys(shortcuts.processMonitor.keys)}
				</span>
			</button>
			<button
				onClick={() => {
					setUsageDashboardOpen(true);
					setMenuOpen(false);
				}}
				className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
			>
				<BarChart3 className="w-5 h-5" style={{ color: theme.colors.accent }} />
				<div className="flex-1">
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Usage Dashboard
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						View usage analytics
					</div>
				</div>
				<span
					className="text-xs font-mono px-1.5 py-0.5 rounded"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
				>
					{formatShortcutKeys(shortcuts.usageDashboard.keys)}
				</span>
			</button>
			<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
			<button
				onClick={() => {
					setUpdateCheckModalOpen(true);
					setMenuOpen(false);
				}}
				className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
			>
				<Download className="w-5 h-5" style={{ color: theme.colors.accent }} />
				<div className="flex-1">
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Check for Updates
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Get the latest version
					</div>
				</div>
			</button>
			<button
				onClick={() => {
					window.maestro.shell.openExternal('https://runmaestro.ai');
					setMenuOpen(false);
				}}
				className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
			>
				<Globe className="w-5 h-5" style={{ color: theme.colors.accent }} />
				<div className="flex-1">
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Maestro Website
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Visit runmaestro.ai
					</div>
				</div>
				<ExternalLink className="w-4 h-4" style={{ color: theme.colors.textDim }} />
			</button>
			<button
				onClick={() => {
					window.maestro.shell.openExternal('https://docs.runmaestro.ai');
					setMenuOpen(false);
				}}
				className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
			>
				<BookOpen className="w-5 h-5" style={{ color: theme.colors.accent }} />
				<div className="flex-1">
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Documentation
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						See usage docs on docs.runmaestro.ai
					</div>
				</div>
				<ExternalLink className="w-4 h-4" style={{ color: theme.colors.textDim }} />
			</button>
			<button
				onClick={() => {
					setAboutModalOpen(true);
					setMenuOpen(false);
				}}
				className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
			>
				<Info className="w-5 h-5" style={{ color: theme.colors.accent }} />
				<div className="flex-1">
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						About Maestro
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Version, Credits, Stats
					</div>
				</div>
			</button>
		</div>
	);
}

// ============================================================================
// SessionTooltipContent - Shared tooltip content for session hover previews
// PERF: Memoized to prevent re-renders when parent list re-renders
// ============================================================================

interface SessionTooltipContentProps {
	session: Session;
	theme: Theme;
	gitFileCount?: number;
	groupName?: string; // Optional group name (for skinny mode)
	isInBatch?: boolean; // Whether session is running in auto mode
}

const SessionTooltipContent = memo(function SessionTooltipContent({
	session,
	theme,
	gitFileCount,
	groupName,
	isInBatch = false,
}: SessionTooltipContentProps) {
	return (
		<>
			{groupName && (
				<div
					className="text-[10px] font-bold uppercase mb-1"
					style={{ color: theme.colors.textDim }}
				>
					{groupName}
				</div>
			)}
			<div className="flex items-center gap-2 mb-2">
				<span className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
					{session.name}
				</span>
				{/* Location Indicator Pills */}
				{session.toolType !== 'terminal' && (
					<>
						{/* SSH connection failure badge - red server icon (shown for any remote session with failed connection) */}
						{/* For git repos, this shows alongside GIT badge; for non-git, this replaces REMOTE badge */}
						{session.sessionSshRemoteConfig?.enabled && session.sshConnectionFailed && (
							<span
								className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold"
								style={{
									backgroundColor: theme.colors.error + '30',
									color: theme.colors.error,
								}}
								title="SSH connection failed"
							>
								<Server className="w-3 h-3" />
								{/* Show REMOTE text only for non-git sessions (git sessions show GIT badge separately) */}
								{!(session.isGitRepo || session.worktreeBranch) && (
									<span className="uppercase">REMOTE</span>
								)}
							</span>
						)}
						{/* Worktree children are always git repos; also check isGitRepo for regular sessions */}
						{session.isGitRepo || session.worktreeBranch ? (
							/* Git repo: Show server icon pill (if remote & connected) + GIT pill */
							<>
								{/* Server icon for remote git repos - only when connected (failure shows red server above) */}
								{session.sessionSshRemoteConfig?.enabled && !session.sshConnectionFailed && (
									<span
										className="flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold"
										style={{
											backgroundColor: theme.colors.success + '30',
											color: theme.colors.success,
										}}
										title="Remote SSH"
									>
										<Server className="w-3 h-3" />
									</span>
								)}
								<span
									className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
									style={{
										backgroundColor: theme.colors.accent + '30',
										color: theme.colors.accent,
									}}
								>
									GIT
								</span>
							</>
						) : /* Plain directory: Show REMOTE (with server icon if failed) or LOCAL */
						session.sessionSshRemoteConfig?.enabled ? (
							/* Remote non-git: show REMOTE badge (red if failed, orange if connected) */
							/* Note: failure server icon already shown above */
							!session.sshConnectionFailed && (
								<span
									className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
									style={{
										backgroundColor: theme.colors.warning + '30',
										color: theme.colors.warning,
									}}
								>
									REMOTE
								</span>
							)
						) : (
							/* Local non-git: show LOCAL badge */
							<span
								className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
								style={{
									backgroundColor: theme.colors.textDim + '20',
									color: theme.colors.textDim,
								}}
							>
								LOCAL
							</span>
						)}
					</>
				)}
				{/* AUTO Mode Indicator */}
				{isInBatch && (
					<span
						className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase animate-pulse"
						style={{
							backgroundColor: theme.colors.warning + '30',
							color: theme.colors.warning,
						}}
					>
						<Bot className="w-2.5 h-2.5" />
						AUTO
					</span>
				)}
			</div>
			<div className="text-[10px] capitalize mb-2" style={{ color: theme.colors.textDim }}>
				{session.state} • {session.toolType}
				{session.sessionSshRemoteConfig?.enabled ? ' (SSH)' : ''}
			</div>

			<div
				className="pt-2 mt-2 space-y-1.5"
				style={{ borderTop: `1px solid ${theme.colors.border}` }}
			>
				<div className="flex items-center justify-between text-[10px]">
					<span style={{ color: theme.colors.textDim }}>Context Window</span>
					<span style={{ color: theme.colors.textMain }}>{session.contextUsage}%</span>
				</div>
				<div
					className="w-full h-1 rounded-full overflow-hidden"
					style={{ backgroundColor: theme.colors.border }}
				>
					<div
						className="h-full transition-all"
						style={{
							width: `${session.contextUsage}%`,
							backgroundColor: getContextColor(session.contextUsage, theme),
						}}
					/>
				</div>

				{/* Git Status */}
				{session.isGitRepo && gitFileCount !== undefined && gitFileCount > 0 && (
					<div className="flex items-center justify-between text-[10px] pt-1">
						<span className="flex items-center gap-1" style={{ color: theme.colors.textDim }}>
							<GitBranch className="w-3 h-3" />
							Git Changes
						</span>
						<span style={{ color: theme.colors.warning }}>{gitFileCount} files</span>
					</div>
				)}

				{/* Session Cost */}
				{session.usageStats && session.usageStats.totalCostUsd > 0 && (
					<div className="flex items-center justify-between text-[10px] pt-1">
						<span style={{ color: theme.colors.textDim }}>Session Cost</span>
						<span className="font-mono font-bold" style={{ color: theme.colors.success }}>
							${session.usageStats.totalCostUsd.toFixed(2)}
						</span>
					</div>
				)}

				{/* Active Time */}
				{session.activeTimeMs > 0 && (
					<div className="flex items-center justify-between text-[10px] pt-1">
						<span className="flex items-center gap-1" style={{ color: theme.colors.textDim }}>
							<Clock className="w-3 h-3" />
							Active Time
						</span>
						<span className="font-mono font-bold" style={{ color: theme.colors.accent }}>
							{formatActiveTime(session.activeTimeMs)}
						</span>
					</div>
				)}

				<div
					className="flex items-center gap-1.5 text-[10px] font-mono pt-1"
					style={{ color: theme.colors.textDim }}
				>
					<Folder className="w-3 h-3 shrink-0" />
					<span className="truncate">{session.cwd}</span>
				</div>
			</div>
		</>
	);
});

// Pre-compiled emoji regex for better performance (compiled once at module load)
// Matches common emoji patterns at the start of the string including:
// - Basic emojis (😀, 🎉, etc.)
// - Emojis with skin tone modifiers
// - Flag emojis
// - ZWJ sequences (👨‍👩‍👧, etc.)
const LEADING_EMOJI_REGEX =
	/^(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F?|\p{Emoji_Modifier_Base}\p{Emoji_Modifier}?)+\s*/u;

// Strip leading emojis from a string for alphabetical sorting
const stripLeadingEmojis = (str: string): string => {
	return str.replace(LEADING_EMOJI_REGEX, '').trim();
};

// Compare two session names, ignoring leading emojis for alphabetization
const compareSessionNames = (a: string, b: string): number => {
	const aStripped = stripLeadingEmojis(a);
	const bStripped = stripLeadingEmojis(b);
	return aStripped.localeCompare(bStripped);
};

interface SessionListProps {
	// State
	theme: Theme;
	sessions: Session[];
	groups: Group[];
	sortedSessions: Session[];
	activeSessionId: string;
	leftSidebarOpen: boolean;
	leftSidebarWidthState: number;
	activeFocus: string;
	selectedSidebarIndex: number;
	editingGroupId: string | null;
	editingSessionId: string | null;
	draggingSessionId: string | null;
	shortcuts: Record<string, Shortcut>;

	// Global Live Mode
	isLiveMode: boolean;
	webInterfaceUrl: string | null;
	toggleGlobalLive: () => void;

	// Web Interface Port Settings
	webInterfaceUseCustomPort: boolean;
	setWebInterfaceUseCustomPort: (value: boolean) => void;
	webInterfaceCustomPort: number;
	setWebInterfaceCustomPort: (value: number) => void;
	restartWebServer: () => Promise<string | null>;

	// Bookmarks folder state (lifted from component to App.tsx for keyboard shortcut access)
	bookmarksCollapsed: boolean;
	setBookmarksCollapsed: (collapsed: boolean) => void;

	// Ungrouped folder state (persisted via useSettings)
	ungroupedCollapsed: boolean;
	setUngroupedCollapsed: (collapsed: boolean) => void;

	// Handlers
	setActiveFocus: (focus: FocusArea) => void;
	setActiveSessionId: (id: string) => void;
	setLeftSidebarOpen: (open: boolean) => void;
	setLeftSidebarWidthState: (width: number) => void;
	setShortcutsHelpOpen: (open: boolean) => void;
	setSettingsModalOpen: (open: boolean) => void;
	setSettingsTab: (tab: SettingsTab) => void;
	setAboutModalOpen: (open: boolean) => void;
	setUpdateCheckModalOpen: (open: boolean) => void;
	setLogViewerOpen: (open: boolean) => void;
	setProcessMonitorOpen: (open: boolean) => void;
	setUsageDashboardOpen: (open: boolean) => void;
	toggleGroup: (groupId: string) => void;
	handleDragStart: (sessionId: string) => void;
	handleDragOver: (e: React.DragEvent) => void;
	handleDropOnGroup: (groupId: string) => void;
	handleDropOnUngrouped: () => void;
	finishRenamingGroup: (groupId: string, newName: string) => void;
	finishRenamingSession: (sessId: string, newName: string) => void;
	startRenamingGroup: (groupId: string) => void;
	startRenamingSession: (sessId: string) => void;
	showConfirmation: (message: string, onConfirm: () => void) => void;
	setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	createNewGroup: () => void;
	onCreateGroupAndMove?: (sessionId: string) => void; // Create new group and move session to it
	addNewSession: () => void;
	onDeleteSession?: (id: string) => void;
	onDeleteWorktreeGroup?: (groupId: string) => void;

	// Rename modal handlers (for context menu rename)
	setRenameInstanceModalOpen: (open: boolean) => void;
	setRenameInstanceValue: (value: string) => void;
	setRenameInstanceSessionId: (id: string) => void;

	// Edit agent modal handler (for context menu edit)
	onEditAgent: (session: Session) => void;

	// Duplicate agent handlers (for context menu duplicate)
	onNewAgentSession: () => void;
	setDuplicatingSessionId: (id: string | null) => void;

	// Worktree handlers
	onToggleWorktreeExpanded?: (sessionId: string) => void;
	onOpenCreatePR?: (session: Session) => void;
	onQuickCreateWorktree?: (session: Session) => void;
	onOpenWorktreeConfig?: (session: Session) => void;
	onDeleteWorktree?: (session: Session) => void;

	// Auto mode props
	activeBatchSessionIds?: string[]; // Session IDs that are running in auto mode

	// Session jump shortcut props (Opt+Cmd+NUMBER)
	showSessionJumpNumbers?: boolean;
	visibleSessions?: Session[];

	// Achievement system props
	autoRunStats?: AutoRunStats;

	// Wizard props
	openWizard?: () => void;

	// Tour props
	startTour?: () => void;

	// Ref for the sidebar container (for focus management)
	sidebarContainerRef?: React.RefObject<HTMLDivElement>;

	// Group Chat props
	groupChats?: GroupChat[];
	activeGroupChatId?: string | null;
	onOpenGroupChat?: (id: string) => void;
	onNewGroupChat?: () => void;
	onEditGroupChat?: (id: string) => void;
	onRenameGroupChat?: (id: string) => void;
	onDeleteGroupChat?: (id: string) => void;
	/** Controlled expanded state for group chats (lifted to parent for keyboard navigation) */
	groupChatsExpanded?: boolean;
	/** Callback when group chats expanded state changes */
	onGroupChatsExpandedChange?: (expanded: boolean) => void;
	/** Current state of the active group chat (for status indicator) */
	groupChatState?: GroupChatState;
	/** Per-participant working states for the active group chat */
	participantStates?: Map<string, 'idle' | 'working'>;
	/** State for ALL group chats (groupChatId -> state), for showing busy indicator when not active */
	groupChatStates?: Map<string, GroupChatState>;
	/** Participant states for ALL group chats (groupChatId -> Map<participantName, state>) */
	allGroupChatParticipantStates?: Map<string, Map<string, 'idle' | 'working'>>;
}

function SessionListInner(props: SessionListProps) {
	const {
		theme,
		sessions,
		groups,
		sortedSessions,
		activeSessionId,
		leftSidebarOpen,
		leftSidebarWidthState,
		activeFocus,
		selectedSidebarIndex,
		editingGroupId,
		editingSessionId,
		draggingSessionId,
		shortcuts,
		isLiveMode,
		webInterfaceUrl,
		toggleGlobalLive,
		webInterfaceUseCustomPort,
		setWebInterfaceUseCustomPort,
		webInterfaceCustomPort,
		setWebInterfaceCustomPort,
		restartWebServer,
		bookmarksCollapsed,
		setBookmarksCollapsed,
		ungroupedCollapsed,
		setUngroupedCollapsed,
		setActiveFocus,
		setActiveSessionId,
		setLeftSidebarOpen,
		setLeftSidebarWidthState,
		setShortcutsHelpOpen,
		setSettingsModalOpen,
		setSettingsTab,
		setAboutModalOpen,
		setUpdateCheckModalOpen,
		setLogViewerOpen,
		setProcessMonitorOpen,
		setUsageDashboardOpen,
		toggleGroup,
		handleDragStart,
		handleDragOver,
		handleDropOnGroup,
		handleDropOnUngrouped,
		finishRenamingGroup,
		finishRenamingSession,
		startRenamingGroup,
		startRenamingSession,
		showConfirmation,
		setGroups,
		setSessions,
		createNewGroup,
		onCreateGroupAndMove,
		addNewSession,
		onDeleteSession,
		onDeleteWorktreeGroup,
		setRenameInstanceModalOpen,
		setRenameInstanceValue,
		setRenameInstanceSessionId,
		onEditAgent,
		onNewAgentSession,
		setDuplicatingSessionId,
		onToggleWorktreeExpanded,
		onOpenCreatePR,
		onQuickCreateWorktree,
		onOpenWorktreeConfig,
		onDeleteWorktree,
		activeBatchSessionIds = [],
		showSessionJumpNumbers = false,
		visibleSessions = [],
		autoRunStats,
		openWizard,
		startTour,
		sidebarContainerRef,
		// Group Chat props
		groupChats = [],
		activeGroupChatId = null,
		onOpenGroupChat,
		onNewGroupChat,
		onEditGroupChat,
		onRenameGroupChat,
		onDeleteGroupChat,
		groupChatsExpanded,
		onGroupChatsExpandedChange,
		groupChatState = 'idle',
		participantStates,
		groupChatStates,
		allGroupChatParticipantStates,
	} = props;

	const [sessionFilter, setSessionFilter] = useState('');
	const [sessionFilterOpen, setSessionFilterOpen] = useState(false);
	const [preFilterGroupStates, setPreFilterGroupStates] = useState<Map<string, boolean>>(new Map());
	const [preFilterBookmarksCollapsed, setPreFilterBookmarksCollapsed] = useState<boolean | null>(
		null
	);
	// Remember user's preferred states while in filter mode (persists across filter open/close within session)
	const [filterModeGroupStates, setFilterModeGroupStates] = useState<Map<string, boolean> | null>(
		null
	);
	const [filterModeBookmarksCollapsed, setFilterModeBookmarksCollapsed] = useState<boolean | null>(
		null
	);
	const [filterModeInitialized, setFilterModeInitialized] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);

	// Live overlay state (extracted hook)
	const {
		liveOverlayOpen,
		setLiveOverlayOpen,
		liveOverlayRef,
		cloudflaredInstalled,
		cloudflaredChecked: _cloudflaredChecked,
		tunnelStatus,
		tunnelUrl,
		tunnelError,
		activeUrlTab,
		setActiveUrlTab,
		copyFlash,
		setCopyFlash,
		handleTunnelToggle,
	} = useLiveOverlay(isLiveMode);

	// Context menu state
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		sessionId: string;
	} | null>(null);
	const contextMenuSession = contextMenu
		? sessions.find((s) => s.id === contextMenu.sessionId)
		: null;
	const [tooltipPosition, setTooltipPosition] = useState<{ x: number; y: number } | null>(null);
	const menuRef = useRef<HTMLDivElement>(null);

	// Toggle bookmark for a session - memoized to prevent SessionItem re-renders
	const toggleBookmark = useCallback(
		(sessionId: string) => {
			setSessions((prev) =>
				prev.map((s) => (s.id === sessionId ? { ...s, bookmarked: !s.bookmarked } : s))
			);
		},
		[setSessions]
	);

	// Context menu handlers - memoized to prevent SessionItem re-renders
	const handleContextMenu = useCallback((e: React.MouseEvent, sessionId: string) => {
		e.preventDefault();
		e.stopPropagation();
		setContextMenu({ x: e.clientX, y: e.clientY, sessionId });
	}, []);

	const handleMoveToGroup = useCallback(
		(sessionId: string, groupId: string) => {
			setSessions((prev) =>
				prev.map((s) => (s.id === sessionId ? { ...s, groupId: groupId || undefined } : s))
			);
		},
		[setSessions]
	);

	const handleDeleteSession = (sessionId: string) => {
		// Use the parent's delete handler if provided (includes proper cleanup)
		if (onDeleteSession) {
			onDeleteSession(sessionId);
			return;
		}
		// Fallback to local delete logic
		const session = sessions.find((s) => s.id === sessionId);
		if (!session) return;
		showConfirmation(
			`Are you sure you want to remove "${session.name}"? This action cannot be undone.`,
			() => {
				const newSessions = sessions.filter((s) => s.id !== sessionId);
				setSessions(newSessions);
				// If deleting the active session, switch to another one
				if (activeSessionId === sessionId && newSessions.length > 0) {
					setActiveSessionId(newSessions[0].id);
				}
			}
		);
	};

	// Close menu when clicking outside
	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				setMenuOpen(false);
			}
		};
		if (menuOpen) {
			document.addEventListener('mousedown', handleClickOutside);
			return () => document.removeEventListener('mousedown', handleClickOutside);
		}
	}, [menuOpen]);

	// Close overlays/menus with Escape key
	useEffect(() => {
		const handleEscKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				if (liveOverlayOpen) {
					setLiveOverlayOpen(false);
					e.stopPropagation();
				} else if (menuOpen) {
					setMenuOpen(false);
					e.stopPropagation();
				}
			}
		};
		if (liveOverlayOpen || menuOpen) {
			document.addEventListener('keydown', handleEscKey);
			return () => document.removeEventListener('keydown', handleEscKey);
		}
	}, [liveOverlayOpen, menuOpen]);

	// Listen for tour UI actions to control hamburger menu state
	useEffect(() => {
		const handleTourAction = (event: Event) => {
			const customEvent = event as CustomEvent<{ type: string; value?: string }>;
			const { type } = customEvent.detail;

			switch (type) {
				case 'openHamburgerMenu':
					setMenuOpen(true);
					break;
				case 'closeHamburgerMenu':
					setMenuOpen(false);
					break;
				default:
					break;
			}
		};

		window.addEventListener('tour:action', handleTourAction);
		return () => window.removeEventListener('tour:action', handleTourAction);
	}, []);

	// Get git file change counts per session from focused context
	// Using useGitFileStatus instead of full useGitStatus reduces re-renders
	// when only branch data changes (we only need file counts here)
	const { getFileCount } = useGitFileStatus();

	const worktreeChildrenByParentId = useMemo(() => {
		const map = new Map<string, Session[]>();
		sessions.forEach((session) => {
			if (!session.parentSessionId) return;
			const siblings = map.get(session.parentSessionId);
			if (siblings) {
				siblings.push(session);
			} else {
				map.set(session.parentSessionId, [session]);
			}
		});
		return map;
	}, [sessions]);

	const sortedWorktreeChildrenByParentId = useMemo(() => {
		const map = new Map<string, Session[]>();
		worktreeChildrenByParentId.forEach((children, parentId) => {
			map.set(
				parentId,
				[...children].sort((a, b) => compareSessionNames(a.name, b.name))
			);
		});
		return map;
	}, [worktreeChildrenByParentId]);

	const sortedSessionIndexById = useMemo(() => {
		const map = new Map<string, number>();
		sortedSessions.forEach((session, index) => {
			map.set(session.id, index);
		});
		return map;
	}, [sortedSessions]);

	// Helper: Get worktree children for a parent session
	const getWorktreeChildren = (parentId: string): Session[] => {
		return worktreeChildrenByParentId.get(parentId) || [];
	};

	// Helper: Check if a session has worktree children
	const _hasWorktreeChildren = (sessionId: string): boolean => {
		return worktreeChildrenByParentId.has(sessionId);
	};

	// Helper component: Renders a collapsed session pill with subdivided parts for worktrees
	const renderCollapsedPill = (session: Session, keyPrefix: string, _onExpand: () => void) => {
		const worktreeChildren = getWorktreeChildren(session.id);
		const allSessions = [session, ...worktreeChildren];
		const hasWorktrees = worktreeChildren.length > 0;

		// Single pill container that takes flex-1 space
		return (
			<div
				key={`${keyPrefix}-${session.id}`}
				className="relative flex-1 flex rounded-full overflow-hidden opacity-50 hover:opacity-100 transition-opacity"
				style={{ gap: hasWorktrees ? '1px' : 0 }}
			>
				{allSessions.map((s, idx) => {
					const hasUnreadTabs = s.aiTabs?.some((tab) => tab.hasUnread);
					const isFirst = idx === 0;
					const isLast = idx === allSessions.length - 1;
					const isInBatch = activeBatchSessionIds.includes(s.id);

					return (
						<div
							key={`${keyPrefix}-part-${s.id}`}
							className={`group/segment relative flex-1 h-full ${isInBatch ? 'animate-pulse' : ''}`}
							style={{
								...(s.toolType === 'claude' && !s.agentSessionId && !isInBatch
									? { border: `1px solid ${theme.colors.textDim}`, backgroundColor: 'transparent' }
									: {
											backgroundColor: isInBatch
												? theme.colors.warning
												: getStatusColor(s.state, theme),
										}),
								// Rounded ends only on first/last
								borderRadius: hasWorktrees
									? `${isFirst ? '9999px' : '0'} ${isLast ? '9999px' : '0'} ${isLast ? '9999px' : '0'} ${isFirst ? '9999px' : '0'}`
									: '9999px',
							}}
							onMouseEnter={(e) => setTooltipPosition({ x: e.clientX, y: e.clientY })}
							onMouseLeave={() => setTooltipPosition(null)}
							onClick={(e) => {
								e.stopPropagation();
								setActiveSessionId(s.id);
							}}
						>
							{/* Unread indicator - only on last segment */}
							{hasUnreadTabs && isLast && (
								<div
									className="absolute -right-0.5 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full"
									style={{ backgroundColor: theme.colors.error }}
								/>
							)}
							{/* Hover Tooltip - per segment */}
							<div
								className="fixed rounded px-3 py-2 z-[100] opacity-0 group-hover/segment:opacity-100 pointer-events-none transition-opacity shadow-xl"
								style={{
									minWidth: '240px',
									left: `${leftSidebarWidthState + 8}px`,
									top: tooltipPosition ? `${tooltipPosition.y}px` : undefined,
									backgroundColor: theme.colors.bgSidebar,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								<SessionTooltipContent
									session={s}
									theme={theme}
									gitFileCount={getFileCount(s.id)}
									isInBatch={isInBatch}
								/>
							</div>
						</div>
					);
				})}
			</div>
		);
	};

	// PERF: Cached callback maps to prevent SessionItem re-renders
	// These Maps store stable function references keyed by session/editing ID
	// The callbacks themselves are memoized, so the Map values remain stable
	const selectHandlers = useMemo(() => {
		const map = new Map<string, () => void>();
		sessions.forEach((s) => {
			map.set(s.id, () => setActiveSessionId(s.id));
		});
		return map;
	}, [sessions, setActiveSessionId]);

	const dragStartHandlers = useMemo(() => {
		const map = new Map<string, () => void>();
		sessions.forEach((s) => {
			map.set(s.id, () => handleDragStart(s.id));
		});
		return map;
	}, [sessions, handleDragStart]);

	const contextMenuHandlers = useMemo(() => {
		const map = new Map<string, (e: React.MouseEvent) => void>();
		sessions.forEach((s) => {
			map.set(s.id, (e: React.MouseEvent) => handleContextMenu(e, s.id));
		});
		return map;
	}, [sessions, handleContextMenu]);

	const finishRenameHandlers = useMemo(() => {
		const map = new Map<string, (newName: string) => void>();
		sessions.forEach((s) => {
			map.set(s.id, (newName: string) => finishRenamingSession(s.id, newName));
		});
		return map;
	}, [sessions, finishRenamingSession]);

	const toggleBookmarkHandlers = useMemo(() => {
		const map = new Map<string, () => void>();
		sessions.forEach((s) => {
			map.set(s.id, () => toggleBookmark(s.id));
		});
		return map;
	}, [sessions, toggleBookmark]);

	// Helper component: Renders a session item with its worktree children (if any)
	const renderSessionWithWorktrees = (
		session: Session,
		variant: 'bookmark' | 'group' | 'flat' | 'ungrouped',
		options: {
			keyPrefix: string;
			groupId?: string;
			group?: Group;
			onDrop?: () => void;
		}
	) => {
		const worktreeChildren = getWorktreeChildren(session.id);
		const hasWorktrees = worktreeChildren.length > 0;
		const worktreesExpanded = session.worktreesExpanded ?? true;
		const globalIdx = sortedSessionIndexById.get(session.id) ?? -1;
		const isKeyboardSelected = activeFocus === 'sidebar' && globalIdx === selectedSidebarIndex;

		// In flat/ungrouped view, wrap sessions with worktrees in a left-bordered container
		// to visually associate parent and worktrees together (similar to grouped view)
		const needsWorktreeWrapper = hasWorktrees && (variant === 'flat' || variant === 'ungrouped');

		// When wrapped, use 'ungrouped' styling for flat sessions (no mx-3, consistent with grouped look)
		const effectiveVariant = needsWorktreeWrapper && variant === 'flat' ? 'ungrouped' : variant;

		const content = (
			<>
				{/* Parent session - no chevron, maintains alignment */}
				<SessionItem
					session={session}
					variant={effectiveVariant}
					theme={theme}
					isActive={activeSessionId === session.id && !activeGroupChatId}
					isKeyboardSelected={isKeyboardSelected}
					isDragging={draggingSessionId === session.id}
					isEditing={editingSessionId === `${options.keyPrefix}-${session.id}`}
					leftSidebarOpen={leftSidebarOpen}
					group={options.group}
					groupId={options.groupId}
					gitFileCount={getFileCount(session.id)}
					isInBatch={activeBatchSessionIds.includes(session.id)}
					jumpNumber={getSessionJumpNumber(session.id)}
					onSelect={selectHandlers.get(session.id)!}
					onDragStart={dragStartHandlers.get(session.id)!}
					onDragOver={handleDragOver}
					onDrop={options.onDrop || handleDropOnUngrouped}
					onContextMenu={contextMenuHandlers.get(session.id)!}
					onFinishRename={finishRenameHandlers.get(session.id)!}
					onStartRename={() => startRenamingSession(`${options.keyPrefix}-${session.id}`)}
					onToggleBookmark={toggleBookmarkHandlers.get(session.id)!}
				/>

				{/* Thin band below parent when worktrees exist but collapsed - click to expand */}
				{hasWorktrees && !worktreesExpanded && onToggleWorktreeExpanded && (
					<button
						onClick={(e) => {
							e.stopPropagation();
							onToggleWorktreeExpanded(session.id);
						}}
						className="w-full flex items-center justify-center gap-1.5 py-0.5 text-[9px] font-medium hover:opacity-80 transition-opacity cursor-pointer"
						style={{
							backgroundColor: theme.colors.accent + '15',
							color: theme.colors.accent,
						}}
						title={`${worktreeChildren.length} worktree${worktreeChildren.length > 1 ? 's' : ''} (click to expand)`}
					>
						<GitBranch className="w-2.5 h-2.5" />
						<span>
							{worktreeChildren.length} worktree{worktreeChildren.length > 1 ? 's' : ''}
						</span>
						<ChevronDown className="w-2.5 h-2.5" />
					</button>
				)}

				{/* Worktree children drawer (when expanded) */}
				{hasWorktrees && worktreesExpanded && onToggleWorktreeExpanded && (
					<div
						className={`rounded-bl overflow-hidden ${needsWorktreeWrapper ? '' : 'ml-1'}`}
						style={{
							backgroundColor: theme.colors.accent + '10',
							borderLeft: needsWorktreeWrapper ? 'none' : `1px solid ${theme.colors.accent}30`,
							borderBottom: `1px solid ${theme.colors.accent}30`,
						}}
					>
						{/* Worktree children list */}
						<div>
							{(sortedWorktreeChildrenByParentId.get(session.id) || []).map((child) => {
								const childGlobalIdx = sortedSessionIndexById.get(child.id) ?? -1;
								const isChildKeyboardSelected =
									activeFocus === 'sidebar' && childGlobalIdx === selectedSidebarIndex;
								return (
									<SessionItem
										key={`worktree-${session.id}-${child.id}`}
										session={child}
										variant="worktree"
										theme={theme}
										isActive={activeSessionId === child.id && !activeGroupChatId}
										isKeyboardSelected={isChildKeyboardSelected}
										isDragging={draggingSessionId === child.id}
										isEditing={editingSessionId === `worktree-${session.id}-${child.id}`}
										leftSidebarOpen={leftSidebarOpen}
										gitFileCount={getFileCount(child.id)}
										isInBatch={activeBatchSessionIds.includes(child.id)}
										jumpNumber={getSessionJumpNumber(child.id)}
										onSelect={selectHandlers.get(child.id)!}
										onDragStart={dragStartHandlers.get(child.id)!}
										onContextMenu={contextMenuHandlers.get(child.id)!}
										onFinishRename={finishRenameHandlers.get(child.id)!}
										onStartRename={() => startRenamingSession(`worktree-${session.id}-${child.id}`)}
										onToggleBookmark={toggleBookmarkHandlers.get(child.id)!}
									/>
								);
							})}
						</div>
						{/* Drawer handle at bottom - click to collapse */}
						<button
							onClick={(e) => {
								e.stopPropagation();
								onToggleWorktreeExpanded(session.id);
							}}
							className="w-full flex items-center justify-center gap-1.5 py-0.5 text-[9px] font-medium hover:opacity-80 transition-opacity cursor-pointer"
							style={{
								backgroundColor: theme.colors.accent + '20',
								color: theme.colors.accent,
							}}
							title="Click to collapse worktrees"
						>
							<GitBranch className="w-2.5 h-2.5" />
							<span>
								{worktreeChildren.length} worktree{worktreeChildren.length > 1 ? 's' : ''}
							</span>
							<ChevronUp className="w-2.5 h-2.5" />
						</button>
					</div>
				)}
			</>
		);

		// Wrap in left-bordered container for flat/ungrouped sessions with worktrees
		// Use ml-3 to align left edge, mr-3 minus the extra px-1 from ungrouped (px-4 vs px-3)
		if (needsWorktreeWrapper) {
			return (
				<div
					key={`${options.keyPrefix}-${session.id}`}
					className="border-l ml-3 mr-2 mb-1"
					style={{ borderColor: theme.colors.accent + '50' }}
				>
					{content}
				</div>
			);
		}

		return <div key={`${options.keyPrefix}-${session.id}`}>{content}</div>;
	};

	// Consolidated session categorization and sorting - computed in a single pass
	// This replaces 12+ chained useMemo calls with one comprehensive computation
	const sessionCategories = useMemo(() => {
		// Step 1: Filter sessions based on search query
		const query = sessionFilter?.toLowerCase() ?? '';
		const filtered: Session[] = [];

		for (const s of sessions) {
			// Exclude worktree children from main list (they appear under parent)
			if (s.parentSessionId) continue;

			if (!query) {
				filtered.push(s);
			} else {
				// Match session name
				if (s.name.toLowerCase().includes(query)) {
					filtered.push(s);
					continue;
				}
				// Match any AI tab name
				if (s.aiTabs?.some((tab) => tab.name?.toLowerCase().includes(query))) {
					filtered.push(s);
					continue;
				}
				// Match worktree children branch names
				const worktreeChildren = worktreeChildrenByParentId.get(s.id);
				if (
					worktreeChildren?.some(
						(child) =>
							child.worktreeBranch?.toLowerCase().includes(query) ||
							child.name.toLowerCase().includes(query)
					)
				) {
					filtered.push(s);
				}
			}
		}

		// Step 2: Categorize sessions in a single pass
		const bookmarked: Session[] = [];
		const ungrouped: Session[] = [];
		const groupedMap = new Map<string, Session[]>();

		for (const s of filtered) {
			if (s.bookmarked) {
				bookmarked.push(s);
			}
			if (s.groupId) {
				const list = groupedMap.get(s.groupId);
				if (list) {
					list.push(s);
				} else {
					groupedMap.set(s.groupId, [s]);
				}
			} else {
				ungrouped.push(s);
			}
		}

		// Step 3: Sort each category once
		const sortFn = (a: Session, b: Session) => compareSessionNames(a.name, b.name);

		const sortedFiltered = [...filtered].sort(sortFn);
		const sortedBookmarked = [...bookmarked].sort(sortFn);
		const sortedBookmarkedParent = bookmarked.filter((s) => !s.parentSessionId).sort(sortFn);
		const sortedUngrouped = [...ungrouped].sort(sortFn);
		const sortedUngroupedParent = ungrouped.filter((s) => !s.parentSessionId).sort(sortFn);

		// Sort sessions within each group
		const sortedGrouped = new Map<string, Session[]>();
		groupedMap.forEach((groupSessions, groupId) => {
			sortedGrouped.set(groupId, [...groupSessions].sort(sortFn));
		});

		return {
			filtered,
			bookmarked,
			ungrouped,
			groupedMap,
			sortedFiltered,
			sortedBookmarked,
			sortedBookmarkedParent,
			sortedUngrouped,
			sortedUngroupedParent,
			sortedGrouped,
		};
	}, [sessionFilter, sessions, worktreeChildrenByParentId]);

	// Destructure for backwards compatibility with existing code
	const filteredSessions = sessionCategories.filtered;
	const bookmarkedSessions = sessionCategories.bookmarked;
	const bookmarkedParentSessions = sessionCategories.sortedBookmarkedParent;
	const sortedBookmarkedSessions = sessionCategories.sortedBookmarked;
	const sortedBookmarkedParentSessions = sessionCategories.sortedBookmarkedParent;
	const groupedSessionsById = sessionCategories.groupedMap;
	const sortedGroupSessionsById = sessionCategories.sortedGrouped;
	const ungroupedSessions = sessionCategories.ungrouped;
	const ungroupedParentSessions = sessionCategories.sortedUngroupedParent;
	const sortedUngroupedSessions = sessionCategories.sortedUngrouped;
	const sortedUngroupedParentSessions = sessionCategories.sortedUngroupedParent;
	const sortedFilteredSessions = sessionCategories.sortedFiltered;

	const sortedGroups = useMemo(
		() => [...groups].sort((a, b) => compareSessionNames(a.name, b.name)),
		[groups]
	);

	// When filter opens, apply filter mode preferences (or defaults on first open)
	// When filter closes, save current states as filter mode preferences and restore original states
	useEffect(() => {
		if (sessionFilterOpen) {
			// Save current (non-filter) states when filter opens
			if (preFilterGroupStates.size === 0) {
				const currentStates = new Map<string, boolean>();
				groups.forEach((g) => currentStates.set(g.id, g.collapsed));
				setPreFilterGroupStates(currentStates);
			}
			if (preFilterBookmarksCollapsed === null) {
				setPreFilterBookmarksCollapsed(bookmarksCollapsed);
			}

			// Apply filter mode preferences if we have them, otherwise use defaults
			if (filterModeInitialized && filterModeGroupStates) {
				// Restore user's preferred filter mode states
				setGroups((prev) =>
					prev.map((g) => ({
						...g,
						collapsed: filterModeGroupStates.get(g.id) ?? true,
					}))
				);
				setBookmarksCollapsed(filterModeBookmarksCollapsed ?? false);
			} else {
				// First time opening filter - use defaults: collapse all groups, expand bookmarks
				setGroups((prev) => prev.map((g) => ({ ...g, collapsed: true })));
				setBookmarksCollapsed(false);
				setFilterModeInitialized(true);
			}
		} else {
			// Filter closing - save current states as filter mode preferences
			if (preFilterGroupStates.size > 0) {
				const currentFilterStates = new Map<string, boolean>();
				groups.forEach((g) => currentFilterStates.set(g.id, g.collapsed));
				setFilterModeGroupStates(currentFilterStates);
				setFilterModeBookmarksCollapsed(bookmarksCollapsed);

				// Restore original (non-filter) states
				setGroups((prev) =>
					prev.map((g) => ({
						...g,
						collapsed: preFilterGroupStates.get(g.id) ?? g.collapsed,
					}))
				);
				setPreFilterGroupStates(new Map());
			}
			if (preFilterBookmarksCollapsed !== null) {
				setBookmarksCollapsed(preFilterBookmarksCollapsed);
				setPreFilterBookmarksCollapsed(null);
			}
		}
	}, [sessionFilterOpen]);

	// Temporarily expand groups when filtering to show matching sessions
	// Note: Only depend on sessionFilter and sessions (not filteredSessions which changes reference each render)
	useEffect(() => {
		if (sessionFilter) {
			// Find groups that contain matching sessions (search session name AND AI tab names)
			const groupsWithMatches = new Set<string>();
			const query = sessionFilter.toLowerCase();
			const matchingSessions = sessions.filter((s) => {
				if (s.name.toLowerCase().includes(query)) return true;
				if (s.aiTabs?.some((tab) => tab.name?.toLowerCase().includes(query))) return true;
				return false;
			});

			matchingSessions.forEach((session) => {
				if (session.groupId) {
					groupsWithMatches.add(session.groupId);
				}
			});

			// Check if any matching sessions are bookmarked
			const hasMatchingBookmarks = matchingSessions.some((s) => s.bookmarked);

			// Temporarily expand groups with matches
			setGroups((prev) =>
				prev.map((g) => ({
					...g,
					collapsed: groupsWithMatches.has(g.id) ? false : g.collapsed,
				}))
			);

			// Temporarily expand bookmarks if there are matching bookmarked sessions
			if (hasMatchingBookmarks) {
				setBookmarksCollapsed(false);
			}
		} else if (sessionFilterOpen) {
			// Filter cleared but filter input still open - collapse groups again, keep bookmarks expanded
			setGroups((prev) => prev.map((g) => ({ ...g, collapsed: true })));
			setBookmarksCollapsed(false);
		}
	}, [sessionFilter]);

	// Get the jump number (1-9, 0=10th) for a session based on its position in visibleSessions
	const getSessionJumpNumber = (sessionId: string): string | null => {
		if (!showSessionJumpNumbers) return null;
		const index = visibleSessions.findIndex((s) => s.id === sessionId);
		if (index < 0 || index >= 10) return null;
		// Show 1-9 for positions 0-8, and 0 for position 9 (10th session)
		return index === 9 ? '0' : String(index + 1);
	};

	return (
		<div
			ref={sidebarContainerRef}
			tabIndex={0}
			className={`border-r flex flex-col shrink-0 transition-all duration-300 outline-none relative z-20 ${activeFocus === 'sidebar' && !activeGroupChatId ? 'ring-1 ring-inset' : ''}`}
			style={
				{
					width: leftSidebarOpen ? `${leftSidebarWidthState}px` : '64px',
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
					'--tw-ring-color': theme.colors.accent,
				} as React.CSSProperties
			}
			onClick={() => setActiveFocus('sidebar')}
			onFocus={() => setActiveFocus('sidebar')}
			onKeyDown={(e) => {
				// Open session filter with Cmd+F when sidebar has focus
				if (
					e.key === 'f' &&
					(e.metaKey || e.ctrlKey) &&
					activeFocus === 'sidebar' &&
					leftSidebarOpen &&
					!sessionFilterOpen
				) {
					e.preventDefault();
					setSessionFilterOpen(true);
				}
			}}
		>
			{/* Resize Handle */}
			{leftSidebarOpen && (
				<div
					className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-blue-500 transition-colors z-20"
					onMouseDown={(e) => {
						e.preventDefault();
						const startX = e.clientX;
						const startWidth = leftSidebarWidthState;
						let currentWidth = startWidth;

						const handleMouseMove = (e: MouseEvent) => {
							const delta = e.clientX - startX;
							currentWidth = Math.max(256, Math.min(600, startWidth + delta));
							// Direct DOM update during drag for performance (avoids ~60 re-renders/sec)
							if (sidebarContainerRef?.current) {
								sidebarContainerRef.current.style.width = `${currentWidth}px`;
							}
						};

						const handleMouseUp = () => {
							// Only update React state once on mouseup
							setLeftSidebarWidthState(currentWidth);
							window.maestro.settings.set('leftSidebarWidth', currentWidth);
							document.removeEventListener('mousemove', handleMouseMove);
							document.removeEventListener('mouseup', handleMouseUp);
						};

						document.addEventListener('mousemove', handleMouseMove);
						document.addEventListener('mouseup', handleMouseUp);
					}}
				/>
			)}

			{/* Branding Header */}
			<div
				className="p-4 border-b flex items-center justify-between h-16 shrink-0"
				style={{ borderColor: theme.colors.border }}
			>
				{leftSidebarOpen ? (
					<>
						<div className="flex items-center gap-2">
							<Wand2 className="w-5 h-5" style={{ color: theme.colors.accent }} />
							<h1
								className="font-bold tracking-widest text-lg"
								style={{ color: theme.colors.textMain }}
							>
								MAESTRO
							</h1>
							{/* Badge Level Indicator */}
							{autoRunStats && autoRunStats.currentBadgeLevel > 0 && (
								<button
									onClick={() => setAboutModalOpen(true)}
									className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold transition-colors hover:bg-white/10"
									title={`${getBadgeForTime(autoRunStats.cumulativeTimeMs)?.name || 'Apprentice'} - Click to view achievements`}
									style={{
										color: autoRunStats.currentBadgeLevel >= 8 ? '#FFD700' : theme.colors.accent,
									}}
								>
									<Trophy className="w-3 h-3" />
									<span>{autoRunStats.currentBadgeLevel}</span>
								</button>
							)}
							{/* Global LIVE Toggle */}
							<div className="ml-2 relative" ref={liveOverlayRef}>
								<button
									onClick={() => {
										if (!isLiveMode) {
											toggleGlobalLive();
											setLiveOverlayOpen(true);
										} else {
											setLiveOverlayOpen(!liveOverlayOpen);
										}
									}}
									className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold transition-colors ${
										isLiveMode
											? 'bg-green-500/20 text-green-500 hover:bg-green-500/30'
											: 'text-gray-500 hover:bg-white/10'
									}`}
									title={
										isLiveMode
											? 'Web interface active - Click to show URL'
											: 'Click to enable web interface'
									}
								>
									<Radio className={`w-3 h-3 ${isLiveMode ? 'animate-pulse' : ''}`} />
									{leftSidebarWidthState >=
										(autoRunStats && autoRunStats.currentBadgeLevel > 0 ? 295 : 256) &&
										(isLiveMode ? 'LIVE' : 'OFFLINE')}
								</button>

								{/* LIVE Overlay with URL and QR Code - Single QR with pill selector */}
								{isLiveMode && liveOverlayOpen && webInterfaceUrl && (
									<div
										className="absolute top-full left-0 pt-2 z-50 outline-none"
										style={{ width: '280px' }}
										tabIndex={-1}
										onKeyDown={(e) => {
											// Arrow key navigation between Local/Remote
											if (tunnelStatus === 'connected') {
												if (e.key === 'ArrowLeft') {
													setActiveUrlTab('local');
												} else if (e.key === 'ArrowRight') {
													setActiveUrlTab('remote');
												}
											}
										}}
									>
										<div
											className="rounded-lg shadow-2xl overflow-hidden"
											style={{
												backgroundColor: theme.colors.bgSidebar,
												border: `1px solid ${theme.colors.border}`,
											}}
										>
											{/* Description Header */}
											<div className="p-3 border-b" style={{ borderColor: theme.colors.border }}>
												<div
													className="text-[11px] leading-relaxed"
													style={{ color: theme.colors.textDim }}
												>
													Control your AI sessions from your phone or tablet.
													{tunnelStatus === 'connected' ? (
														<span className="text-blue-400">
															{' '}
															Remote tunnel active — access Maestro from anywhere, even outside your
															network.
														</span>
													) : (
														<span>
															{' '}
															Scan the QR code on your local network, or enable remote access to
															control Maestro from anywhere.
														</span>
													)}
												</div>
											</div>

											{/* Remote Access Toggle Section */}
											<div className="p-3 border-b" style={{ borderColor: theme.colors.border }}>
												<div className="flex items-center justify-between">
													<div>
														<div
															className="text-[10px] uppercase font-bold"
															style={{ color: theme.colors.textDim }}
														>
															Remote Access
														</div>
														{cloudflaredInstalled === false && (
															<div className="text-[9px] text-yellow-500 mt-1">
																Install cloudflared to enable
															</div>
														)}
													</div>

													{/* Toggle Switch */}
													<button
														onClick={handleTunnelToggle}
														disabled={!cloudflaredInstalled || tunnelStatus === 'starting'}
														className={`relative w-10 h-5 rounded-full transition-colors ${
															tunnelStatus === 'connected'
																? 'bg-green-500'
																: cloudflaredInstalled
																	? 'bg-gray-600 hover:bg-gray-500'
																	: 'bg-gray-700 opacity-50 cursor-not-allowed'
														}`}
														title={
															!cloudflaredInstalled
																? 'cloudflared not installed'
																: tunnelStatus === 'connected'
																	? 'Disable remote access'
																	: 'Enable remote access'
														}
													>
														<div
															className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
																tunnelStatus === 'connected' ? 'translate-x-5' : 'translate-x-0.5'
															}`}
														/>
														{tunnelStatus === 'starting' && (
															<div className="absolute inset-0 flex items-center justify-center">
																<div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
															</div>
														)}
													</button>
												</div>

												{/* Error Message */}
												{tunnelStatus === 'error' && tunnelError && (
													<div className="mt-2 text-[10px] text-red-400">{tunnelError}</div>
												)}

												{/* Install Instructions (when cloudflared not found) */}
												{cloudflaredInstalled === false && (
													<div
														className="mt-2 p-2 rounded text-[10px]"
														style={{ backgroundColor: theme.colors.bgActivity }}
													>
														<div className="font-medium mb-1">To enable remote access:</div>
														<div className="opacity-70 font-mono">brew install cloudflared</div>
														<button
															onClick={() =>
																window.maestro.shell.openExternal(
																	'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
																)
															}
															className="text-blue-400 hover:underline mt-1 block"
														>
															Other platforms →
														</button>
													</div>
												)}
											</div>

											{/* Custom Port Toggle Section */}
											<div className="p-3 border-b" style={{ borderColor: theme.colors.border }}>
												<div className="flex items-center justify-between">
													<div>
														<div
															className="text-[10px] uppercase font-bold"
															style={{ color: theme.colors.textDim }}
														>
															Custom Port
														</div>
														<div
															className="text-[9px] mt-0.5"
															style={{ color: theme.colors.textDim, opacity: 0.7 }}
														>
															For static proxy routes
														</div>
													</div>

													{/* Toggle Switch */}
													<button
														onClick={async () => {
															setWebInterfaceUseCustomPort(!webInterfaceUseCustomPort);
															// If server is running, restart it to apply the change
															if (isLiveMode) {
																// Small delay to ensure setting is persisted before restart
																setTimeout(() => restartWebServer(), 100);
															}
														}}
														className={`relative w-10 h-5 rounded-full transition-colors ${
															webInterfaceUseCustomPort
																? 'bg-green-500'
																: 'bg-gray-600 hover:bg-gray-500'
														}`}
														title={
															webInterfaceUseCustomPort ? 'Use random port' : 'Use custom port'
														}
													>
														<div
															className={`absolute left-0 top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
																webInterfaceUseCustomPort ? 'translate-x-5' : 'translate-x-0.5'
															}`}
														/>
													</button>
												</div>

												{/* Port Input (shown when custom port is enabled) */}
												{webInterfaceUseCustomPort && (
													<div className="mt-2">
														<div className="flex items-center gap-2">
															<input
																type="text"
																inputMode="numeric"
																pattern="[0-9]*"
																value={webInterfaceCustomPort}
																onChange={(e) => {
																	// Allow empty or any numeric input during typing
																	const raw = e.target.value.replace(/[^0-9]/g, '');
																	if (raw === '') {
																		setWebInterfaceCustomPort(0);
																	} else {
																		const value = parseInt(raw, 10);
																		if (!isNaN(value)) {
																			setWebInterfaceCustomPort(value);
																		}
																	}
																}}
																onBlur={() => {
																	// Clamp to valid range on blur
																	const clampedPort = Math.max(
																		1024,
																		Math.min(65535, webInterfaceCustomPort)
																	);
																	if (clampedPort !== webInterfaceCustomPort) {
																		setWebInterfaceCustomPort(clampedPort);
																	}
																	// Restart server when user finishes editing the port
																	if (isLiveMode) {
																		restartWebServer();
																	}
																}}
																onKeyDown={(e) => {
																	// Restart server when user presses Enter
																	if (e.key === 'Enter') {
																		// Clamp to valid range
																		const clampedPort = Math.max(
																			1024,
																			Math.min(65535, webInterfaceCustomPort)
																		);
																		if (clampedPort !== webInterfaceCustomPort) {
																			setWebInterfaceCustomPort(clampedPort);
																		}
																		if (isLiveMode) {
																			restartWebServer();
																		}
																		(e.target as HTMLInputElement).blur();
																	}
																}}
																className="flex-1 px-2 py-1 text-[11px] font-mono rounded border outline-none"
																style={{
																	backgroundColor: theme.colors.bgActivity,
																	borderColor: theme.colors.border,
																	color: theme.colors.textMain,
																}}
																placeholder="8080"
															/>
														</div>
														<div
															className="text-[9px] mt-1"
															style={{ color: theme.colors.textDim, opacity: 0.7 }}
														>
															{isLiveMode
																? 'Press Enter or click away to apply'
																: 'Port range: 1024-65535'}
														</div>
													</div>
												)}
											</div>

											{/* URL and QR Code Section - Single View */}
											<div className="p-3 border-b" style={{ borderColor: theme.colors.border }}>
												{/* URL Display */}
												<div className="flex items-center gap-2 mb-3">
													<div
														className={`flex-1 text-[11px] font-mono truncate select-all ${
															activeUrlTab === 'local' ? 'text-green-400' : 'text-blue-400'
														}`}
														title={activeUrlTab === 'local' ? webInterfaceUrl : tunnelUrl || ''}
													>
														{(activeUrlTab === 'local' ? webInterfaceUrl : tunnelUrl || '').replace(
															/^https?:\/\//,
															''
														)}
													</div>
													<button
														onClick={() => {
															const url = activeUrlTab === 'local' ? webInterfaceUrl : tunnelUrl;
															if (url) {
																navigator.clipboard.writeText(url);
																setCopyFlash(
																	activeUrlTab === 'local'
																		? 'Local URL copied!'
																		: 'Remote URL copied!'
																);
															}
														}}
														className="p-1.5 rounded hover:bg-white/10 transition-colors shrink-0"
														title="Copy URL"
													>
														<Copy className="w-3 h-3" style={{ color: theme.colors.textDim }} />
													</button>
													<button
														onClick={() => {
															const url = activeUrlTab === 'local' ? webInterfaceUrl : tunnelUrl;
															if (url) window.maestro.shell.openExternal(url);
														}}
														className="p-1.5 rounded hover:bg-white/10 transition-colors shrink-0"
														title="Open in Browser"
													>
														<ExternalLink
															className="w-3 h-3"
															style={{ color: theme.colors.textDim }}
														/>
													</button>
												</div>

												{/* QR Code with optional loading overlay */}
												<div className="relative">
													<div className="p-2 rounded" style={{ backgroundColor: 'white' }}>
														<QRCodeSVG
															value={
																activeUrlTab === 'local'
																	? webInterfaceUrl
																	: tunnelUrl || webInterfaceUrl
															}
															size={220}
															bgColor="#FFFFFF"
															fgColor="#000000"
															style={{ width: '100%', height: 'auto' }}
														/>
													</div>

													{/* Loading overlay when tunnel is starting */}
													{tunnelStatus === 'starting' && (
														<div
															className="absolute inset-0 flex flex-col items-center justify-center rounded"
															style={{ backgroundColor: 'rgba(0,0,0,0.85)' }}
														>
															<div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin mb-3" />
															<div className="text-white text-[11px] font-medium">
																Starting tunnel...
															</div>
														</div>
													)}

													{/* Copy flash notice */}
													{copyFlash && (
														<div
															className="absolute inset-0 flex items-center justify-center rounded pointer-events-none animate-pulse"
															style={{ backgroundColor: 'rgba(0,0,0,0.75)' }}
														>
															<div
																className="px-4 py-2 rounded-full text-[12px] font-bold"
																style={{
																	backgroundColor: activeUrlTab === 'local' ? '#22c55e' : '#3b82f6',
																	color: 'white',
																}}
															>
																{copyFlash}
															</div>
														</div>
													)}
												</div>

												{/* Local/Remote Pill Selector - Only shown when tunnel is connected */}
												{tunnelStatus === 'connected' && (
													<div className="mt-3 flex flex-col items-center gap-2">
														<div
															className="inline-flex rounded-full p-0.5"
															style={{ backgroundColor: theme.colors.bgActivity }}
														>
															<button
																onClick={() => setActiveUrlTab('local')}
																className={`px-4 py-1 text-[10px] font-bold uppercase rounded-full transition-all ${
																	activeUrlTab === 'local'
																		? 'bg-green-500 text-white shadow-sm'
																		: 'hover:bg-white/10'
																}`}
																style={
																	activeUrlTab !== 'local' ? { color: theme.colors.textDim } : {}
																}
															>
																Local
															</button>
															<button
																onClick={() => setActiveUrlTab('remote')}
																className={`px-4 py-1 text-[10px] font-bold uppercase rounded-full transition-all ${
																	activeUrlTab === 'remote'
																		? 'bg-blue-500 text-white shadow-sm'
																		: 'hover:bg-white/10'
																}`}
																style={
																	activeUrlTab !== 'remote' ? { color: theme.colors.textDim } : {}
																}
															>
																Remote
															</button>
														</div>
														{/* Dot indicators */}
														<div className="flex gap-1.5">
															<div
																className={`w-1.5 h-1.5 rounded-full transition-colors cursor-pointer ${
																	activeUrlTab === 'local' ? 'bg-green-500' : 'bg-gray-600'
																}`}
																onClick={() => setActiveUrlTab('local')}
															/>
															<div
																className={`w-1.5 h-1.5 rounded-full transition-colors cursor-pointer ${
																	activeUrlTab === 'remote' ? 'bg-blue-500' : 'bg-gray-600'
																}`}
																onClick={() => setActiveUrlTab('remote')}
															/>
														</div>
													</div>
												)}
											</div>

											{/* Action Buttons */}
											<div className="p-3 space-y-2">
												{/* Open in Browser Button */}
												<button
													onClick={() => {
														const url = activeUrlTab === 'local' ? webInterfaceUrl : tunnelUrl;
														if (url) window.maestro.shell.openExternal(url);
													}}
													className="w-full py-1.5 rounded text-[10px] font-medium transition-colors hover:bg-white/10 border"
													style={{
														color: activeUrlTab === 'local' ? '#4ade80' : '#60a5fa',
														borderColor:
															activeUrlTab === 'local'
																? 'rgba(74, 222, 128, 0.3)'
																: 'rgba(96, 165, 250, 0.3)',
													}}
												>
													Open in Browser
												</button>
												{/* Turn Off Button */}
												<button
													onClick={() => {
														toggleGlobalLive();
														setLiveOverlayOpen(false);
													}}
													className="w-full py-1.5 rounded text-[10px] font-medium transition-colors hover:bg-red-500/20 text-red-400 border border-red-500/30"
												>
													Turn Off Web Interface
												</button>
											</div>
										</div>
									</div>
								)}
							</div>
						</div>
						{/* Hamburger Menu */}
						<div className="relative" ref={menuRef} data-tour="hamburger-menu">
							<button
								onClick={() => setMenuOpen(!menuOpen)}
								className="p-2 rounded hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textDim }}
								title="Menu"
							>
								<Menu className="w-4 h-4" />
							</button>
							{/* Menu Overlay */}
							{menuOpen && (
								<div
									className="absolute top-full left-0 mt-2 w-72 rounded-lg shadow-2xl z-50 overflow-hidden"
									data-tour="hamburger-menu-contents"
									style={{
										backgroundColor: theme.colors.bgSidebar,
										border: `1px solid ${theme.colors.border}`,
									}}
								>
									<HamburgerMenuContent
										theme={theme}
										shortcuts={shortcuts}
										openWizard={openWizard}
										startTour={startTour}
										setShortcutsHelpOpen={setShortcutsHelpOpen}
										setSettingsModalOpen={setSettingsModalOpen}
										setSettingsTab={setSettingsTab}
										setLogViewerOpen={setLogViewerOpen}
										setProcessMonitorOpen={setProcessMonitorOpen}
										setUsageDashboardOpen={setUsageDashboardOpen}
										setUpdateCheckModalOpen={setUpdateCheckModalOpen}
										setAboutModalOpen={setAboutModalOpen}
										setMenuOpen={setMenuOpen}
									/>
								</div>
							)}
						</div>
					</>
				) : (
					<div className="w-full flex flex-col items-center gap-2 relative" ref={menuRef}>
						<button
							onClick={() => setMenuOpen(!menuOpen)}
							className="p-2 rounded hover:bg-white/10 transition-colors"
							title="Menu"
						>
							<Wand2 className="w-6 h-6" style={{ color: theme.colors.accent }} />
						</button>
						{/* Menu Overlay for Collapsed Sidebar */}
						{menuOpen && (
							<div
								className="absolute top-full left-0 mt-2 w-72 rounded-lg shadow-2xl z-50 overflow-hidden"
								style={{
									backgroundColor: theme.colors.bgSidebar,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								<HamburgerMenuContent
									theme={theme}
									shortcuts={shortcuts}
									openWizard={openWizard}
									startTour={startTour}
									setShortcutsHelpOpen={setShortcutsHelpOpen}
									setSettingsModalOpen={setSettingsModalOpen}
									setSettingsTab={setSettingsTab}
									setLogViewerOpen={setLogViewerOpen}
									setProcessMonitorOpen={setProcessMonitorOpen}
									setUsageDashboardOpen={setUsageDashboardOpen}
									setUpdateCheckModalOpen={setUpdateCheckModalOpen}
									setAboutModalOpen={setAboutModalOpen}
									setMenuOpen={setMenuOpen}
								/>
							</div>
						)}
					</div>
				)}
			</div>

			{/* SIDEBAR CONTENT: EXPANDED */}
			{leftSidebarOpen ? (
				<div
					className="flex-1 overflow-y-auto py-2 select-none scrollbar-thin flex flex-col"
					data-tour="session-list"
				>
					{/* Session Filter */}
					{sessionFilterOpen && (
						<div className="mx-3 mb-3">
							<input
								autoFocus
								type="text"
								placeholder="Filter agents..."
								value={sessionFilter}
								onChange={(e) => setSessionFilter(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Escape') {
										setSessionFilterOpen(false);
										setSessionFilter('');
									}
								}}
								className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm"
								style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
							/>
						</div>
					)}

					{/* BOOKMARKS SECTION - only show if there are bookmarked sessions */}
					{bookmarkedSessions.length > 0 && (
						<div className="mb-1">
							<div
								className="px-3 py-1.5 flex items-center justify-between cursor-pointer hover:bg-opacity-50 group"
								onClick={() => setBookmarksCollapsed(!bookmarksCollapsed)}
							>
								<div
									className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider flex-1"
									style={{ color: theme.colors.accent }}
								>
									{bookmarksCollapsed ? (
										<ChevronRight className="w-3 h-3" />
									) : (
										<ChevronDown className="w-3 h-3" />
									)}
									<Bookmark className="w-3.5 h-3.5" fill={theme.colors.accent} />
									<span>Bookmarks</span>
								</div>
							</div>

							{!bookmarksCollapsed ? (
								<div
									className="flex flex-col border-l ml-4"
									style={{ borderColor: theme.colors.accent }}
								>
									{sortedBookmarkedSessions.map((session) => {
										const group = groups.find((g) => g.id === session.groupId);
										return renderSessionWithWorktrees(session, 'bookmark', {
											keyPrefix: 'bookmark',
											group,
										});
									})}
								</div>
							) : (
								/* Collapsed Bookmarks Palette - uses subdivided pills for worktrees */
								<div
									className="ml-8 mr-3 mt-1 mb-2 flex gap-1 h-1.5 cursor-pointer"
									onClick={() => setBookmarksCollapsed(false)}
								>
									{sortedBookmarkedParentSessions.map((s) =>
										renderCollapsedPill(s, 'bookmark-collapsed', () => setBookmarksCollapsed(false))
									)}
								</div>
							)}
						</div>
					)}

					{/* GROUPS */}
					{sortedGroups.map((group) => {
						const groupSessions = sortedGroupSessionsById.get(group.id) || [];
						return (
							<div key={group.id} className="mb-1">
								<div
									className="px-3 py-1.5 flex items-center justify-between cursor-pointer hover:bg-opacity-50 group"
									onClick={() => toggleGroup(group.id)}
									onDragOver={handleDragOver}
									onDrop={() => handleDropOnGroup(group.id)}
								>
									<div
										className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider flex-1"
										style={{ color: theme.colors.textDim }}
									>
										{group.collapsed ? (
											<ChevronRight className="w-3 h-3" />
										) : (
											<ChevronDown className="w-3 h-3" />
										)}
										<span className="text-sm">{group.emoji}</span>
										{editingGroupId === group.id ? (
											<input
												autoFocus
												className="bg-transparent outline-none w-full border-b border-indigo-500"
												defaultValue={group.name}
												onClick={(e) => e.stopPropagation()}
												onBlur={(e) => finishRenamingGroup(group.id, e.target.value)}
												onKeyDown={(e) => {
													e.stopPropagation();
													if (e.key === 'Enter')
														finishRenamingGroup(group.id, e.currentTarget.value);
												}}
											/>
										) : (
											<span onDoubleClick={() => startRenamingGroup(group.id)}>{group.name}</span>
										)}
									</div>
									{/* Delete button for empty groups */}
									{groupSessions.length === 0 && (
										<button
											onClick={(e) => {
												e.stopPropagation();
												showConfirmation(
													`Are you sure you want to delete the group "${group.name}"?`,
													() => {
														setGroups((prev) => prev.filter((g) => g.id !== group.id));
													}
												);
											}}
											className="p-1 rounded hover:bg-red-500/20 opacity-0 group-hover:opacity-100 transition-opacity"
											style={{ color: theme.colors.error }}
											title="Delete empty group"
										>
											<X className="w-3 h-3" />
										</button>
									)}
									{/* Delete button for worktree groups with agents */}
									{group.emoji === '🌳' && groupSessions.length > 0 && onDeleteWorktreeGroup && (
										<button
											onClick={(e) => {
												e.stopPropagation();
												onDeleteWorktreeGroup(group.id);
											}}
											className="p-1 rounded hover:bg-red-500/20 opacity-0 group-hover:opacity-100 transition-opacity"
											style={{ color: theme.colors.error }}
											title="Remove group and all agents"
										>
											<Trash2 className="w-3 h-3" />
										</button>
									)}
								</div>

								{!group.collapsed ? (
									<div
										className="flex flex-col border-l ml-4"
										style={{ borderColor: theme.colors.border }}
									>
										{groupSessions.map((session) =>
											renderSessionWithWorktrees(session, 'group', {
												keyPrefix: `group-${group.id}`,
												groupId: group.id,
												onDrop: () => handleDropOnGroup(group.id),
											})
										)}
									</div>
								) : (
									/* Collapsed Group Palette - uses subdivided pills for worktrees */
									<div
										className="ml-8 mr-3 mt-1 mb-2 flex gap-1 h-1.5 cursor-pointer"
										onClick={() => toggleGroup(group.id)}
									>
										{groupSessions
											.filter((s) => !s.parentSessionId)
											.map((s) =>
												renderCollapsedPill(s, `group-collapsed-${group.id}`, () =>
													toggleGroup(group.id)
												)
											)}
									</div>
								)}
							</div>
						);
					})}

					{/* SESSIONS - Flat list when no groups exist, otherwise show Ungrouped folder */}
					{sessions.length > 0 && groups.length === 0 ? (
						/* FLAT LIST - No groups exist yet, show sessions directly */
						<div className="flex flex-col">
							{sortedFilteredSessions.map((session) =>
								renderSessionWithWorktrees(session, 'flat', { keyPrefix: 'flat' })
							)}
						</div>
					) : (
						groups.length > 0 && (
							/* UNGROUPED FOLDER - Groups exist, show as collapsible folder */
							<div className="mb-1 mt-4">
								<div
									className="px-3 py-1.5 flex items-center justify-between cursor-pointer hover:bg-opacity-50 group"
									onClick={() => setUngroupedCollapsed(!ungroupedCollapsed)}
									onDragOver={handleDragOver}
									onDrop={handleDropOnUngrouped}
								>
									<div
										className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider flex-1"
										style={{ color: theme.colors.textDim }}
									>
										{ungroupedCollapsed ? (
											<ChevronRight className="w-3 h-3" />
										) : (
											<ChevronDown className="w-3 h-3" />
										)}
										<Folder className="w-3.5 h-3.5" />
										<span>Ungrouped Agents</span>
									</div>
									<button
										onClick={(e) => {
											e.stopPropagation();
											createNewGroup();
										}}
										className="px-2 py-0.5 rounded-full text-[10px] font-medium hover:opacity-80 transition-opacity flex items-center gap-1"
										style={{
											backgroundColor: theme.colors.accent + '20',
											color: theme.colors.accent,
											border: `1px solid ${theme.colors.accent}40`,
										}}
										title="Create new group"
									>
										<Plus className="w-3 h-3" />
										<span>New Group</span>
									</button>
								</div>

								{!ungroupedCollapsed ? (
									<div
										className="flex flex-col border-l ml-4"
										style={{ borderColor: theme.colors.border }}
									>
										{sortedUngroupedSessions.map((session) =>
											renderSessionWithWorktrees(session, 'ungrouped', { keyPrefix: 'ungrouped' })
										)}
									</div>
								) : (
									/* Collapsed Ungrouped Palette - uses subdivided pills for worktrees */
									<div
										className="ml-8 mr-3 mt-1 mb-2 flex gap-1 h-1.5 cursor-pointer"
										onClick={() => setUngroupedCollapsed(false)}
									>
										{sortedUngroupedParentSessions.map((s) =>
											renderCollapsedPill(s, 'ungrouped-collapsed', () =>
												setUngroupedCollapsed(false)
											)
										)}
									</div>
								)}
							</div>
						)
					)}

					{/* Flexible spacer to push group chats to bottom */}
					<div className="flex-grow min-h-4" />

					{/* GROUP CHATS SECTION - Only show when at least 2 AI agents exist */}
					{onNewGroupChat &&
						onOpenGroupChat &&
						onEditGroupChat &&
						onRenameGroupChat &&
						onDeleteGroupChat &&
						sessions.filter((s) => s.toolType !== 'terminal').length >= 2 && (
							<GroupChatList
								theme={theme}
								groupChats={groupChats}
								activeGroupChatId={activeGroupChatId}
								onOpenGroupChat={onOpenGroupChat}
								onNewGroupChat={onNewGroupChat}
								onEditGroupChat={onEditGroupChat}
								onRenameGroupChat={onRenameGroupChat}
								onDeleteGroupChat={onDeleteGroupChat}
								isExpanded={groupChatsExpanded}
								onExpandedChange={onGroupChatsExpandedChange}
								groupChatState={groupChatState}
								participantStates={participantStates}
								groupChatStates={groupChatStates}
								allGroupChatParticipantStates={allGroupChatParticipantStates}
							/>
						)}
				</div>
			) : (
				/* SIDEBAR CONTENT: SKINNY MODE */
				<div className="flex-1 flex flex-col items-center py-4 gap-2 overflow-y-auto overflow-x-visible no-scrollbar">
					{sortedSessions.map((session) => {
						const isInBatch = activeBatchSessionIds.includes(session.id);
						const hasUnreadTabs = session.aiTabs?.some((tab) => tab.hasUnread);
						// Sessions in Auto Run mode should show yellow/warning color
						const effectiveStatusColor = isInBatch
							? theme.colors.warning
							: session.toolType === 'claude' && !session.agentSessionId
								? undefined // Will use border style instead
								: getStatusColor(session.state, theme);
						const shouldPulse = session.state === 'busy' || isInBatch;

						return (
							<div
								key={session.id}
								onClick={() => setActiveSessionId(session.id)}
								onContextMenu={(e) => handleContextMenu(e, session.id)}
								className={`group relative w-8 h-8 rounded-full flex items-center justify-center cursor-pointer transition-all ${activeSessionId === session.id ? 'ring-2' : 'hover:bg-white/10'}`}
								style={{ '--tw-ring-color': theme.colors.accent } as React.CSSProperties}
							>
								<div className="relative">
									<div
										className={`w-3 h-3 rounded-full ${shouldPulse ? 'animate-pulse' : ''}`}
										style={
											session.toolType === 'claude' && !session.agentSessionId && !isInBatch
												? {
														border: `1.5px solid ${theme.colors.textDim}`,
														backgroundColor: 'transparent',
													}
												: { backgroundColor: effectiveStatusColor }
										}
										title={
											session.toolType === 'claude' && !session.agentSessionId
												? 'No active Claude session'
												: undefined
										}
									/>
									{/* Unread Notification Badge */}
									{activeSessionId !== session.id && hasUnreadTabs && (
										<div
											className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full"
											style={{ backgroundColor: theme.colors.error }}
											title="Unread messages"
										/>
									)}
								</div>

								{/* Hover Tooltip for Skinny Mode */}
								<div
									className="fixed rounded px-3 py-2 z-[100] opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity shadow-xl"
									style={{
										minWidth: '240px',
										left: '80px',
										backgroundColor: theme.colors.bgSidebar,
										border: `1px solid ${theme.colors.border}`,
									}}
								>
									<SessionTooltipContent
										session={session}
										theme={theme}
										gitFileCount={getFileCount(session.id)}
										groupName={groups.find((g) => g.id === session.groupId)?.name}
										isInBatch={isInBatch}
									/>
								</div>
							</div>
						);
					})}
				</div>
			)}

			{/* SIDEBAR BOTTOM ACTIONS */}
			<div
				className="p-2 border-t flex gap-2 items-center"
				style={{ borderColor: theme.colors.border }}
			>
				<button
					onClick={() => {
						// Only allow collapsing when there are sessions (prevent collapse on empty state)
						if (sessions.length > 0 || !leftSidebarOpen) {
							setLeftSidebarOpen(!leftSidebarOpen);
						}
					}}
					className={`flex items-center justify-center p-2 rounded transition-colors w-8 h-8 shrink-0 ${sessions.length === 0 && leftSidebarOpen ? 'opacity-20 cursor-not-allowed' : 'hover:bg-white/5'}`}
					title={
						sessions.length === 0 && leftSidebarOpen
							? 'Add an agent first to collapse sidebar'
							: `${leftSidebarOpen ? 'Collapse' : 'Expand'} Sidebar (${formatShortcutKeys(shortcuts.toggleSidebar.keys)})`
					}
				>
					{leftSidebarOpen ? (
						<PanelLeftClose className="w-4 h-4 opacity-50" />
					) : (
						<PanelLeftOpen className="w-4 h-4 opacity-50" />
					)}
				</button>

				{leftSidebarOpen && (
					<button
						onClick={addNewSession}
						className="flex-1 flex items-center justify-center gap-2 py-2 rounded text-xs font-bold transition-colors hover:opacity-90"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
					>
						<Bot className="w-3 h-3" /> New Agent
					</button>
				)}

				{leftSidebarOpen && openWizard && (
					<button
						onClick={openWizard}
						className="flex-1 flex items-center justify-center gap-2 py-2 rounded text-xs font-bold transition-colors hover:opacity-90"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
						title="Get started with AI wizard"
					>
						<Wand2 className="w-3 h-3" /> Wizard
					</button>
				)}
			</div>

			{/* Session Context Menu */}
			{contextMenu && contextMenuSession && (
				<SessionContextMenu
					x={contextMenu.x}
					y={contextMenu.y}
					theme={theme}
					session={contextMenuSession}
					groups={groups}
					hasWorktreeChildren={sessions.some((s) => s.parentSessionId === contextMenuSession.id)}
					onRename={() => {
						setRenameInstanceValue(contextMenuSession.name);
						setRenameInstanceSessionId(contextMenuSession.id);
						setRenameInstanceModalOpen(true);
					}}
					onEdit={() => onEditAgent(contextMenuSession)}
					onDuplicate={() => {
						setDuplicatingSessionId(contextMenuSession.id);
						onNewAgentSession();
						setContextMenu(null);
					}}
					onToggleBookmark={() => toggleBookmark(contextMenuSession.id)}
					onMoveToGroup={(groupId) => handleMoveToGroup(contextMenuSession.id, groupId)}
					onDelete={() => handleDeleteSession(contextMenuSession.id)}
					onDismiss={() => setContextMenu(null)}
					onCreatePR={
						onOpenCreatePR && contextMenuSession.parentSessionId
							? () => onOpenCreatePR(contextMenuSession)
							: undefined
					}
					onQuickCreateWorktree={
						onQuickCreateWorktree && !contextMenuSession.parentSessionId
							? () => onQuickCreateWorktree(contextMenuSession)
							: undefined
					}
					onConfigureWorktrees={
						onOpenWorktreeConfig && !contextMenuSession.parentSessionId
							? () => onOpenWorktreeConfig(contextMenuSession)
							: undefined
					}
					onDeleteWorktree={
						onDeleteWorktree && contextMenuSession.parentSessionId
							? () => onDeleteWorktree(contextMenuSession)
							: undefined
					}
					onCreateGroup={
						onCreateGroupAndMove
							? () => onCreateGroupAndMove(contextMenuSession.id)
							: createNewGroup
					}
				/>
			)}
		</div>
	);
}

export const SessionList = memo(SessionListInner);
