import { randomUUID } from 'crypto';
import { ipcMain } from 'electron';
import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';
import type { StoredSession } from '../../stores/types';
import { execGit } from '../../utils/remote-git';
import { getSshRemoteById } from '../../stores';
import { parseGitBranches } from '../../../shared/gitUtils';
import { requestFromRenderer } from './remoteRequest';
import {
	normalizeDiffReviewCommandResult,
	type DiffReviewCommandRequest,
	type DiffReviewCommandResult,
} from '../../../shared/diffReviewCommands';

/**
 * `add`, `list` and `send` run `git diff` in the renderer, over SSH for a
 * remote agent, before answering; the 3s default would fail a large repo.
 */
const DIFF_REVIEW_TIMEOUT_MS = 30_000;

export function registerGitCallbacks(
	server: WebServer,
	deps: Pick<
		WebServerFactoryDependencies,
		'getMainWindow' | 'sessionsStore' | 'getWindowForSession'
	>
): void {
	const { getMainWindow, sessionsStore, getWindowForSession } = deps;

	// Diff review verbs are a ROUND TRIP: the caller is told which comment was
	// added or removed, what is pending, or what the agent was sent. The request
	// goes to the window that owns the agent, because the viewer that draws the
	// pending comments, and the queue the review lands in, are that renderer's.
	server.setDiffReviewCommandCallback(async (request: DiffReviewCommandRequest) => {
		const targetWindow = getWindowForSession?.(request.sessionId) ?? getMainWindow();
		if (!targetWindow || !isWebContentsAvailable(targetWindow)) {
			logger.warn('No window is available for diffReviewCommand', 'WebServer');
			return { success: false, error: 'Maestro window is not available' };
		}
		return requestFromRenderer<DiffReviewCommandResult>(targetWindow, 'remote:diffReviewCommand', {
			fallback: { success: false, error: 'Maestro did not answer the diff review request' },
			parse: normalizeDiffReviewCommandResult,
			timeoutMs: DIFF_REVIEW_TIMEOUT_MS,
			args: [request],
		});
	});

	// Set up callback for web server to get git status
	// Uses IPC request-response pattern with timeout
	server.setGetGitStatusCallback(async (sessionId: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for getGitStatus', 'WebServer');
			return { branch: '', files: [], ahead: 0, behind: 0 };
		}

		return new Promise((resolve) => {
			const responseChannel = `remote:getGitStatus:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result || { branch: '', files: [], ahead: 0, behind: 0 });
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for getGitStatus', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve({ branch: '', files: [], ahead: 0, behind: 0 });
				return;
			}
			mainWindow.webContents.send('remote:getGitStatus', sessionId, responseChannel);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(`getGitStatus callback timed out for session ${sessionId}`, 'WebServer');
				resolve({ branch: '', files: [], ahead: 0, behind: 0 });
			}, 10000);
		});
	});

	// Set up callback for web server to get git diff
	// Uses IPC request-response pattern with timeout
	server.setGetGitDiffCallback(async (sessionId: string, filePath?: string) => {
		const mainWindow = getMainWindow();
		if (!mainWindow) {
			logger.warn('mainWindow is null for getGitDiff', 'WebServer');
			return { diff: '', files: [] };
		}

		return new Promise((resolve) => {
			const responseChannel = `remote:getGitDiff:response:${randomUUID()}`;
			let resolved = false;

			const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
				if (resolved) return;
				resolved = true;
				clearTimeout(timeoutId);
				resolve(result || { diff: '', files: [] });
			};

			ipcMain.once(responseChannel, handleResponse);
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for getGitDiff', 'WebServer');
				ipcMain.removeListener(responseChannel, handleResponse);
				resolve({ diff: '', files: [] });
				return;
			}
			mainWindow.webContents.send('remote:getGitDiff', sessionId, filePath, responseChannel);

			const timeoutId = setTimeout(() => {
				if (resolved) return;
				resolved = true;
				ipcMain.removeListener(responseChannel, handleResponse);
				logger.warn(`getGitDiff callback timed out for session ${sessionId}`, 'WebServer');
				resolve({ diff: '', files: [] });
			}, 10000);
		});
	});

	// Resolve a session's effective git execution context (local cwd + optional
	// SSH remote). Used by both Run-in-Worktree callbacks below. When SSH is
	// enabled but the configured remote can't be resolved we fail loudly -
	// silently falling back to local git would return wrong branch/worktree
	// data for an SSH-backed session and leak the run to the wrong machine.
	const resolveSessionGitContext = (
		session: StoredSession
	): { sshRemote: ReturnType<typeof getSshRemoteById>; remoteCwd: string | undefined } => {
		if (!session.sessionSshRemoteConfig?.enabled) {
			return { sshRemote: undefined, remoteCwd: undefined };
		}
		const sshRemoteId = session.sessionSshRemoteConfig.remoteId;
		if (!sshRemoteId) {
			throw new Error(`SSH remote is enabled but remoteId is missing for session ${session.id}`);
		}
		const sshRemote = getSshRemoteById(sshRemoteId);
		if (!sshRemote) {
			throw new Error(`SSH remote not found: ${sshRemoteId}`);
		}
		return { sshRemote, remoteCwd: session.cwd };
	};

	// Set up callback for web server to enumerate branches for the Run-in-Worktree
	// base-branch picker on mobile. Executes git directly in the main process
	// (no renderer round-trip needed because cwd + SSH config live in sessionsStore).
	// Unexpected exec/SSH failures are rethrown so callers (and Sentry) see the
	// real error instead of a silently empty branch list.
	server.setGetGitBranchesForSessionCallback(async (sessionId: string) => {
		const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
		const session = sessions.find((s) => s.id === sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		const { sshRemote, remoteCwd } = resolveSessionGitContext(session);

		const [branchesResult, currentBranchResult] = await Promise.all([
			execGit(['branch', '-a', '--format=%(refname:short)'], session.cwd, sshRemote, remoteCwd),
			execGit(['rev-parse', '--abbrev-ref', 'HEAD'], session.cwd, sshRemote, remoteCwd),
		]);

		// `execGit` returns `exitCode: number | string`. A string exit code (e.g.
		// 'ENOENT', 'EPERM') means git never even ran - that's a real failure we
		// want surfaced to Sentry, not a fake "empty repo" result. A numeric
		// non-zero exit code is a legitimate "not a git repo" / "no branches"
		// signal and maps to empty results.
		if (typeof branchesResult.exitCode !== 'number') {
			throw new Error(
				branchesResult.stderr || `git branch failed: ${String(branchesResult.exitCode)}`
			);
		}
		if (typeof currentBranchResult.exitCode !== 'number') {
			throw new Error(
				currentBranchResult.stderr ||
					`git rev-parse failed: ${String(currentBranchResult.exitCode)}`
			);
		}

		const branches = branchesResult.exitCode === 0 ? parseGitBranches(branchesResult.stdout) : [];
		const currentBranch =
			currentBranchResult.exitCode === 0
				? currentBranchResult.stdout.trim() || undefined
				: undefined;

		return { branches, currentBranch };
	});

	// List existing worktrees for a session - used by mobile Run-in-Worktree
	// to offer "use existing" alongside "create new". Same error-propagation
	// contract as getGitBranchesForSession above.
	server.setListWorktreesForSessionCallback(async (sessionId: string) => {
		const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
		const session = sessions.find((s) => s.id === sessionId);
		if (!session) {
			throw new Error(`Session not found: ${sessionId}`);
		}

		const { sshRemote, remoteCwd } = resolveSessionGitContext(session);

		const result = await execGit(
			['worktree', 'list', '--porcelain'],
			session.cwd,
			sshRemote,
			remoteCwd
		);
		// String exitCode = git never ran (ENOENT/EPERM/etc.) - surface to Sentry.
		if (typeof result.exitCode !== 'number') {
			throw new Error(result.stderr || `git worktree list failed: ${String(result.exitCode)}`);
		}
		if (result.exitCode !== 0) {
			// Numeric non-zero: not a git repo or worktrees unsupported - empty
			// list is the right answer here.
			return { worktrees: [] };
		}

		const worktrees: Array<{ path: string; branch: string | null; isBare: boolean }> = [];
		let current: { path?: string; branch?: string | null; isBare?: boolean } = {};
		for (const line of result.stdout.split('\n')) {
			if (line.startsWith('worktree ')) {
				current.path = line.substring(9);
			} else if (line.startsWith('branch ')) {
				current.branch = line.substring(7).replace('refs/heads/', '');
			} else if (line === 'bare') {
				current.isBare = true;
			} else if (line === 'detached') {
				current.branch = null;
			} else if (line === '' && current.path) {
				worktrees.push({
					path: current.path,
					branch: current.branch ?? null,
					isBare: current.isBare || false,
				});
				current = {};
			}
		}
		if (current.path) {
			worktrees.push({
				path: current.path,
				branch: current.branch ?? null,
				isBare: current.isBare || false,
			});
		}
		return { worktrees };
	});
}
