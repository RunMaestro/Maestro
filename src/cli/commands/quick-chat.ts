// Quick Chat commands - drive the hotkey-summoned floating chat window from the
// CLI. Every verb rides the `quick_chat` WS message to the same main-process
// controller the window's own buttons call, so `quick-chat send` is the exact
// path typing in the window takes.

import { withMaestroClient } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';
import type { QuickChatStatus } from '../../shared/quickChat';

export interface QuickChatOptions {
	json?: boolean;
}

interface QuickChatResponse {
	type: string;
	success: boolean;
	error?: string;
	status?: QuickChatStatus;
}

export type QuickChatAction =
	| 'show'
	| 'hide'
	| 'toggle'
	| 'status'
	| 'send'
	| 'new'
	| 'keep'
	| 'agent'
	| 'reveal'
	| 'stop';

function fail(message: string, options: QuickChatOptions): void {
	if (options.json) {
		console.log(JSON.stringify({ success: false, error: message }));
	} else {
		console.error(`Error: ${message}`);
	}
	process.exit(1);
}

/** Human-readable summary of the window and the chat in it. */
function printStatus(status: QuickChatStatus): void {
	const { snapshot } = status;
	console.log(
		`Quick Chat: ${status.enabled ? 'on' : 'off'}, window ${status.visible ? 'open' : 'closed'}`
	);
	const hotkey = status.hotkey.length > 0 ? status.hotkey.join('+') : 'none';
	console.log(`Hotkey: ${hotkey}${status.hotkeyRegistered ? '' : ' (not registered)'}`);
	console.log(
		`Agent: ${snapshot.agentName ?? 'none'}${snapshot.agentId ? ` (${snapshot.agentId})` : ''}`
	);
	console.log(
		`Chat: ${snapshot.tabId ? `tab ${snapshot.tabId}` : 'not started'}, ${snapshot.persistent ? 'kept as a tab' : 'ephemeral'}${snapshot.busy ? ', working' : ''}`
	);
	for (const message of snapshot.messages) {
		const who = message.role === 'user' ? 'You' : message.role === 'error' ? 'Error' : 'Agent';
		console.log(`\n${who}: ${message.text}`);
	}
}

export async function quickChat(
	action: QuickChatAction,
	args: { text?: string; persistent?: boolean; agent?: string },
	options: QuickChatOptions
): Promise<void> {
	const message: Record<string, unknown> = { type: 'quick_chat', action };
	if (action === 'send') {
		if (!args.text?.trim()) {
			fail('message cannot be empty', options);
			return;
		}
		message.text = args.text;
	}
	if (action === 'keep') message.persistent = args.persistent !== false;
	if (action === 'agent') {
		try {
			message.agentId = resolveAgentId(args.agent ?? '');
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error), options);
			return;
		}
	}

	try {
		const result = await withMaestroClient((client) =>
			client.sendCommand<QuickChatResponse>(message, 'quick_chat_result')
		);
		if (options.json) {
			console.log(
				JSON.stringify({ success: result.success, error: result.error, ...result.status })
			);
			if (!result.success) process.exit(1);
			return;
		}
		if (!result.success) {
			fail(result.error || `quick-chat ${action} failed`, options);
			return;
		}
		if (action === 'status' && result.status) printStatus(result.status);
		else console.log(`Quick Chat: ${action} done`);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), options);
	}
}
