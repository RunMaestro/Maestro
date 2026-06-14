// Tab commands - manage an agent's AI tabs in the running desktop app: open a
// new tab (optionally seeded with a prompt), close, rename, and star/unstar.
// These mirror the tab bar and AI tab overlay menu via the new_tab,
// new_ai_tab_with_prompt, close_tab, rename_tab, and star_tab WS messages.
//
// Mutating verbs accept a tab ID (exact or unique prefix) and resolve the
// owning agent automatically, so "maestro-cli tab close <tab-id>" just works.
// Find tab IDs with "maestro-cli session list".

import {
	sendSimpleCommand,
	reportResult,
	failCommand,
	resolveAgentOrFail,
	resolveTabOwner,
	type SimpleResult,
} from '../services/session-command';
import { formatSuccess } from '../output/formatter';

interface TabNewOptions {
	agent: string;
	prompt?: string;
	json?: boolean;
}

interface TabMutateOptions {
	json?: boolean;
}

export async function tabNew(options: TabNewOptions): Promise<void> {
	const sessionId = resolveAgentOrFail(options.agent, options.json);
	const prompt = options.prompt?.trim();

	try {
		const payload = prompt
			? { type: 'new_ai_tab_with_prompt', sessionId, prompt }
			: { type: 'new_tab', sessionId };
		const responseType = prompt ? 'new_ai_tab_with_prompt_result' : 'new_tab_result';
		const result = await sendSimpleCommand(payload, responseType);

		if (!result.success) {
			failCommand((result.error as string) || 'Failed to create tab', options.json);
		}
		const tabId = result.tabId as string | undefined;
		if (options.json) {
			console.log(JSON.stringify({ success: true, sessionId, tabId: tabId ?? null }));
		} else {
			console.log(formatSuccess(`Opened new tab for ${sessionId}`));
			if (tabId) console.log(`  Tab: ${tabId}`);
		}
	} catch (error) {
		failCommand(error instanceof Error ? error.message : String(error), options.json);
	}
}

/**
 * Shared driver for tab-targeted verbs: resolve the tab's owning agent, send the
 * built message, and report the result.
 */
async function tabAction(
	tabId: string,
	options: TabMutateOptions,
	build: (owner: { agentId: string; tabId: string }) => {
		type: string;
		responseType: string;
		successMessage: string;
		extraPayload?: Record<string, unknown>;
	}
): Promise<void> {
	let owner: { agentId: string; tabId: string };
	try {
		owner = await resolveTabOwner(tabId);
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), options.json);
	}

	const { type, responseType, successMessage, extraPayload } = build(owner);
	try {
		const result: SimpleResult = await sendSimpleCommand(
			{ type, sessionId: owner.agentId, tabId: owner.tabId, ...extraPayload },
			responseType
		);
		reportResult(result, {
			json: options.json,
			successMessage,
			jsonExtra: { tabId: owner.tabId, agentId: owner.agentId },
		});
	} catch (error) {
		failCommand(error instanceof Error ? error.message : String(error), options.json);
	}
}

export async function tabClose(tabId: string, options: TabMutateOptions): Promise<void> {
	await tabAction(tabId, options, (owner) => ({
		type: 'close_tab',
		responseType: 'close_tab_result',
		successMessage: `Closed tab ${owner.tabId}`,
	}));
}

export async function tabRename(
	tabId: string,
	newName: string,
	options: TabMutateOptions
): Promise<void> {
	const trimmed = (newName ?? '').trim();
	if (!trimmed) {
		failCommand('New name must not be empty', options.json);
	}
	await tabAction(tabId, options, (owner) => ({
		type: 'rename_tab',
		responseType: 'rename_tab_result',
		successMessage: `Renamed tab ${owner.tabId} to "${trimmed}"`,
		extraPayload: { newName: trimmed },
	}));
}

export async function tabStar(
	tabId: string,
	starred: boolean,
	options: TabMutateOptions
): Promise<void> {
	await tabAction(tabId, options, (owner) => ({
		type: 'star_tab',
		responseType: 'star_tab_result',
		successMessage: `${starred ? 'Starred' : 'Unstarred'} tab ${owner.tabId}`,
		extraPayload: { starred },
	}));
}
