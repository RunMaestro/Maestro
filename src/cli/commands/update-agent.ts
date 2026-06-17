// Update agent command - mutate fields on an existing agent in the Maestro
// desktop app (group assignment, working directory, and SSH execution config).
//
// `--group <id>` reuses the existing `move_session_to_group` WS message; pass
// `--group none` (or `--group ""`) to ungroup. `--cwd <path>` resolves to an
// absolute path and routes through the `update_session_cwd` WS message.
//
// `--ssh-remote`, `--ssh-cwd`, and `--sync-history-to-remote` build a partial
// patch sent via the `update_session_ssh` WS message, which merges the patch
// onto the agent's existing `sessionSshRemoteConfig` and flushes it to disk.
// Use `--ssh-remote none` to revert the agent to local execution. All of these
// (like `--cwd`) are refused by the renderer while the agent process is alive.

import * as path from 'path';
import { withMaestroClient } from '../services/maestro-client';
import { resolveAgentId, resolveGroupId } from '../services/storage';
import { formatError, formatSuccess } from '../output/formatter';

interface UpdateAgentOptions {
	group?: string;
	cwd?: string;
	sshRemote?: string;
	sshCwd?: string;
	syncHistoryToRemote?: string;
	json?: boolean;
}

// Parse a CLI boolean flag value. Accepts true/false/1/0/yes/no (case-insensitive).
function parseBool(value: string, flag: string): boolean {
	const v = value.trim().toLowerCase();
	if (v === 'true' || v === '1' || v === 'yes') return true;
	if (v === 'false' || v === '0' || v === 'no') return false;
	throw new Error(`${flag} expects true or false, got "${value}"`);
}

function emitError(message: string, options: UpdateAgentOptions): never {
	if (options.json) {
		console.log(JSON.stringify({ success: false, error: message }));
	} else {
		console.error(formatError(message));
	}
	return process.exit(1);
}

export async function updateAgent(agentId: string, options: UpdateAgentOptions): Promise<void> {
	const sshFlagsPresent =
		options.sshRemote !== undefined ||
		options.sshCwd !== undefined ||
		options.syncHistoryToRemote !== undefined;

	if (options.group === undefined && options.cwd === undefined && !sshFlagsPresent) {
		emitError(
			'Specify at least one of --group, --cwd, --ssh-remote, --ssh-cwd, or --sync-history-to-remote',
			options
		);
	}

	let sessionId: string;
	try {
		sessionId = resolveAgentId(agentId);
	} catch (error) {
		emitError(error instanceof Error ? error.message : String(error), options);
	}

	// Build the SSH patch from the SSH-related flags. Only keys the caller
	// touched are included so the renderer merges rather than clobbers.
	let sshPatch: Record<string, unknown> | undefined;
	if (sshFlagsPresent) {
		sshPatch = {};
		if (options.sshRemote !== undefined) {
			const raw = options.sshRemote.trim();
			if (raw === '' || raw.toLowerCase() === 'none' || raw.toLowerCase() === 'null') {
				// Revert to local execution; preserve other fields via the merge.
				sshPatch.enabled = false;
				sshPatch.remoteId = null;
			} else {
				sshPatch.enabled = true;
				sshPatch.remoteId = raw;
			}
		}
		if (options.sshCwd !== undefined) {
			sshPatch.workingDirOverride = options.sshCwd;
		}
		if (options.syncHistoryToRemote !== undefined) {
			try {
				sshPatch.syncHistory = parseBool(options.syncHistoryToRemote, '--sync-history-to-remote');
			} catch (error) {
				emitError(error instanceof Error ? error.message : String(error), options);
			}
		}
	}

	let resolvedGroupId: string | null | undefined;
	if (options.group !== undefined) {
		const raw = options.group.trim();
		if (raw === '' || raw.toLowerCase() === 'none' || raw.toLowerCase() === 'null') {
			resolvedGroupId = null;
		} else {
			try {
				resolvedGroupId = resolveGroupId(raw);
			} catch (error) {
				emitError(error instanceof Error ? error.message : String(error), options);
			}
		}
	}

	const resolvedCwd = options.cwd !== undefined ? path.resolve(options.cwd) : undefined;

	const applied: {
		group?: string | null;
		cwd?: string;
		ssh?: Record<string, unknown>;
	} = {};

	try {
		await withMaestroClient(async (client) => {
			if (resolvedGroupId !== undefined) {
				const result = await client.sendCommand<{
					type: string;
					success: boolean;
					error?: string;
				}>(
					{
						type: 'move_session_to_group',
						sessionId,
						groupId: resolvedGroupId,
					},
					'move_session_to_group_result'
				);
				if (!result.success) {
					throw new Error(result.error || 'Failed to move agent to group');
				}
				applied.group = resolvedGroupId;
			}

			if (resolvedCwd !== undefined) {
				const result = await client.sendCommand<{
					type: string;
					success: boolean;
					error?: string;
				}>(
					{
						type: 'update_session_cwd',
						sessionId,
						newCwd: resolvedCwd,
					},
					'update_session_cwd_result'
				);
				if (!result.success) {
					throw new Error(result.error || 'Failed to update agent cwd');
				}
				applied.cwd = resolvedCwd;
			}

			if (sshPatch !== undefined) {
				const result = await client.sendCommand<{
					type: string;
					success: boolean;
					error?: string;
				}>(
					{
						type: 'update_session_ssh',
						sessionId,
						sshPatch,
					},
					'update_session_ssh_result'
				);
				if (!result.success) {
					throw new Error(result.error || 'Failed to update agent SSH config');
				}
				applied.ssh = sshPatch;
			}
		});
	} catch (error) {
		emitError(error instanceof Error ? error.message : String(error), options);
	}

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				agentId: sessionId,
				...applied,
			})
		);
		return;
	}

	console.log(formatSuccess(`Updated agent ${sessionId}`));
	if (applied.group !== undefined) {
		console.log(`  Group: ${applied.group ?? '(ungrouped)'}`);
	}
	if (applied.cwd !== undefined) {
		console.log(`  CWD: ${applied.cwd}`);
	}
	if (applied.ssh !== undefined) {
		if ('enabled' in applied.ssh) {
			console.log(
				`  SSH: ${applied.ssh.enabled ? `enabled (remote ${applied.ssh.remoteId})` : 'disabled (local)'}`
			);
		}
		if ('workingDirOverride' in applied.ssh) {
			console.log(`  SSH cwd: ${applied.ssh.workingDirOverride}`);
		}
		if ('syncHistory' in applied.ssh) {
			console.log(`  Sync history to remote: ${applied.ssh.syncHistory}`);
		}
	}
}
