// Agent control commands - drive the desktop workspace: focus (select) an agent
// in the UI and switch an agent between AI and terminal mode. These mirror
// clicking an agent in the Left Bar and toggling the AI/Shell mode switch, via
// the select_session and switch_mode WS messages.

import { runAgentCommand, failCommand } from '../services/session-command';
import { readActiveAgentId, resolveAgentId } from '../services/storage';
import { resolveBackgroundFlag } from '../../shared/focusPlacement';

interface FocusAgentOptions {
	tab?: string;
	json?: boolean;
}

interface SwitchModeOptions {
	json?: boolean;
	background?: boolean;
	focus?: boolean;
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

	// switch-mode is the one focus-moving verb that CREATES nothing, so it has no
	// background equivalent to fall back on: the mode change IS the view change
	// for whoever is looking at that agent. `--background` therefore means "skip
	// it rather than move me", and we decide that HERE so the answer is honest.
	// The desktop's fire-and-forget switch_mode has no result channel, so a
	// renderer-side decline would come back looking like a success.
	if (resolveBackgroundFlag(options, 'switch-mode')) {
		let resolvedId: string;
		try {
			resolvedId = resolveAgentId(agentId);
		} catch {
			// Let runAgentCommand produce the canonical not-found error below.
			resolvedId = agentId;
		}
		if (readActiveAgentId() === resolvedId) {
			return failCommand(
				`Refusing to switch ${resolvedId} to ${normalized} mode: it is the agent on screen, and --background means do not move the view. Re-run with --focus to switch it anyway.`,
				options.json
			);
		}
	}

	await runAgentCommand(agentId, options, (sessionId) => ({
		type: 'switch_mode',
		responseType: 'mode_switch_result',
		successMessage: `Switched ${sessionId} to ${normalized} mode`,
		extraPayload: { mode: normalized, background: resolveBackgroundFlag(options, 'switch-mode') },
	}));
}
