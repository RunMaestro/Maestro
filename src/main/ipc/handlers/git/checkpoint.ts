import { ipcMain } from 'electron';
import { getSshRemoteById } from '../../../stores';
import { withIpcErrorLogging } from '../../../utils/ipcHandler';
import {
	createCheckpoint,
	deleteCheckpoint,
	listCheckpoints,
	restoreCheckpoint,
	type CheckpointTarget,
} from '../../../git/checkpoints';
import type {
	CheckpointListResult,
	CheckpointResult,
	CreateCheckpointOptions,
	DeleteCheckpointResult,
	RestoreCheckpointResult,
} from '../../../../shared/gitCheckpoints';
import { handlerOpts } from './shared';

/**
 * Resolve the SSH remote for a checkpoint operation.
 *
 * Returns an error rather than falling back to local execution when the id
 * can't be resolved. Silently checkpointing the desktop's own filesystem
 * instead of the remote one the user configured would snapshot the wrong tree
 * and, worse, offer to restore it over the right one later.
 */
function resolveTarget(
	cwd: string,
	sshRemoteId?: string,
	remoteCwd?: string
): { target: CheckpointTarget } | { error: string } {
	if (!sshRemoteId) return { target: { cwd } };
	const sshRemote = getSshRemoteById(sshRemoteId);
	if (!sshRemote) return { error: `SSH remote not found: ${sshRemoteId}` };
	return { target: { cwd, sshRemote, remoteCwd: remoteCwd || cwd } };
}

/**
 * Register the worktree-checkpoint IPC handlers.
 *
 * `git:checkpointCreate`, `checkpointList`, `checkpointRestore`,
 * `checkpointDelete`. The mechanism lives in `src/main/git/checkpoints.ts`;
 * these are the thin SSH-resolving wrappers around it.
 */
export function registerCheckpointHandlers(): void {
	ipcMain.handle(
		'git:checkpointCreate',
		withIpcErrorLogging(
			handlerOpts('checkpointCreate', true),
			async (
				cwd: string,
				options?: CreateCheckpointOptions,
				sshRemoteId?: string,
				remoteCwd?: string
			): Promise<CheckpointResult> => {
				const resolved = resolveTarget(cwd, sshRemoteId, remoteCwd);
				if ('error' in resolved) return { success: false, error: resolved.error };
				return createCheckpoint(resolved.target, options ?? {});
			}
		)
	);

	ipcMain.handle(
		'git:checkpointList',
		withIpcErrorLogging(
			handlerOpts('checkpointList'),
			async (
				cwd: string,
				options?: { allWorktrees?: boolean },
				sshRemoteId?: string,
				remoteCwd?: string
			): Promise<CheckpointListResult> => {
				const resolved = resolveTarget(cwd, sshRemoteId, remoteCwd);
				if ('error' in resolved) {
					return { success: false, checkpoints: [], error: resolved.error };
				}
				return listCheckpoints(resolved.target, options ?? {});
			}
		)
	);

	ipcMain.handle(
		'git:checkpointRestore',
		withIpcErrorLogging(
			handlerOpts('checkpointRestore', true),
			async (
				cwd: string,
				checkpointId: string,
				sshRemoteId?: string,
				remoteCwd?: string
			): Promise<RestoreCheckpointResult> => {
				const resolved = resolveTarget(cwd, sshRemoteId, remoteCwd);
				if ('error' in resolved) return { success: false, error: resolved.error };
				// The safety checkpoint is deliberately NOT exposed as an option over
				// IPC. Every caller that can reach this is a UI gesture or a CLI verb,
				// and neither has taken its own snapshot - so there is no legitimate
				// caller for the un-undoable form.
				return restoreCheckpoint(resolved.target, checkpointId);
			}
		)
	);

	ipcMain.handle(
		'git:checkpointDelete',
		withIpcErrorLogging(
			handlerOpts('checkpointDelete', true),
			async (
				cwd: string,
				checkpointId: string,
				sshRemoteId?: string,
				remoteCwd?: string
			): Promise<DeleteCheckpointResult> => {
				const resolved = resolveTarget(cwd, sshRemoteId, remoteCwd);
				if ('error' in resolved) return { success: false, error: resolved.error };
				return deleteCheckpoint(resolved.target, checkpointId);
			}
		)
	);
}
