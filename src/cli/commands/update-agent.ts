// Update agent command - mutate fields on an existing agent in the Maestro
// desktop app (currently group assignment and working directory).
//
// `--group <id>` reuses the existing `move_session_to_group` WS message; pass
// `--group none` (or `--group ""`) to ungroup. `--cwd <path>` resolves to an
// absolute path and routes through the new `update_session_cwd` WS message,
// which the renderer refuses while the agent process is alive.

import * as path from 'path';
import { withMaestroClient } from '../services/maestro-client';
import { resolveAgentId, resolveGroupId } from '../services/storage';
import { formatError, formatSuccess } from '../output/formatter';

interface UpdateAgentOptions {
	group?: string;
	cwd?: string;
	json?: boolean;
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
	if (options.group === undefined && options.cwd === undefined) {
		emitError('Specify at least one of --group or --cwd', options);
	}

	let sessionId: string;
	try {
		sessionId = resolveAgentId(agentId);
	} catch (error) {
		emitError(error instanceof Error ? error.message : String(error), options);
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

	const applied: { group?: string | null; cwd?: string } = {};

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
}
