import type { Session } from '../../../types';
import type { NotifyToastInput } from '../../../stores/notificationStore';
import { captureException } from '../../../utils/sentry';
import type { QuickAction } from '../types';

interface BuildGitWorktreeCommandsArgs {
	activeSession: Session | undefined;
	sessions: Session[];
	setGitDiffPreview: (diff: string | null) => void;
	setGitLogOpen: (open: boolean) => void;
	setQuickActionOpen: (open: boolean) => void;
	onQuickCreateWorktree?: (session: Session) => void;
	onOpenCreatePR?: (session: Session) => void;
	onRefreshGitFileState?: () => Promise<void>;
	/** Re-poll git status across sessions. Called when `git diff` returns empty
	 * despite the widget advertising changes, so the stale stats clear immediately. */
	onRefreshGitStatus?: () => Promise<void>;
	shortcuts: {
		viewGitDiff?: QuickAction['shortcut'];
		viewGitLog?: QuickAction['shortcut'];
	};
	gitService: {
		getDiff: (cwd: string, files?: string[], sshRemoteId?: string) => Promise<{ diff?: string }>;
		getRemoteBrowserUrl: (cwd: string) => Promise<string | null>;
	};
	notifyCenterFlash: (args: { message: string; color: 'theme' }) => void;
	notifyToast: (args: NotifyToastInput) => void;
	openUrl: (url: string) => void;
	logger: {
		error: (message: string, context?: string, error?: unknown) => void;
	};
}

function getGitCwd(session: Session): string {
	return session.inputMode === 'terminal' ? session.shellCwd || session.cwd : session.cwd;
}

function getSshRemoteId(session: Session): string | undefined {
	return (
		session.sshRemoteId ||
		(session.sessionSshRemoteConfig?.enabled
			? session.sessionSshRemoteConfig.remoteId
			: undefined) ||
		undefined
	);
}

export function buildGitWorktreeCommands({
	activeSession,
	sessions,
	setGitDiffPreview,
	setGitLogOpen,
	setQuickActionOpen,
	onQuickCreateWorktree,
	onOpenCreatePR,
	onRefreshGitFileState,
	onRefreshGitStatus,
	shortcuts,
	gitService,
	notifyCenterFlash,
	notifyToast,
	openUrl,
	logger,
}: BuildGitWorktreeCommandsArgs): QuickAction[] {
	if (!activeSession) return [];
	const commands: QuickAction[] = [];

	if (activeSession.isGitRepo) {
		commands.push({
			id: 'gitDiff',
			label: 'View Git Diff',
			shortcut: shortcuts.viewGitDiff,
			action: async () => {
				const diff = await gitService.getDiff(
					getGitCwd(activeSession),
					undefined,
					getSshRemoteId(activeSession)
				);
				if (diff.diff) {
					setGitDiffPreview(diff.diff);
				} else {
					notifyCenterFlash({ message: 'No diff to examine', color: 'theme' });
					// Polling cache said there were changes but `git diff` is empty -
					// re-sync so the widget stops advertising stale stats.
					void onRefreshGitStatus?.();
				}
				setQuickActionOpen(false);
			},
		});

		commands.push({
			id: 'gitLog',
			label: 'View Git Log',
			shortcut: shortcuts.viewGitLog,
			action: () => {
				setGitLogOpen(true);
				setQuickActionOpen(false);
			},
		});

		commands.push({
			id: 'openRepo',
			label: 'Open Repository in Browser',
			action: async () => {
				try {
					const browserUrl = await gitService.getRemoteBrowserUrl(getGitCwd(activeSession));
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

	if (activeSession.parentSessionId && activeSession.worktreeBranch && onOpenCreatePR) {
		commands.push({
			id: 'createPR',
			label: `Create Pull Request: ${activeSession.worktreeBranch}`,
			subtext: 'Open PR from this worktree branch',
			action: () => {
				onOpenCreatePR(activeSession);
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
