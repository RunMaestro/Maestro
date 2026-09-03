/**
 * GitPillMenu - dropdown for the header git/branch pill.
 *
 * Clicking the pill used to jump straight to the git log. It now opens this
 * menu: branch/origin detail plus log, pull, push, branch switching, PR
 * creation, and worktree config - everything for "this agent's repo" in the one
 * control that represents it.
 *
 * This absorbed the pill's old hover card, which showed the same branch/origin
 * readout and the Configure Worktrees button. That card rendered inline and had
 * been clipped invisible since the header moved to container queries, so the
 * content lives here now and there is one surface instead of two.
 *
 * Rendered through a portal, NOT inline next to the pill - see
 * `useAnchoredMenuPosition` for why `absolute` and bare `fixed` both fail here.
 */

import { memo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
	ArrowDown,
	ArrowDownToLine,
	ArrowUp,
	ArrowUpFromLine,
	Copy,
	ExternalLink,
	FileDiff,
	GitBranch,
	GitPullRequest,
	History,
	Settings2,
} from 'lucide-react';
import { useClickOutside } from '../hooks/ui/useClickOutside';
import { useAnchoredMenuPosition } from '../hooks/ui/useAnchoredMenuPosition';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { GhostIconButton } from './ui/GhostIconButton';
import { GitChangeCounts } from './ui/GitChangeCounts';
import { GitRunningBadge } from './ui/GitRunningBadge';
import { safeClipboardWrite } from '../utils/clipboard';
import { flashCopiedToClipboard } from '../utils/flashCopiedToClipboard';
import { remoteUrlToBrowserUrl, type GitChangeTotals } from '../../shared/gitUtils';
import { openUrl } from '../utils/openUrl';
import type { Theme } from '../types';

export interface GitPillMenuProps {
	theme: Theme;
	/**
	 * The pill element. Used both to place the menu beneath it and to exclude it
	 * from click-outside, so clicking the pill again toggles instead of
	 * closing-then-reopening.
	 */
	anchorRef: React.RefObject<HTMLElement | null>;
	/**
	 * Mouse handlers that keep the menu open while the pointer is on it. The
	 * menu opens on hover, so without these it would close the moment the
	 * pointer left the pill - before it could reach any row.
	 */
	hoverHandlers?: {
		onMouseEnter: () => void;
		onMouseLeave: () => void;
	};
	/** Current branch name, shown in the detail header. */
	branch?: string;
	/** Origin remote URL, shown in the detail header when the repo has one. */
	remote?: string;
	/** Commits ahead of upstream - badged on Push. */
	ahead: number;
	/** Commits behind upstream - badged on Pull. */
	behind: number;
	/** Uncommitted-change totals - badged on View Git Diff. */
	changes: GitChangeTotals;
	/**
	 * Whether a pull / push for this repo is still running, including one whose
	 * console was dismissed with Run in Background. Badged on the matching row so
	 * the menu that started the command also reports it is still working.
	 */
	pullRunning?: boolean;
	pushRunning?: boolean;
	onViewLog: () => void;
	onViewDiff: () => void;
	onPull: () => void;
	onPush: () => void;
	onSwitchBranch: () => void;
	/** Omitted when the agent has no branch to open a PR from. */
	onCreatePR?: () => void;
	/** Omitted for worktree children, which can't own a worktree config. */
	onConfigureWorktrees?: () => void;
	onClose: () => void;
}

interface MenuRowProps {
	theme: Theme;
	icon: React.ReactNode;
	label: string;
	badge?: React.ReactNode;
	onClick: () => void;
	testId: string;
}

function MenuRow({ theme, icon, label, badge, onClick, testId }: MenuRowProps) {
	return (
		<button
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors outline-none"
			style={{ color: theme.colors.textMain }}
			data-testid={testId}
		>
			{icon}
			{label}
			{badge}
		</button>
	);
}

export const GitPillMenu = memo(function GitPillMenu({
	theme,
	anchorRef,
	hoverHandlers,
	branch,
	remote,
	ahead,
	behind,
	changes,
	pullRunning = false,
	pushRunning = false,
	onViewLog,
	onViewDiff,
	onPull,
	onPush,
	onSwitchBranch,
	onCreatePR,
	onConfigureWorktrees,
	onClose,
}: GitPillMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);
	const { left, top, ready } = useAnchoredMenuPosition(menuRef, anchorRef);

	// Escape closes the menu before any modal underneath it.
	useModalLayer(MODAL_PRIORITIES.GIT_PILL_MENU, 'Git Pill Menu', onClose);
	useClickOutside([menuRef, anchorRef], onClose, true, { delay: true, eventType: 'click' });

	const iconStyle = { color: theme.colors.textDim };
	const browserUrl = remote ? remoteUrlToBrowserUrl(remote) : null;

	return createPortal(
		<div
			ref={menuRef}
			className="fixed z-[100] rounded shadow-xl overflow-hidden whitespace-nowrap select-none"
			style={{
				left,
				top,
				opacity: ready ? 1 : 0,
				backgroundColor: theme.colors.bgSidebar,
				border: `1px solid ${theme.colors.border}`,
				minWidth: '12rem',
			}}
			role="menu"
			data-testid="git-pill-menu"
			{...hoverHandlers}
		>
			{/* Branch / origin detail - inherited from the pill's retired hover card.
			    Text is selectable here even though the menu as a whole isn't, since
			    these are values you may want to read or grab. */}
			{(branch || remote) && (
				<div
					className="px-3 py-2 space-y-1.5 border-b select-text"
					style={{
						backgroundColor: theme.colors.bgActivity,
						borderColor: theme.colors.border,
					}}
					data-testid="git-pill-menu-detail"
				>
					{branch && (
						<div className="flex items-center gap-2">
							<span
								className="text-2xs uppercase font-bold w-12 shrink-0"
								style={{ color: theme.colors.textDim }}
							>
								Branch
							</span>
							<span
								className="text-xs font-mono font-medium truncate"
								style={{ color: theme.colors.textMain }}
								title={branch}
							>
								{branch}
							</span>
							<GhostIconButton
								onClick={async (e) => {
									e.stopPropagation();
									if (await safeClipboardWrite(branch)) {
										flashCopiedToClipboard(branch, 'Branch Name Copied');
									}
								}}
								title="Copy branch name"
								ariaLabel="Copy branch name"
								className="ml-auto shrink-0"
							>
								<Copy className="w-3 h-3" style={iconStyle} />
							</GhostIconButton>
						</div>
					)}

					{remote && (
						<div className="flex items-center gap-2">
							<span
								className="text-2xs uppercase font-bold w-12 shrink-0"
								style={{ color: theme.colors.textDim }}
							>
								Origin
							</span>
							<button
								onClick={(e) => {
									e.stopPropagation();
									if (browserUrl) openUrl(browserUrl);
								}}
								disabled={!browserUrl}
								className="text-xs font-mono truncate text-left hover:underline disabled:no-underline disabled:cursor-default"
								style={{ color: theme.colors.textMain }}
								title={browserUrl ? `Open ${remote}` : remote}
								data-testid="git-pill-menu-open-remote"
							>
								{remote.replace(/^https?:\/\//, '').replace(/\.git$/, '')}
							</button>
							{browserUrl && <ExternalLink className="w-3 h-3 shrink-0" style={iconStyle} />}
							<GhostIconButton
								onClick={async (e) => {
									e.stopPropagation();
									if (await safeClipboardWrite(remote)) {
										flashCopiedToClipboard(remote, 'Remote URL Copied');
									}
								}}
								title="Copy remote URL"
								ariaLabel="Copy remote URL"
								className="ml-auto shrink-0"
							>
								<Copy className="w-3 h-3" style={iconStyle} />
							</GhostIconButton>
						</div>
					)}
				</div>
			)}

			<div className="p-1">
				<MenuRow
					theme={theme}
					testId="git-pill-menu-log"
					icon={<History className="w-3.5 h-3.5" style={iconStyle} />}
					label="View Git Log"
					onClick={onViewLog}
				/>
				<MenuRow
					theme={theme}
					testId="git-pill-menu-diff"
					icon={<FileDiff className="w-3.5 h-3.5" style={iconStyle} />}
					label="View Git Diff"
					badge={
						<GitChangeCounts
							theme={theme}
							totals={changes}
							className="ml-auto flex items-center gap-1.5 text-2xs"
						/>
					}
					onClick={onViewDiff}
				/>
				<MenuRow
					theme={theme}
					testId="git-pill-menu-pull"
					icon={<ArrowDownToLine className="w-3.5 h-3.5" style={iconStyle} />}
					label="Git Pull"
					badge={
						// A run in flight outranks the behind count, which is stale until
						// it finishes anyway.
						pullRunning ? (
							<GitRunningBadge
								theme={theme}
								className="ml-auto flex items-center gap-1 text-2xs"
								testId="git-pill-menu-pull-running"
							/>
						) : behind > 0 ? (
							<span className="ml-auto flex items-center gap-0.5 text-2xs text-red-500">
								<ArrowDown className="w-3 h-3" />
								{behind}
							</span>
						) : undefined
					}
					onClick={onPull}
				/>
				<MenuRow
					theme={theme}
					testId="git-pill-menu-push"
					icon={<ArrowUpFromLine className="w-3.5 h-3.5" style={iconStyle} />}
					label="Git Push"
					badge={
						pushRunning ? (
							<GitRunningBadge
								theme={theme}
								className="ml-auto flex items-center gap-1 text-2xs"
								testId="git-pill-menu-push-running"
							/>
						) : ahead > 0 ? (
							<span className="ml-auto flex items-center gap-0.5 text-2xs text-green-500">
								<ArrowUp className="w-3 h-3" />
								{ahead}
							</span>
						) : undefined
					}
					onClick={onPush}
				/>
				<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
				<MenuRow
					theme={theme}
					testId="git-pill-menu-switch-branch"
					icon={<GitBranch className="w-3.5 h-3.5" style={iconStyle} />}
					label="Change Branch"
					onClick={onSwitchBranch}
				/>
				{onCreatePR && (
					<MenuRow
						theme={theme}
						testId="git-pill-menu-create-pr"
						icon={<GitPullRequest className="w-3.5 h-3.5" style={iconStyle} />}
						label="Create Pull Request"
						onClick={onCreatePR}
					/>
				)}

				{/* Worktree config - the other half of the retired hover card. This is
				    the header's only path to it; the Left Bar menu has its own. */}
				{onConfigureWorktrees && (
					<>
						<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
						<MenuRow
							theme={theme}
							testId="git-pill-menu-configure-worktrees"
							icon={<Settings2 className="w-3.5 h-3.5" style={iconStyle} />}
							label="Configure Worktrees"
							onClick={onConfigureWorktrees}
						/>
					</>
				)}
			</div>
		</div>,
		document.body
	);
});

export default GitPillMenu;
