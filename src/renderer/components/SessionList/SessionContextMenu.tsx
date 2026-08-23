import { useState, useEffect, useMemo, useRef } from 'react';
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
} from 'lucide-react';
import type { Group, Session, Theme } from '../../types';
import { useClickOutside, useContextMenuPosition } from '../../hooks';
import { compareNamesIgnoringEmojis } from '../../../shared/emojiUtils';
import { useGitAgentActions } from '../../hooks/git/useGitAgentActions';
import { GitChangeCounts } from '../ui/GitChangeCounts';
import { GitRunningBadge } from '../ui/GitRunningBadge';
import { formatGitChangeSummary } from '../../../shared/gitUtils';
import { safeClipboardWrite } from '../../utils/clipboard';
import { flashCopiedToClipboard } from '../../utils/flashCopiedToClipboard';

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
	onConfigureCue?: () => void;
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
	onConfigureCue,
}: SessionContextMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);
	const moveToGroupRef = useRef<HTMLDivElement>(null);
	const submenuTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [showMoveSubmenu, setShowMoveSubmenu] = useState(false);
	const [submenuPosition, setSubmenuPosition] = useState<{
		vertical: 'below' | 'above';
		horizontal: 'right' | 'left';
	}>({ vertical: 'below', horizontal: 'right' });

	// Same ordering the Left Bar uses for its group headers, so the submenu
	// reads in the order the user already scans the sidebar in.
	const sortedGroups = useMemo(
		() => [...groups].sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name)),
		[groups]
	);

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

	// Cleanup submenu timeout on unmount
	useEffect(() => {
		return () => {
			if (submenuTimeoutRef.current) {
				clearTimeout(submenuTimeoutRef.current);
				submenuTimeoutRef.current = null;
			}
		};
	}, []);

	const { left, top, ready } = useContextMenuPosition(menuRef, x, y);

	const handleMoveToGroupHover = () => {
		if (submenuTimeoutRef.current) {
			clearTimeout(submenuTimeoutRef.current);
			submenuTimeoutRef.current = null;
		}
		setShowMoveSubmenu(true);

		if (moveToGroupRef.current) {
			const rect = moveToGroupRef.current.getBoundingClientRect();
			const itemHeight = 28;
			const submenuHeight = (groups.length + 1) * itemHeight + 16 + (groups.length > 0 ? 8 : 0);
			const submenuWidth = 160;
			const spaceBelow = window.innerHeight - rect.top;
			const spaceRight = window.innerWidth - rect.right;

			const vertical = spaceBelow < submenuHeight && rect.top > submenuHeight ? 'above' : 'below';
			const horizontal = spaceRight < submenuWidth && rect.left > submenuWidth ? 'left' : 'right';

			setSubmenuPosition({ vertical, horizontal });
		}
	};

	const handleMoveToGroupLeave = () => {
		if (submenuTimeoutRef.current) {
			clearTimeout(submenuTimeoutRef.current);
		}
		submenuTimeoutRef.current = setTimeout(() => {
			setShowMoveSubmenu(false);
			submenuTimeoutRef.current = null;
		}, 300);
	};

	// Git actions (log / pull / push / change branch / PR). Same hook the header
	// branch pill's dropdown uses, so both entry points behave identically -
	// here they act on the right-clicked agent rather than the active one.
	const gitActions = useGitAgentActions(session);

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

			{!session.parentSessionId && (
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

			{!session.parentSessionId && (
				<div
					ref={moveToGroupRef}
					className="relative"
					tabIndex={0}
					onMouseEnter={handleMoveToGroupHover}
					onMouseLeave={handleMoveToGroupLeave}
					onFocus={handleMoveToGroupHover}
					onBlur={handleMoveToGroupLeave}
					onKeyDown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							handleMoveToGroupHover();
						} else if (e.key === 'Escape' && showMoveSubmenu) {
							e.stopPropagation();
							setShowMoveSubmenu(false);
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

					{showMoveSubmenu && (
						<div
							className="absolute py-1 rounded-md shadow-xl border whitespace-nowrap"
							style={{
								backgroundColor: theme.colors.bgSidebar,
								borderColor: theme.colors.border,
								minWidth: '8.75rem',
								...(submenuPosition.vertical === 'above' ? { bottom: 0 } : { top: 0 }),
								...(submenuPosition.horizontal === 'left'
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
							className="flex items-center gap-1.5 text-[10px]"
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
								className="flex items-center gap-1 text-[10px]"
								testId="session-context-git-pull-running"
							/>
						) : (
							gitActions.behind > 0 && (
								<span className="flex items-center gap-0.5 text-[10px] text-red-500">
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
								className="flex items-center gap-1 text-[10px]"
								testId="session-context-git-push-running"
							/>
						) : (
							gitActions.ahead > 0 && (
								<span className="flex items-center gap-0.5 text-[10px] text-green-500">
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
							className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
							style={{ color: theme.colors.accent }}
							data-testid="session-context-create-pr"
						>
							<GitPullRequest className="w-3.5 h-3.5" />
							Create Pull Request
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

			{!session.parentSessionId && (
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
