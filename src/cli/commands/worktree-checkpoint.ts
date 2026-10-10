// Worktree checkpoints - snapshot and roll back an agent's working tree.
//
//   maestro-cli worktree checkpoint create  [-a <agent>] [-m <label>] [--include-ignored]
//   maestro-cli worktree checkpoint list    [-a <agent>] [--all-worktrees]
//   maestro-cli worktree checkpoint restore <id> [-a <agent>]
//   maestro-cli worktree checkpoint delete  <id> [-a <agent>]
//
// Every verb runs in the desktop's main process (see
// `web-server/handlers/messageHandlers/checkpoints.ts`) rather than shelling out
// to git here. The desktop is what knows an agent's live working directory and
// its SSH remote, and a CLI that re-derived either would checkpoint a different
// tree than the one the app shows for that agent.
//
// See `src/shared/gitCheckpoints.ts` for what a checkpoint is and why it is
// ref-backed rather than a copy of the tree.

import { withMaestroClient, resolveTargetSessionId } from '../services/maestro-client';
import { describeCheckpointOrigin, type GitCheckpoint } from '../../shared/gitCheckpoints';

interface CheckpointOptions {
	agent?: string;
	message?: string;
	includeIgnored?: boolean;
	allWorktrees?: boolean;
	json?: boolean;
}

/**
 * Report a failure in whichever shape the caller asked for and exit non-zero.
 *
 * `--json` consumers are scripts, so an error has to be parseable JSON on
 * stdout rather than prose on stderr, or the script sees an empty parse and
 * reports something unrelated.
 */
function fail(json: boolean, message: string): never {
	if (json) {
		console.log(JSON.stringify({ success: false, error: message }));
	} else {
		console.error(`Error: ${message}`);
	}
	process.exit(1);
}

function formatCheckpointLine(checkpoint: GitCheckpoint): string {
	const when = new Date(checkpoint.createdAt).toLocaleString();
	const flags = [describeCheckpointOrigin(checkpoint.origin)];
	if (checkpoint.includesIgnored) flags.push('includes ignored');
	if (checkpoint.branch) flags.push(checkpoint.branch);
	return `  ${checkpoint.id}\n    ${checkpoint.label}\n    ${when} - ${flags.join(' - ')}`;
}

export async function worktreeCheckpointCreate(options: CheckpointOptions): Promise<void> {
	const json = !!options.json;
	const sessionId = resolveTargetSessionId(options.agent);

	try {
		const result = await withMaestroClient((client) =>
			client.sendCommand<{
				success: boolean;
				checkpoint?: GitCheckpoint;
				error?: string;
			}>(
				{
					type: 'worktree_checkpoint_create',
					sessionId,
					label: options.message?.trim() || undefined,
					includeIgnored: options.includeIgnored === true,
				},
				'worktree_checkpoint_create_result'
			)
		);

		if (!result.success || !result.checkpoint) {
			return fail(json, result.error || 'Failed to create checkpoint');
		}

		if (json) {
			console.log(JSON.stringify({ success: true, checkpoint: result.checkpoint }));
		} else {
			console.log(`Created checkpoint ${result.checkpoint.id}`);
			console.log(`  ${result.checkpoint.label}`);
			if (result.checkpoint.includesIgnored) {
				console.log('  Includes ignored files');
			}
		}
	} catch (error) {
		return fail(json, error instanceof Error ? error.message : String(error));
	}
}

export async function worktreeCheckpointList(options: CheckpointOptions): Promise<void> {
	const json = !!options.json;
	const sessionId = resolveTargetSessionId(options.agent);

	try {
		const result = await withMaestroClient((client) =>
			client.sendCommand<{
				success: boolean;
				checkpoints?: GitCheckpoint[];
				error?: string;
			}>(
				{
					type: 'worktree_checkpoint_list',
					sessionId,
					allWorktrees: options.allWorktrees === true,
				},
				'worktree_checkpoint_list_result'
			)
		);

		if (!result.success) {
			return fail(json, result.error || 'Failed to list checkpoints');
		}

		const checkpoints = result.checkpoints ?? [];
		if (json) {
			console.log(JSON.stringify({ success: true, checkpoints }));
			return;
		}

		if (checkpoints.length === 0) {
			console.log('No checkpoints for this agent.');
			return;
		}

		console.log(`${checkpoints.length} checkpoint${checkpoints.length === 1 ? '' : 's'}:`);
		for (const checkpoint of checkpoints) {
			console.log(formatCheckpointLine(checkpoint));
		}
	} catch (error) {
		return fail(json, error instanceof Error ? error.message : String(error));
	}
}

export async function worktreeCheckpointRestore(
	checkpointId: string,
	options: CheckpointOptions
): Promise<void> {
	const json = !!options.json;
	if (!checkpointId || checkpointId.trim() === '') {
		return fail(json, 'A checkpoint id is required (see "worktree checkpoint list")');
	}
	const sessionId = resolveTargetSessionId(options.agent);

	try {
		const result = await withMaestroClient((client) =>
			client.sendCommand<{
				success: boolean;
				safetyCheckpoint?: GitCheckpoint;
				error?: string;
			}>(
				{
					type: 'worktree_checkpoint_restore',
					sessionId,
					checkpointId: checkpointId.trim(),
				},
				'worktree_checkpoint_restore_result'
			)
		);

		if (!result.success) {
			return fail(json, result.error || 'Failed to restore checkpoint');
		}

		if (json) {
			console.log(
				JSON.stringify({ success: true, safetyCheckpoint: result.safetyCheckpoint ?? null })
			);
		} else {
			console.log(`Restored checkpoint ${checkpointId.trim()}`);
			// Always printed when present: the whole reason a restore is safe to
			// run is that the previous state is recoverable, and the user can only
			// act on that if they are told the id.
			if (result.safetyCheckpoint) {
				console.log(`  Previous state saved as ${result.safetyCheckpoint.id}`);
				console.log(
					`  Undo with: maestro-cli worktree checkpoint restore ${result.safetyCheckpoint.id}`
				);
			}
		}
	} catch (error) {
		return fail(json, error instanceof Error ? error.message : String(error));
	}
}

export async function worktreeCheckpointDelete(
	checkpointId: string,
	options: CheckpointOptions
): Promise<void> {
	const json = !!options.json;
	if (!checkpointId || checkpointId.trim() === '') {
		return fail(json, 'A checkpoint id is required (see "worktree checkpoint list")');
	}
	const sessionId = resolveTargetSessionId(options.agent);

	try {
		const result = await withMaestroClient((client) =>
			client.sendCommand<{ success: boolean; error?: string }>(
				{
					type: 'worktree_checkpoint_delete',
					sessionId,
					checkpointId: checkpointId.trim(),
				},
				'worktree_checkpoint_delete_result'
			)
		);

		if (!result.success) {
			return fail(json, result.error || 'Failed to delete checkpoint');
		}

		if (json) {
			console.log(JSON.stringify({ success: true }));
		} else {
			console.log(`Deleted checkpoint ${checkpointId.trim()}`);
		}
	} catch (error) {
		return fail(json, error instanceof Error ? error.message : String(error));
	}
}
