// Rename agent command - change an agent's display name in the running desktop
// app. Mirrors the Left Bar "Rename" action via the rename_session WS message.

import { runAgentCommand, failCommand } from '../services/session-command';

interface RenameAgentOptions {
	json?: boolean;
}

export async function renameAgent(
	agentId: string,
	newName: string,
	options: RenameAgentOptions
): Promise<void> {
	const trimmed = (newName ?? '').trim();
	if (!trimmed) {
		failCommand('New name must not be empty', options.json);
	}
	if (trimmed.length > 100) {
		failCommand('New name must be 100 characters or less', options.json);
	}

	await runAgentCommand(agentId, options, (sessionId) => ({
		type: 'rename_session',
		responseType: 'rename_session_result',
		successMessage: `Renamed agent ${sessionId} to "${trimmed}"`,
		extraPayload: { newName: trimmed },
	}));
}
