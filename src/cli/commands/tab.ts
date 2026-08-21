// Tab commands - manage an agent's AI tabs in the running desktop app: open a
// new tab (optionally seeded with a prompt), close, rename, star/unstar, and
// move. These mirror the tab bar and AI tab overlay menu via the new_tab,
// new_ai_tab_with_prompt, close_tab, rename_tab, star_tab, and reorder_tab WS
// messages.
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
	listDesktopTabs,
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

/**
 * Move a tab to a new position in its agent's tab bar (mirrors dragging a tab).
 *
 * `reorder_tab` speaks in array indices, so the current index is resolved from
 * the live tab list rather than trusted from the caller: the CLI's own view of
 * tab order would go stale the moment the user dragged a tab themselves.
 * Positions are 0-based; `last` (or any index past the end) moves to the end.
 */
export async function tabMove(
	tabId: string,
	position: string,
	options: TabMutateOptions
): Promise<void> {
	let owner: { agentId: string; tabId: string };
	try {
		owner = await resolveTabOwner(tabId);
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), options.json);
	}

	let fromIndex: number;
	let tabCount: number;
	try {
		const siblings = (await listDesktopTabs()).filter((t) => t.agentId === owner.agentId);
		tabCount = siblings.length;
		fromIndex = siblings.findIndex((t) => t.tabId === owner.tabId);
		if (fromIndex < 0) {
			return failCommand(`Tab ${owner.tabId} is no longer open`, options.json);
		}
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), options.json);
	}

	const raw = (position ?? '').trim().toLowerCase();
	let toIndex: number;
	if (raw === 'last' || raw === 'end') {
		toIndex = tabCount - 1;
	} else if (raw === 'first' || raw === 'start') {
		toIndex = 0;
	} else {
		const parsed = Number(raw);
		if (!Number.isInteger(parsed) || parsed < 0) {
			return failCommand(
				`Invalid position "${position}". Use a 0-based index, "first", or "last".`,
				options.json
			);
		}
		toIndex = Math.min(parsed, tabCount - 1);
	}

	if (toIndex === fromIndex) {
		return reportResult(
			{ success: true },
			{
				json: options.json,
				successMessage: `Tab ${owner.tabId} is already at position ${toIndex}`,
				jsonExtra: { tabId: owner.tabId, agentId: owner.agentId, fromIndex, toIndex },
			}
		);
	}

	try {
		const result: SimpleResult = await sendSimpleCommand(
			{ type: 'reorder_tab', sessionId: owner.agentId, fromIndex, toIndex },
			'reorder_tab_result'
		);
		reportResult(result, {
			json: options.json,
			successMessage: `Moved tab ${owner.tabId} from position ${fromIndex} to ${toIndex}`,
			jsonExtra: { tabId: owner.tabId, agentId: owner.agentId, fromIndex, toIndex },
		});
	} catch (error) {
		failCommand(error instanceof Error ? error.message : String(error), options.json);
	}
}

/**
 * Set a persistent flag on one AI tab (unread marker, save-to-history).
 *
 * These ride `update_session_config` with a `tabId` rather than a dedicated
 * message: that path is allowlisted, acked, and flushed to disk before it
 * returns, so a script can write a flag and immediately read it back with
 * `maestro-cli session list --json`.
 */
async function tabFlag(
	tabId: string,
	patch: Record<string, unknown>,
	successMessage: (owner: { agentId: string; tabId: string }) => string,
	options: TabMutateOptions
): Promise<void> {
	let owner: { agentId: string; tabId: string };
	try {
		owner = await resolveTabOwner(tabId);
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), options.json);
	}

	try {
		const result: SimpleResult = await sendSimpleCommand(
			{
				type: 'update_session_config',
				sessionId: owner.agentId,
				configPatch: { tabId: owner.tabId, ...patch },
			},
			'update_session_config_result'
		);
		reportResult(result, {
			json: options.json,
			successMessage: successMessage(owner),
			jsonExtra: { tabId: owner.tabId, agentId: owner.agentId, ...patch },
		});
	} catch (error) {
		failCommand(error instanceof Error ? error.message : String(error), options.json);
	}
}

/** Mark a tab unread (or read) - the blue dot that flags a tab for the human. */
export async function tabUnread(
	tabId: string,
	hasUnread: boolean,
	options: TabMutateOptions
): Promise<void> {
	await tabFlag(
		tabId,
		{ hasUnread },
		(owner) => `Marked tab ${owner.tabId} as ${hasUnread ? 'unread' : 'read'}`,
		options
	);
}

/** Toggle whether a tab's completions are synopsized into History. */
export async function tabSaveToHistory(
	tabId: string,
	saveToHistory: boolean,
	options: TabMutateOptions
): Promise<void> {
	await tabFlag(
		tabId,
		{ saveToHistory },
		(owner) => `${saveToHistory ? 'Enabled' : 'Disabled'} history saving for tab ${owner.tabId}`,
		options
	);
}
