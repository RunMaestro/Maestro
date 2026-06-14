// Agent control commands - drive the desktop workspace: focus (select) an agent
// in the UI and switch an agent between AI and terminal mode. These mirror
// clicking an agent in the Left Bar and toggling the AI/Shell mode switch, via
// the select_session and switch_mode WS messages.

import { runAgentCommand, failCommand } from '../services/session-command';

interface FocusAgentOptions {
	tab?: string;
	json?: boolean;
}

interface SwitchModeOptions {
	json?: boolean;
}

export async function focusAgent(agentId: string, options: FocusAgentOptions): Promise<void> {
	await runAgentCommand(agentId, options, (sessionId) => ({
		type: 'select_session',
		responseType: 'select_session_result',
		successMessage: `Focused agent ${sessionId}${options.tab ? ` (tab ${options.tab})` : ''}`,
		extraPayload: {
			focus: true,
			...(options.tab ? { tabId: options.tab } : {}),
		},
	}));
}

export async function switchMode(
	agentId: string,
	mode: string,
	options: SwitchModeOptions
): Promise<void> {
	const normalized = (mode ?? '').trim().toLowerCase();
	if (normalized !== 'ai' && normalized !== 'terminal') {
		failCommand(`Invalid mode "${mode}". Must be "ai" or "terminal".`, options.json);
	}

	await runAgentCommand(agentId, options, (sessionId) => ({
		type: 'switch_mode',
		responseType: 'mode_switch_result',
		successMessage: `Switched ${sessionId} to ${normalized} mode`,
		extraPayload: { mode: normalized },
	}));
}
