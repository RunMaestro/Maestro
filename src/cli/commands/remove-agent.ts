// Remove agent command - delete an agent from the Maestro desktop app

import { withMaestroClient } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';
import { formatError, formatSuccess } from '../output/formatter';

interface RemoveAgentOptions {
	json?: boolean;
}

export async function removeAgent(agentId: string, options: RemoveAgentOptions): Promise<void> {
	// Resolve agent ID (supports partial match / name lookup)
	let sessionId: string;
	try {
		sessionId = resolveAgentId(agentId);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: msg }));
		} else {
			console.error(formatError(msg));
		}
		return process.exit(1);
	}

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{
				type: string;
				success: boolean;
				sessionId?: string;
				error?: string;
			}>(
				{
					type: 'delete_session',
					sessionId,
				},
				'delete_session_result'
			);
		});

		if (result.success) {
			if (options.json) {
				console.log(JSON.stringify({ success: true, agentId: sessionId }));
			} else {
				console.log(formatSuccess(`Removed agent ${sessionId}`));
			}
		} else {
			const msg = result.error || 'Failed to remove agent';
			if (options.json) {
				console.log(JSON.stringify({ success: false, error: msg }));
			} else {
				console.error(formatError(msg));
			}
			process.exit(1);
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: msg }));
		} else {
			console.error(formatError(msg));
		}
		process.exit(1);
	}
}
