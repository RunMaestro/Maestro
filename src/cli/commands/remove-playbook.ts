// Remove playbook command - delete a saved playbook from an agent via the
// delete_playbook WS message. Use "maestro-cli list playbooks -a <agent>" to
// find playbook IDs. Mirrors the Auto Run toolbar "Delete playbook" action.

import { runAgentCommand, failCommand } from '../services/session-command';

interface RemovePlaybookOptions {
	json?: boolean;
}

export async function removePlaybook(
	agentId: string,
	playbookId: string,
	options: RemovePlaybookOptions
): Promise<void> {
	const trimmed = (playbookId ?? '').trim();
	if (!trimmed) {
		failCommand('Playbook ID must not be empty', options.json);
	}

	await runAgentCommand(agentId, options, (sessionId) => ({
		type: 'delete_playbook',
		responseType: 'delete_playbook_result',
		successMessage: `Removed playbook ${trimmed} from ${sessionId}`,
		extraPayload: { playbookId: trimmed },
	}));
}
