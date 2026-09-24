import { useState, useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
	ArrowDown,
	ArrowDownToLine,
	ArrowUp,
	ArrowUpFromLine,
	ChevronRight,
	Settings,
	Copy,
	Bookmark,
	FolderInput,
	FolderPlus,
	FileDiff,
	Folder,
	GitBranch,
	GitPullRequest,
	History,
	Trash2,
	Edit3,
	Zap,
	Fingerprint,
	AppWindow,
	Mic,
	Plus,
	Pencil,
	Check,
} from 'lucide-react';
import type { Group, Session, Theme } from '../../types';
import { useAnchoredMenuPosition, useClickOutside, useContextMenuPosition } from '../../hooks';
import { compareNamesIgnoringEmojis } from '../../../shared/emojiUtils';
import { useGitAgentActions } from '../../hooks/git/useGitAgentActions';
import { useVoiceAgentActions } from '../../hooks/voice/useVoiceAgentActions';
import { GitChangeCounts } from '../ui/GitChangeCounts';
import { GitRunningBadge, PR_RUNNING_TITLE } from '../ui/GitRunningBadge';
import { formatGitChangeSummary } from '../../../shared/gitUtils';
import { safeClipboardWrite } from '../../utils/clipboard';
import { flashCopiedToClipboard } from '../../utils/flashCopiedToClipboard';
import type { WindowMoveTarget } from '../../utils/windowTargets';
import { PluginUiItemsSlot } from '../plugins/PluginUiItemsSlot';

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

/** Grace period before a flyout closes, so the pointer can cross the gap. */
const FLYOUT_CLOSE_DELAY_MS = 300;

/**
 * Hover/focus open state for a nested context-menu submenu, with a grace timeout
 * so the pointer can travel from the parent row into the flyout. Shared by the
 * Move-to-Group and Move-to-Window submenus so neither reimplements it.
 * Placement lives in `ContextMenuFlyout` below.
 * The return type is inferred so `anchorRef` stays exactly `useRef`'s type
 * (directly ref-assignable, avoiding a null-variance mismatch on the JSX ref).
 */
function useFlyoutSubmenu() {
	const anchorRef = useRef<HTMLDivElement>(null);
	// The flyout is portaled out of the menu, so the menu's click-outside check
	// needs this ref too or selecting an item would dismiss before the click lands.
	const flyoutRef = useRef<HTMLDivElement>(null);
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [show, setShow] = useState(false);

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
	};

	const scheduleClose = () => {
		if (timeoutRef.current) clearTimeout(timeoutRef.current);
		timeoutRef.current = setTimeout(() => {
			setShow(false);
			timeoutRef.current = null;
		}, FLYOUT_CLOSE_DELAY_MS);
	};

	const close = () => setShow(false);

	return { anchorRef, flyoutRef, show, open, scheduleClose, close };
}

interface ContextMenuFlyoutProps {
	/** The menu row the flyout hangs off. */
	anchorRef: RefObject<HTMLDivElement>;
	/** The flyout panel itself; the parent menu excludes it from click-outside. */
	flyoutRef: RefObject<HTMLDivElement>;
	theme: Theme;
	/** Keep the flyout open while the pointer or focus is inside it. */
	onKeepOpen: () => void;
	/** Start the close timer when the pointer or focus leaves it. */
	onScheduleClose: () => void;
	children: ReactNode;
}

/**
 * A nested submenu panel, portaled to `<body>` and positioned beside its row.
 *
 * It cannot be an `absolute; left: 100%` child of the menu: the menu carries
 * `overflow-y: auto` so a long one scrolls, and CSS computes `overflow-x` to
 * `auto` the moment the other axis is not `visible` - which clipped the whole
 * flyout out of view, so hovering "Move to Group" or "Move to Window" appeared
 * to do nothing at all.
 *
 * Portaling breaks the DOM containment the hover logic relied on (the pointer
 * entering the flyout used to be "still inside the row"), so the panel repeats
 * the row's enter/leave handlers to hold itself open.
 */
function ContextMenuFlyout({
	anchorRef,
	flyoutRef,
	theme,
	onKeepOpen,
	onScheduleClose,
	children,
}: ContextMenuFlyoutProps) {
	const { left, top, maxHeight, ready } = useAnchoredMenuPosition(flyoutRef, anchorRef, {
		gap: 4,
		placement: 'right',
		flip: true,
	});

	return createPortal(
		<div
			ref={flyoutRef}
			data-testid="session-context-flyout"
			// Above the z-50 context menu it hangs off: portaled to body, it no
			// longer inherits that menu's stacking position.
			className="fixed z-[60] py-1 rounded-md shadow-xl border whitespace-nowrap"
			style={{
				left,
				top,
				maxHeight,
				overflowY: 'auto',
				opacity: ready ? 1 : 0,
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
				minWidth: '8.75rem',
			}}
			onMouseEnter={onKeepOpen}
			onMouseLeave={onScheduleClose}
			onFocus={onKeepOpen}
			onBlur={onScheduleClose}
		>
			{children}
		</div>,
		document.body
	);
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

	// Same ordering the Left Bar uses for its group headers, so the submenu
	// reads in the order the user already scans the sidebar in.
	const sortedGroups = useMemo(
		() => [...groups].sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name)),
		[groups]
	);

	const onDismissRef = useRef(onDismiss);
	onDismissRef.current = onDismiss;

	// One flyout state machine per submenu (Move to Group, Move to Window).
	// Extracted so the two flyouts do not duplicate the hover/timeout logic.
	const moveToGroup = useFlyoutSubmenu();
	const moveToWindow = useFlyoutSubmenu();

	// The flyouts are portaled to <body>, so they are outside `menuRef` in the
	// DOM: without listing them here, mousedown on a submenu item would dismiss
	// the menu before the click ever landed on the item.
	useClickOutside([menuRef, moveToGroup.flyoutRef, moveToWindow.flyoutRef], onDismiss);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				onDismissRef.current();
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, []);

	const { left, top, maxHeight, ready } = useContextMenuPosition(menuRef, x, y);

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

	// Git actions (log / pull / push / change branch / PR). Same hook the header
	// branch pill's dropdown uses, so both entry points behave identically -
	// here they act on the right-clicked agent rather than the active one.
	const gitActions = useGitAgentActions(session);
	const voiceActions = useVoiceAgentActions(session);

	// `onCreatePR` is the worktree-child path that App already wires up; for any
	// other git agent the shared action opens the same modal for this session.
	const createPR = onCreatePR ?? (gitActions.canCreatePR ? gitActions.createPR : undefined);

	// Compute visibility for worktree sections to avoid rendering dividers without buttons
	const showWorktreeParentSection =
		(hasWorktreeChildren || session.isGitRepo) &&
		!session.parentSessionId &&
		((onQuickCreateWorktree && session.worktreeConfig) || onConfigureWorktrees);

	// Create PR now lives in the git section above, so this is Remove Worktree only.
	const showWorktreeChildSection = Boolean(
		session.parentSessionId && session.worktreeBranch && onDeleteWorktree
	);

	return (
		<div
			ref={menuRef}
			data-testid="session-context-menu"
			className="fixed z-50 py-1 rounded-md shadow-xl border whitespace-nowrap"
			style={{
				left,
				top,
				// A menu taller than the viewport pins to the top edge and runs off
				// the bottom; the container is overflow-hidden, so those items are
				// simply unreachable. Scroll instead of clipping.
				maxHeight,
				overflowY: 'auto',
				opacity: ready ? 1 : 0,
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
				minWidth: '10rem',
			}}
		>
			{/* Names the agent this menu acts on. Right-clicking a row in a long
			    Left Bar pops the menu away from that row, so without it the
			    destructive items at the bottom are unattributed. */}
			<div
				className="px-3 py-1 text-2xs uppercase tracking-wider opacity-60"
				style={{ color: theme.colors.textDim }}
				title={session.name}
			>
				<span className="block truncate max-w-[12rem]">{session.name}</span>
			</div>
			<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />

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
					ref={moveToGroup.anchorRef}
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
						<ContextMenuFlyout
							anchorRef={moveToGroup.anchorRef}
							flyoutRef={moveToGroup.flyoutRef}
							theme={theme}
							onKeepOpen={moveToGroup.open}
							onScheduleClose={moveToGroup.scheduleClose}
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
								{!session.groupId && <span className="text-2xs opacity-50">(current)</span>}
							</button>

							{groups.length > 0 && (
								<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
							)}

							{sortedGroups.map((group) => (
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
										<span className="text-2xs opacity-50">(current)</span>
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
						</ContextMenuFlyout>
					)}
				</div>
			)}

			{showMoveToWindow && (
				<div
					ref={moveToWindow.anchorRef}
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
						<ContextMenuFlyout
							anchorRef={moveToWindow.anchorRef}
							flyoutRef={moveToWindow.flyoutRef}
							theme={theme}
							onKeepOpen={moveToWindow.open}
							// Same rename guard as the row: closing mid-edit would unmount
							// the input before it could commit.
							onScheduleClose={() => {
								if (!renamingWindowId) moveToWindow.scheduleClose();
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
												<span className="text-2xs opacity-50 shrink-0">(current)</span>
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
						</ContextMenuFlyout>
					)}
				</div>
			)}

			{/* A Cappella - the same "Talk to this agent" entry the header and the
			    command palette offer, off the one hook, so the three cannot drift. */}
			{voiceActions.enabled && (
				<>
					<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
					<button
						type="button"
						onClick={() => {
							// Fire-and-forget: starting a session opens a microphone and
							// reports its own refusals, so the menu closes right away.
							void (voiceActions.hasVoiceFloor
								? voiceActions.endVoiceSession()
								: voiceActions.talkToAgent());
							onDismiss();
						}}
						className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
						style={{ color: theme.colors.textMain }}
						data-testid="session-context-talk-to-agent"
					>
						<Mic className="w-3.5 h-3.5" />
						{voiceActions.hasVoiceFloor ? 'End voice session' : 'Talk to this agent'}
						{voiceActions.wakePhrase && (
							<span className="ml-auto text-2xs opacity-60 truncate max-w-[120px]">
								&ldquo;{voiceActions.wakePhrase}&rdquo;
							</span>
						)}
					</button>
				</>
			)}

			{/* Git actions - mirrors the header branch pill's dropdown so the same
			    operations are reachable from either place. */}
			{gitActions.isGitRepo && (
				<>
					<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
					<button
						type="button"
						onClick={() => {
							gitActions.viewLog();
							onDismiss();
						}}
						className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
						style={{ color: theme.colors.textMain }}
						data-testid="session-context-git-log"
					>
						<History className="w-3.5 h-3.5" />
						View Git Log
					</button>
					<button
						type="button"
						onClick={() => {
							// Fire-and-forget: the diff is fetched asynchronously and
							// opens its own viewer, so the menu closes right away.
							void gitActions.viewDiff();
							onDismiss();
						}}
						className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center justify-between gap-4"
						style={{ color: theme.colors.textMain }}
						data-testid="session-context-git-diff"
						title={formatGitChangeSummary(gitActions.changes)}
					>
						<span className="flex items-center gap-2">
							<FileDiff className="w-3.5 h-3.5" />
							View Git Diff
						</span>
						{/* Same badge language as the ahead/behind counts below: the row
						    itself says whether there is anything to open. */}
						<GitChangeCounts
							theme={theme}
							totals={gitActions.changes}
							className="flex items-center gap-1.5 text-2xs"
						/>
					</button>
					<button
						type="button"
						onClick={() => {
							gitActions.pull();
							onDismiss();
						}}
						className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center justify-between gap-4"
						style={{ color: theme.colors.textMain }}
						data-testid="session-context-git-pull"
					>
						<span className="flex items-center gap-2">
							<ArrowDownToLine className="w-3.5 h-3.5" />
							Git Pull
						</span>
						{/* A backgrounded pull outranks the behind count, which is stale
						    until it finishes anyway. */}
						{gitActions.pullRunning ? (
							<GitRunningBadge
								theme={theme}
								className="flex items-center gap-1 text-2xs"
								testId="session-context-git-pull-running"
							/>
						) : (
							gitActions.behind > 0 && (
								<span className="flex items-center gap-0.5 text-2xs text-red-500">
									<ArrowDown className="w-3 h-3" />
									{gitActions.behind}
								</span>
							)
						)}
					</button>
					<button
						type="button"
						onClick={() => {
							gitActions.push();
							onDismiss();
						}}
						className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center justify-between gap-4"
						style={{ color: theme.colors.textMain }}
						data-testid="session-context-git-push"
					>
						<span className="flex items-center gap-2">
							<ArrowUpFromLine className="w-3.5 h-3.5" />
							Git Push
						</span>
						{gitActions.pushRunning ? (
							<GitRunningBadge
								theme={theme}
								className="flex items-center gap-1 text-2xs"
								testId="session-context-git-push-running"
							/>
						) : (
							gitActions.ahead > 0 && (
								<span className="flex items-center gap-0.5 text-2xs text-green-500">
									<ArrowUp className="w-3 h-3" />
									{gitActions.ahead}
								</span>
							)
						)}
					</button>
					<button
						type="button"
						onClick={() => {
							gitActions.switchBranch();
							onDismiss();
						}}
						className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
						style={{ color: theme.colors.textMain }}
						data-testid="session-context-change-branch"
					>
						<GitBranch className="w-3.5 h-3.5" />
						Change Branch
					</button>
					{createPR && (
						<button
							type="button"
							onClick={() => {
								createPR();
								onDismiss();
							}}
							className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center justify-between gap-2"
							style={{ color: theme.colors.accent }}
							data-testid="session-context-create-pr"
						>
							<span className="flex items-center gap-2">
								<GitPullRequest className="w-3.5 h-3.5" />
								Create Pull Request
							</span>
							{gitActions.prRunning && (
								<GitRunningBadge
									theme={theme}
									label="Creating"
									className="flex items-center gap-1 text-2xs"
									testId="session-context-create-pr-running"
									title={PR_RUNNING_TITLE}
								/>
							)}
						</button>
					)}
				</>
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

			<PluginUiItemsSlot surface="contextMenuItem" presentation="menu" onActivate={onDismiss} />

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
