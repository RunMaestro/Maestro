import { useState, useEffect, useRef } from 'react';
import {
	ChevronRight,
	Settings,
	Copy,
	Bookmark,
	FolderInput,
	FolderPlus,
	Folder,
	GitBranch,
	GitPullRequest,
	Trash2,
	Edit3,
	Zap,
	Fingerprint,
	AppWindow,
	Plus,
	Pencil,
	Check,
} from 'lucide-react';
import type { Group, Session, Theme } from '../../types';
import { useClickOutside, useContextMenuPosition } from '../../hooks';
import { safeClipboardWrite } from '../../utils/clipboard';
import { flashCopiedToClipboard } from '../../utils/flashCopiedToClipboard';
import type { WindowMoveTarget } from '../../utils/windowTargets';

interface SessionContextMenuProps {
	x: number;
	y: number;
	theme: Theme;
	session: Session;
	groups: Group[];
	hasWorktreeChildren: boolean;
	onRename: () => void;
	onEdit: () => void;
	onDuplicate: () => void;
	onToggleBookmark: () => void;
	onMoveToGroup: (groupId: string) => void;
	onDelete: () => void;
	onDismiss: () => void;
	onCreatePR?: () => void;
	onQuickCreateWorktree?: () => void;
	onConfigureWorktrees?: () => void;
	onDeleteWorktree?: () => void;
	onCreateGroup?: () => void;
	/** Hide persisted-group mutation controls in a virtual grouping mode. */
	showGroupActions?: boolean;
	onConfigureCue?: () => void;
	/**
	 * Multi-window: every window this agent can move into, labeled by number
	 * ("Main Window" for the primary, "Window N" for secondaries, or a custom
	 * name), with the current owner flagged. Omitted or empty in a single-window
	 * app, where the "Move to Window" submenu is hidden.
	 */
	windowTargets?: WindowMoveTarget[];
	/** Detach this agent into a brand-new window. */
	onMoveToNewWindow?: () => void;
	/** Move this agent into the given existing window. */
	onMoveToWindow?: (windowId: string) => void;
	/**
	 * Rename a window (empty string clears back to the generic label). Enables the
	 * inline pencil-rename affordance on each secondary window row in the Move to
	 * Window submenu. Omitted in a single-window app.
	 */
	onRenameWindow?: (windowId: string, name: string) => void;
}

/**
 * Hover/focus flyout state for a nested context-menu submenu: open/close with a
 * grace timeout and a viewport-aware above/below + left/right flip. `itemCount`
 * is the flyout's approximate row count, used only to decide the flip. Shared by
 * the Move-to-Group and Move-to-Window submenus so neither reimplements it.
 * The return type is inferred so `containerRef` stays exactly `useRef`'s type
 * (directly ref-assignable, avoiding a null-variance mismatch on the JSX ref).
 */
function useFlyoutSubmenu(itemCount: number) {
	const containerRef = useRef<HTMLDivElement>(null);
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [show, setShow] = useState(false);
	const [position, setPosition] = useState<{
		vertical: 'below' | 'above';
		horizontal: 'right' | 'left';
	}>({ vertical: 'below', horizontal: 'right' });

	useEffect(() => {
		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
				timeoutRef.current = null;
			}
		};
	}, []);

	const open = () => {
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
			timeoutRef.current = null;
		}
		setShow(true);
		if (containerRef.current) {
			const rect = containerRef.current.getBoundingClientRect();
			const itemHeight = 28;
			const submenuHeight = itemCount * itemHeight + 16;
			const submenuWidth = 160;
			const spaceBelow = window.innerHeight - rect.top;
			const spaceRight = window.innerWidth - rect.right;
			const vertical = spaceBelow < submenuHeight && rect.top > submenuHeight ? 'above' : 'below';
			const horizontal = spaceRight < submenuWidth && rect.left > submenuWidth ? 'left' : 'right';
			setPosition({ vertical, horizontal });
		}
	};

	const scheduleClose = () => {
		if (timeoutRef.current) clearTimeout(timeoutRef.current);
		timeoutRef.current = setTimeout(() => {
			setShow(false);
			timeoutRef.current = null;
		}, 300);
	};

	const close = () => setShow(false);

	return { containerRef, show, position, open, scheduleClose, close };
}

export function SessionContextMenu({
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
	showGroupActions = true,
	onConfigureCue,
	windowTargets,
	onMoveToNewWindow,
	onMoveToWindow,
	onRenameWindow,
}: SessionContextMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);

	// Inline window-rename state. While a row is being renamed, the Move to Window
	// flyout must NOT auto-close on mouse-leave (it would unmount the input
	// mid-edit), so the container's close is guarded on this being null.
	const [renamingWindowId, setRenamingWindowId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState('');

	const onDismissRef = useRef(onDismiss);
	onDismissRef.current = onDismiss;

	useClickOutside(menuRef, onDismiss);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				onDismissRef.current();
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, []);

	const { left, top, ready } = useContextMenuPosition(menuRef, x, y);

	// One flyout state machine per submenu (Move to Group, Move to Window). Item
	// count feeds the above/below flip decision. Extracted so the two flyouts do
	// not duplicate the hover/timeout/positioning logic.
	const moveToGroup = useFlyoutSubmenu(groups.length + 2);
	const moveToWindow = useFlyoutSubmenu((windowTargets?.length ?? 0) + 2);

	// "Move to Window" appears only in a multi-window-capable app: a mover handler
	// plus at least one enumerated window (empty before the registry hydrates).
	const showMoveToWindow = !!onMoveToNewWindow && !!windowTargets && windowTargets.length > 0;

	// Enter inline rename for a window row (seed the input with its current custom
	// name, or empty so the generic label shows as the placeholder).
	const beginRenameWindow = (windowId: string, currentName?: string) => {
		setRenameValue(currentName ?? '');
		setRenamingWindowId(windowId);
		moveToWindow.open();
	};
	// Commit the rename and dismiss the whole menu (the new label shows on next
	// open, in the OS title, and in any other window via the name-changed broadcast).
	const commitRenameWindow = () => {
		if (!renamingWindowId) return;
		const id = renamingWindowId;
		setRenamingWindowId(null);
		onRenameWindow?.(id, renameValue.trim());
		onDismiss();
	};
	// Abandon the edit without renaming; keep the menu open.
	const cancelRenameWindow = () => setRenamingWindowId(null);

	// Compute visibility for worktree sections to avoid rendering dividers without buttons
	const showWorktreeParentSection =
		(hasWorktreeChildren || session.isGitRepo) &&
		!session.parentSessionId &&
		((onQuickCreateWorktree && session.worktreeConfig) || onConfigureWorktrees);

	const showWorktreeChildSection =
		session.parentSessionId && session.worktreeBranch && (onCreatePR || onDeleteWorktree);

	return (
		<div
			ref={menuRef}
			className="fixed z-50 py-1 rounded-md shadow-xl border whitespace-nowrap"
			style={{
				left,
				top,
				opacity: ready ? 1 : 0,
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
				minWidth: '10rem',
			}}
		>
			{!session.isPianola && (
				<button
					type="button"
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
			)}

			<button
				type="button"
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

			{!session.isPianola && (
				<button
					type="button"
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
			)}

			{!session.parentSessionId && !session.isPianola && (
				<button
					type="button"
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

			{showGroupActions && !session.parentSessionId && !session.isPianola && (
				<div
					ref={moveToGroup.containerRef}
					className="relative"
					tabIndex={0}
					onMouseEnter={moveToGroup.open}
					onMouseLeave={moveToGroup.scheduleClose}
					onFocus={moveToGroup.open}
					onBlur={moveToGroup.scheduleClose}
					onKeyDown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							moveToGroup.open();
						} else if (e.key === 'Escape' && moveToGroup.show) {
							e.stopPropagation();
							moveToGroup.close();
						}
					}}
				>
					<button
						type="button"
						className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center justify-between"
						style={{ color: theme.colors.textMain }}
					>
						<span className="flex items-center gap-2">
							<FolderInput className="w-3.5 h-3.5" />
							Move to Group
						</span>
						<ChevronRight className="w-3 h-3" />
					</button>

					{moveToGroup.show && (
						<div
							className="absolute py-1 rounded-md shadow-xl border whitespace-nowrap"
							style={{
								backgroundColor: theme.colors.bgSidebar,
								borderColor: theme.colors.border,
								minWidth: '8.75rem',
								...(moveToGroup.position.vertical === 'above' ? { bottom: 0 } : { top: 0 }),
								...(moveToGroup.position.horizontal === 'left'
									? { right: '100%', marginRight: 4 }
									: { left: '100%', marginLeft: 4 }),
							}}
						>
							<button
								type="button"
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

							{groups.length > 0 && (
								<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
							)}

							{groups.map((group) => (
								<button
									type="button"
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

							{onCreateGroup && (
								<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
							)}

							{onCreateGroup && (
								<button
									type="button"
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

			{showMoveToWindow && (
				<div
					ref={moveToWindow.containerRef}
					className="relative"
					tabIndex={0}
					onMouseEnter={moveToWindow.open}
					// Don't auto-close while a row is being renamed - it would unmount the
					// input mid-edit. The commit (Enter/blur) clears editing, after which
					// normal close resumes.
					onMouseLeave={() => {
						if (!renamingWindowId) moveToWindow.scheduleClose();
					}}
					onFocus={moveToWindow.open}
					onBlur={() => {
						if (!renamingWindowId) moveToWindow.scheduleClose();
					}}
					onKeyDown={(e) => {
						if (renamingWindowId) return; // let the rename input own key handling
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							moveToWindow.open();
						} else if (e.key === 'Escape' && moveToWindow.show) {
							e.stopPropagation();
							moveToWindow.close();
						}
					}}
				>
					<button
						type="button"
						className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center justify-between"
						style={{ color: theme.colors.textMain }}
					>
						<span className="flex items-center gap-2">
							<AppWindow className="w-3.5 h-3.5" />
							Move to Window
						</span>
						<ChevronRight className="w-3 h-3" />
					</button>

					{moveToWindow.show && (
						<div
							className="absolute py-1 rounded-md shadow-xl border whitespace-nowrap"
							style={{
								backgroundColor: theme.colors.bgSidebar,
								borderColor: theme.colors.border,
								minWidth: '8.75rem',
								...(moveToWindow.position.vertical === 'above' ? { bottom: 0 } : { top: 0 }),
								...(moveToWindow.position.horizontal === 'left'
									? { right: '100%', marginRight: 4 }
									: { left: '100%', marginLeft: 4 }),
							}}
						>
							<button
								type="button"
								onClick={() => {
									onMoveToNewWindow?.();
									onDismiss();
								}}
								className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
								style={{ color: theme.colors.accent }}
							>
								<Plus className="w-3.5 h-3.5" />
								New Window
							</button>

							<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />

							{windowTargets?.map((target) =>
								renamingWindowId === target.windowId ? (
									// Inline rename: an input replaces the row. Enter/blur commit,
									// Escape cancels. stopPropagation on keys so the parent menu's
									// Escape-to-close and the flyout's key nav don't fire.
									<div key={target.windowId} className="flex items-center gap-1 px-2 py-1">
										<AppWindow
											className="w-3.5 h-3.5 shrink-0"
											style={{ color: theme.colors.textDim }}
										/>
										<input
											type="text"
											autoFocus
											value={renameValue}
											placeholder={target.label}
											onChange={(e) => setRenameValue(e.target.value)}
											onKeyDown={(e) => {
												e.stopPropagation();
												if (e.key === 'Enter') {
													e.preventDefault();
													commitRenameWindow();
												} else if (e.key === 'Escape') {
													e.preventDefault();
													cancelRenameWindow();
												}
											}}
											onBlur={commitRenameWindow}
											className="flex-1 min-w-0 bg-transparent border rounded px-1.5 py-0.5 text-xs outline-none"
											style={{
												color: theme.colors.textMain,
												borderColor: theme.colors.accent,
											}}
										/>
										<button
											type="button"
											onMouseDown={(e) => {
												// mouseDown (before the input's blur) so the click lands.
												e.preventDefault();
												commitRenameWindow();
											}}
											className="shrink-0 p-0.5 rounded hover:bg-white/10"
											title="Save window name"
											style={{ color: theme.colors.accent }}
										>
											<Check className="w-3.5 h-3.5" />
										</button>
									</div>
								) : (
									<div
										key={target.windowId}
										className={`w-full flex items-center hover:bg-white/5 transition-colors ${target.isCurrentOwner ? 'opacity-50' : ''}`}
									>
										<button
											type="button"
											onClick={() => {
												if (target.isCurrentOwner) return;
												onMoveToWindow?.(target.windowId);
												onDismiss();
											}}
											className="flex-1 min-w-0 text-left pl-3 pr-1 py-1.5 text-xs flex items-center gap-2"
											style={{ color: theme.colors.textMain }}
											disabled={target.isCurrentOwner}
										>
											<AppWindow className="w-3.5 h-3.5 shrink-0" />
											<span className="truncate">{target.label}</span>
											{target.isCurrentOwner && (
												<span className="text-[10px] opacity-50 shrink-0">(current)</span>
											)}
										</button>
										{/* Rename affordance - secondary windows only; the primary keeps
										    the stable "Main Window" label. */}
										{onRenameWindow && !target.isMain && (
											<button
												type="button"
												onClick={(e) => {
													e.stopPropagation();
													beginRenameWindow(target.windowId, target.customName);
												}}
												className="shrink-0 p-1 mr-1.5 rounded hover:bg-white/10 opacity-60 hover:opacity-100"
												title="Rename window"
												style={{ color: theme.colors.textDim }}
											>
												<Pencil className="w-3 h-3" />
											</button>
										)}
									</div>
								)
							)}
						</div>
					)}
				</div>
			)}

			{showWorktreeParentSection && (
				<>
					<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
					{onQuickCreateWorktree && session.worktreeConfig && (
						<button
							type="button"
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
							type="button"
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

			{onConfigureCue && (
				<>
					{!showWorktreeParentSection && (
						<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
					)}
					<button
						type="button"
						onClick={() => {
							onConfigureCue();
							onDismiss();
						}}
						className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
						style={{ color: '#06b6d4' }}
					>
						<Zap className="w-3.5 h-3.5" />
						Configure Maestro Cue
					</button>
				</>
			)}

			{showWorktreeChildSection && (
				<>
					<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
					{onCreatePR && (
						<button
							type="button"
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
							type="button"
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

			<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />

			<button
				type="button"
				onClick={async () => {
					if (await safeClipboardWrite(session.id)) {
						flashCopiedToClipboard(session.id, 'Agent GUID Copied');
					}
					onDismiss();
				}}
				className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
				style={{ color: theme.colors.textMain }}
			>
				<Fingerprint className="w-3.5 h-3.5" />
				Copy Agent GUID to Clipboard
			</button>

			{!session.parentSessionId && !session.isPianola && (
				<button
					type="button"
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
			)}
		</div>
	);
}
