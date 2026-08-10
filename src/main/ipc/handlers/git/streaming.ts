import { ipcMain } from 'electron';
import { execFileStreaming } from '../../../utils/execFile';
import { execGit } from '../../../utils/remote-git';
import { buildSshCommand } from '../../../utils/ssh-command-builder';
import { logger } from '../../../utils/logger';
import { getSshRemoteById } from '../../../stores';
import { withIpcErrorLogging } from '../../../utils/ipcHandler';
import { getShellPath } from '../../../runtime/getShellPath';
import { captureMessage } from '../../../utils/sentry';
import type { GitRunCommandResult, GitStreamingOperation } from '../../../../shared/gitUtils';
import { LOG_CONTEXT, handlerOpts } from './shared';

// Cancel callbacks for in-flight streaming git commands, keyed by runId.
const streamingGitRuns = new Map<string, () => void>();

/**
 * Build the argv for a streaming git operation.
 *
 * `--progress` is required because git suppresses transfer progress when stdout
 * isn't a TTY, which is exactly our case - without it the modal would sit blank
 * until the command finished.
 */
function buildStreamingGitArgs(
	operation: GitStreamingOperation,
	branch: string | null,
	setUpstream: boolean
): string[] {
	if (operation === 'push') {
		return setUpstream && branch
			? ['push', '--progress', '--set-upstream', 'origin', branch]
			: ['push', '--progress'];
	}
	return [operation, '--progress'];
}

/**
 * Run a network git operation, forwarding output to the requesting window as it
 * arrives and resolving once the process exits.
 */
async function runStreamingGitCommand(
	event: Electron.IpcMainInvokeEvent,
	options: {
		runId: string;
		operation: GitStreamingOperation;
		cwd: string;
		sshRemoteId?: string;
		remoteCwd?: string;
		setUpstream?: boolean;
	}
): Promise<GitRunCommandResult> {
	const { runId, operation, cwd, sshRemoteId, remoteCwd, setUpstream = false } = options;

	const sshRemote = sshRemoteId ? getSshRemoteById(sshRemoteId) : undefined;
	// The user explicitly opted into SSH - running against the local repo instead
	// would push/pull the wrong tree, so fail loudly.
	if (sshRemoteId && !sshRemote) {
		return {
			success: false,
			exitCode: 1,
			cancelled: false,
			error: `SSH remote not found: ${sshRemoteId}`,
		};
	}
	const effectiveRemoteCwd = sshRemote ? remoteCwd || cwd : undefined;

	// `--set-upstream` needs the branch name spelled out.
	let branch: string | null = null;
	if (operation === 'push' && setUpstream) {
		const branchResult = await execGit(
			['rev-parse', '--abbrev-ref', 'HEAD'],
			cwd,
			sshRemote,
			effectiveRemoteCwd
		);
		branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;
		if (!branch) {
			return {
				success: false,
				exitCode: 1,
				cancelled: false,
				error: 'Could not determine the current branch to set upstream for',
			};
		}
	}

	const gitArgs = buildStreamingGitArgs(operation, branch, setUpstream);

	// Full shell PATH so git hooks (Husky pre-push running npm, etc.) resolve
	// their tooling, and GIT_TERMINAL_PROMPT=0 so a missing credential fails
	// fast with a readable error instead of hanging on a prompt nobody can see.
	let env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
	try {
		const shellPath = await getShellPath();
		if (shellPath) env = { ...env, PATH: shellPath };
	} catch (error) {
		captureMessage(
			`git:runCommand falling back to default PATH: ${error instanceof Error ? error.message : String(error)}`,
			'warning'
		);
	}

	let command = 'git';
	let args = gitArgs;
	let spawnCwd: string | undefined = cwd;
	if (sshRemote) {
		const sshCommand = await buildSshCommand(sshRemote, {
			command: 'git',
			args: gitArgs,
			cwd: effectiveRemoteCwd,
			env: sshRemote.remoteEnv,
		});
		command = sshCommand.command;
		args = sshCommand.args;
		// The remote cwd is applied inside the SSH payload; the local process
		// shouldn't inherit a path that may not exist on this machine.
		spawnCwd = undefined;
	}

	const send = (chunk: string, stream: 'stdout' | 'stderr') => {
		if (event.sender.isDestroyed()) return;
		event.sender.send('git:commandOutput', { runId, stream, chunk });
	};

	const handle = execFileStreaming(command, args, {
		cwd: spawnCwd,
		env,
		onChunk: send,
	});
	streamingGitRuns.set(runId, handle.cancel);

	try {
		const result = await handle.result;
		const cancelled = result.exitCode === 'SIGTERM';
		return {
			success: result.exitCode === 0,
			exitCode: result.exitCode,
			cancelled,
			error:
				result.exitCode === 0 || cancelled
					? undefined
					: result.stderr.trim() || `git ${operation} exited with ${result.exitCode}`,
		};
	} finally {
		streamingGitRuns.delete(runId);
	}
}

/**
 * Register the streaming remote-sync Git IPC handlers: runCommand, cancelCommand.
 *
 * These are the only git operations the user watches happen: they hit the
 * network, can take a while, and their progress output is the point. Instead
 * of buffering, the child's stdout/stderr are forwarded chunk-by-chunk to the
 * requesting window on `git:commandOutput` so the Git command modal can
 * render a live console.
 */
export function registerStreamingHandlers(): void {
	ipcMain.handle(
		'git:runCommand',
		async (
			event,
			options: {
				runId: string;
				operation: GitStreamingOperation;
				cwd: string;
				sshRemoteId?: string;
				remoteCwd?: string;
				/** push only: also set the upstream to origin/<current branch>. */
				setUpstream?: boolean;
			}
		): Promise<GitRunCommandResult> => {
			const { runId, operation, cwd, sshRemoteId, remoteCwd, setUpstream } = options;
			try {
				return await runStreamingGitCommand(event, {
					runId,
					operation,
					cwd,
					sshRemoteId,
					remoteCwd,
					setUpstream,
				});
			} catch (error) {
				logger.error('runCommand error', LOG_CONTEXT, {
					operation,
					message: error instanceof Error ? error.message : String(error),
				});
				return {
					success: false,
					exitCode: 1,
					cancelled: false,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}
	);

	// Terminate an in-flight `git:runCommand` (the modal's Cancel button).
	ipcMain.handle(
		'git:cancelCommand',
		withIpcErrorLogging(handlerOpts('cancelCommand'), async (runId: string) => {
			const cancel = streamingGitRuns.get(runId);
			if (!cancel) return { success: false };
			cancel();
			return { success: true };
		})
	);
}
