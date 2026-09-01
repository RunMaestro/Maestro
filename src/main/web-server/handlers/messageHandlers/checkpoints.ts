/**
 * Worktree checkpoint WebSocket message handlers.
 *
 * Backs `maestro-cli worktree checkpoint create | list | restore | delete`.
 *
 * Unlike most handlers in this directory these do NOT round-trip through the
 * renderer. A checkpoint is a pure git operation on a path, and the two inputs
 * it needs - the agent's working directory and its SSH remote - are both in the
 * main-process sessions store already. Bouncing off the renderer would add a
 * callback registration and a hop without adding an answer, and it would make
 * the CLI verbs fail whenever the window is closed but the app is running.
 */

import { getSessionsStore, getSshRemoteById } from '../../../stores';
import {
	createCheckpoint,
	deleteCheckpoint,
	listCheckpoints,
	restoreCheckpoint,
	type CheckpointTarget,
} from '../../../git/checkpoints';
import type { CheckpointOrigin } from '../../../../shared/gitCheckpoints';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/**
 * Resolve an agent id to the tree its checkpoints act on.
 *
 * Mirrors the renderer's `resolveGitCwd` / `resolveGitSshRemoteId`: a
 * terminal-mode agent's live shell cwd wins over its configured one, and the
 * SSH remote can live in either the legacy top-level field or the per-session
 * config. Getting either wrong would snapshot a different directory than the
 * one the desktop shows for that agent.
 */
function resolveCheckpointTarget(
	sessionId: string
): { target: CheckpointTarget } | { error: string } {
	const sessions = getSessionsStore().get('sessions', []);
	const session = sessions.find((s) => s.id === sessionId);
	if (!session) return { error: `Agent not found: ${sessionId}` };

	const cwd = session.inputMode === 'terminal' ? session.shellCwd || session.cwd : session.cwd;
	if (!cwd) return { error: `Agent ${sessionId} has no working directory` };

	const sshRemoteId: string | undefined =
		session.sshRemoteId ||
		(session.sessionSshRemoteConfig?.enabled
			? session.sessionSshRemoteConfig.remoteId
			: undefined) ||
		undefined;

	if (!sshRemoteId) return { target: { cwd } };

	const sshRemote = getSshRemoteById(sshRemoteId);
	// Fail loudly. The user opted this agent into SSH, so quietly checkpointing
	// the local filesystem instead would snapshot the wrong tree and later offer
	// to restore it over the right one.
	if (!sshRemote) return { error: `SSH remote not found: ${sshRemoteId}` };

	const remoteCwd: string = session.sessionSshRemoteConfig?.remoteCwd || cwd;
	return { target: { cwd, sshRemote, remoteCwd } };
}

function isCheckpointOrigin(value: unknown): value is CheckpointOrigin {
	return value === 'manual' || value === 'auto-run' || value === 'pre-restore';
}

/** Handle worktree_checkpoint_create - snapshot an agent's working tree. */
export async function handleCheckpointCreate(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const sessionId = message.sessionId as string;
	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	const resolved = resolveCheckpointTarget(sessionId);
	if ('error' in resolved) {
		ctx.send(client, {
			type: 'worktree_checkpoint_create_result',
			success: false,
			error: resolved.error,
			requestId: message.requestId,
		});
		return;
	}

	const result = await createCheckpoint(resolved.target, {
		label: typeof message.label === 'string' ? message.label : undefined,
		includeIgnored: message.includeIgnored === true,
		// An origin from the wire is narrowed, never cast: an unrecognized value
		// written into a commit trailer would come back out of the list as a
		// permanently mislabeled row.
		origin: isCheckpointOrigin(message.origin) ? message.origin : 'manual',
	});

	ctx.send(client, {
		type: 'worktree_checkpoint_create_result',
		success: result.success,
		checkpoint: result.checkpoint,
		error: result.error,
		requestId: message.requestId,
	});
}

/** Handle worktree_checkpoint_list - list an agent's checkpoints, newest first. */
export async function handleCheckpointList(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const sessionId = message.sessionId as string;
	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	const resolved = resolveCheckpointTarget(sessionId);
	if ('error' in resolved) {
		ctx.send(client, {
			type: 'worktree_checkpoint_list_result',
			success: false,
			checkpoints: [],
			error: resolved.error,
			requestId: message.requestId,
		});
		return;
	}

	const result = await listCheckpoints(resolved.target, {
		allWorktrees: message.allWorktrees === true,
	});

	ctx.send(client, {
		type: 'worktree_checkpoint_list_result',
		success: result.success,
		checkpoints: result.checkpoints,
		error: result.error,
		requestId: message.requestId,
	});
}

/** Handle worktree_checkpoint_restore - roll an agent's tree back to a checkpoint. */
export async function handleCheckpointRestore(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const sessionId = message.sessionId as string;
	const checkpointId = message.checkpointId as string;
	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}
	if (!checkpointId || typeof checkpointId !== 'string') {
		ctx.sendError(client, 'Missing or invalid checkpointId');
		return;
	}

	const resolved = resolveCheckpointTarget(sessionId);
	if ('error' in resolved) {
		ctx.send(client, {
			type: 'worktree_checkpoint_restore_result',
			success: false,
			error: resolved.error,
			requestId: message.requestId,
		});
		return;
	}

	// No opt-out of the safety checkpoint over the wire. An agent driving the CLI
	// is exactly the caller most likely to restore the wrong snapshot, and the
	// undo is what makes that survivable.
	const result = await restoreCheckpoint(resolved.target, checkpointId);

	ctx.send(client, {
		type: 'worktree_checkpoint_restore_result',
		success: result.success,
		safetyCheckpoint: result.safetyCheckpoint,
		error: result.error,
		requestId: message.requestId,
	});
}

/** Handle worktree_checkpoint_delete - drop a checkpoint's ref. */
export async function handleCheckpointDelete(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const sessionId = message.sessionId as string;
	const checkpointId = message.checkpointId as string;
	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}
	if (!checkpointId || typeof checkpointId !== 'string') {
		ctx.sendError(client, 'Missing or invalid checkpointId');
		return;
	}

	const resolved = resolveCheckpointTarget(sessionId);
	if ('error' in resolved) {
		ctx.send(client, {
			type: 'worktree_checkpoint_delete_result',
			success: false,
			error: resolved.error,
			requestId: message.requestId,
		});
		return;
	}

	const result = await deleteCheckpoint(resolved.target, checkpointId);

	ctx.send(client, {
		type: 'worktree_checkpoint_delete_result',
		success: result.success,
		error: result.error,
		requestId: message.requestId,
	});
}
