import type { Session } from '../../../types';
import type { NotifyToastInput } from '../../../stores/notificationStore';
import type { GitAgentActions } from '../../../hooks/git/useGitAgentActions';
import { resolveGitCwd } from '../../../hooks/git/useGitAgentActions';
import { formatGitChangeSummary } from '../../../../shared/gitUtils';
import { captureException } from '../../../utils/sentry';
import type { QuickAction } from '../types';

interface BuildGitWorktreeCommandsArgs {
	activeSession: Session | undefined;
	sessions: Session[];
	/**
	 * The same action set the header branch pill and the Left Bar right-click
	 * menu use. Every git entry below delegates to it, so the palette can't
	 * drift from the menus - it IS the third surface, not a reimplementation.
	 */
	gitActions: GitAgentActions;
	setQuickActionOpen: (open: boolean) => void;
	onQuickCreateWorktree?: (session: Session) => void;
	onOpenCreatePR?: (session: Session) => void;
	onRefreshGitFileState?: () => Promise<void>;
	shortcuts: {
		viewGitDiff?: QuickAction['shortcut'];
		viewGitLog?: QuickAction['shortcut'];
	};
	gitService: {
		getRemoteBrowserUrl: (cwd: string) => Promise<string | null>;
	};
	notifyToast: (args: NotifyToastInput) => void;
	openUrl: (url: string) => void;
	logger: {
		error: (message: string, context?: string, error?: unknown) => void;
	};
}

export function buildGitWorktreeCommands({
	activeSession,
	sessions,
	gitActions,
	setQuickActionOpen,
	onQuickCreateWorktree,
	onOpenCreatePR,
	onRefreshGitFileState,
	shortcuts,
	gitService,
	notifyToast,
	openUrl,
	logger,
}: BuildGitWorktreeCommandsArgs): QuickAction[] {
	if (!activeSession) return [];
	const commands: QuickAction[] = [];

	if (activeSession.isGitRepo) {
		// Mirrors the git menu order so the palette reads the same as the menus.
		commands.push({
			id: 'gitLog',
			label: 'View Git Log',
			shortcut: shortcuts.viewGitLog,
			action: () => {
				gitActions.viewLog();
				setQuickActionOpen(false);
			},
		});

		commands.push({
			id: 'gitDiff',
			label: 'View Git Diff',
			// Says up front whether the diff has anything in it, the same thing the
			// badge on the menu rows says.
			subtext: formatGitChangeSummary(gitActions.changes),
			shortcut: shortcuts.viewGitDiff,
			action: () => {
				// Fire-and-forget: viewDiff opens its own modal (or flashes when the
				// tree is clean), so the palette shouldn't linger while git runs.
				void gitActions.viewDiff();
				setQuickActionOpen(false);
			},
		});

		commands.push({
			id: 'gitPull',
			label: 'Git Pull',
			subtext:
				gitActions.behind > 0
					? `${gitActions.behind} commit${gitActions.behind === 1 ? '' : 's'} behind`
					: 'Pull from origin',
			action: () => {
				gitActions.pull();
				setQuickActionOpen(false);
			},
		});

		commands.push({
			id: 'gitPush',
			label: 'Git Push',
			subtext:
				gitActions.ahead > 0
					? `${gitActions.ahead} commit${gitActions.ahead === 1 ? '' : 's'} ahead`
					: 'Push to origin',
			action: () => {
				gitActions.push();
				setQuickActionOpen(false);
			},
		});

		commands.push({
			id: 'changeBranch',
			label: 'Change Branch',
			subtext: gitActions.branch ? `Currently on ${gitActions.branch}` : 'Switch to another branch',
			action: () => {
				gitActions.switchBranch();
				setQuickActionOpen(false);
			},
		});

		commands.push({
			id: 'openRepo',
			label: 'Open Repository in Browser',
			action: async () => {
				try {
					const browserUrl = await gitService.getRemoteBrowserUrl(resolveGitCwd(activeSession));
					if (browserUrl) {
						openUrl(browserUrl);
					} else {
						notifyToast({
							type: 'error',
							title: 'No Remote URL',
							message: 'Could not find a remote URL for this repository',
						});
					}
				} catch (error) {
					logger.error('Failed to open repository in browser:', undefined, error);
					notifyToast({
						type: 'error',
						title: 'Error',
						message:
							error instanceof Error ? error.message : 'Failed to open repository in browser',
					});
					// Network/git failures are recoverable - capture for tracking but keep modal close path.
					captureException(error);
				}
				setQuickActionOpen(false);
			},
		});
	}

	if (activeSession.isGitRepo && onQuickCreateWorktree) {
		commands.push({
			id: 'createWorktree',
			label: 'Create Worktree',
			subtext: activeSession.parentSessionId
				? `New worktree under ${sessions.find((session) => session.id === activeSession.parentSessionId)?.name || 'parent'}`
				: 'Create a new git worktree branch',
			action: () => {
				const targetSession = activeSession.parentSessionId
					? sessions.find((session) => session.id === activeSession.parentSessionId) ||
						activeSession
					: activeSession;
				onQuickCreateWorktree(targetSession);
				setQuickActionOpen(false);
			},
		});
	}

	// Any agent on a branch can open a PR, not just worktree children - matching
	// what the git menus offer. The explicit handler still wins for worktree
	// children, since App wires extra behavior into it.
	if (gitActions.canCreatePR) {
		const isWorktreeChild = Boolean(activeSession.parentSessionId && activeSession.worktreeBranch);
		commands.push({
			id: 'createPR',
			label: gitActions.branch
				? `Create Pull Request: ${gitActions.branch}`
				: 'Create Pull Request',
			subtext: isWorktreeChild
				? 'Open PR from this worktree branch'
				: 'Open PR from the current branch',
			action: () => {
				if (isWorktreeChild && onOpenCreatePR) {
					onOpenCreatePR(activeSession);
				} else {
					gitActions.createPR();
				}
				setQuickActionOpen(false);
			},
		});
	}

	if (gitActions.canConfigureWorktrees) {
		commands.push({
			id: 'configureWorktrees',
			label: 'Configure Worktrees',
			subtext: 'Set the worktree directory and watch options',
			action: () => {
				gitActions.configureWorktrees();
				setQuickActionOpen(false);
			},
		});
	}

	if (onRefreshGitFileState) {
		commands.push({
			id: 'refreshGitFileState',
			label: 'Refresh Files, Git, History',
			subtext: 'Reload file tree, git status, and history',
			action: async () => {
				await onRefreshGitFileState();
				setQuickActionOpen(false);
			},
		});
	}

	return commands;
}
