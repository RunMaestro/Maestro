// Tab commands - manage an agent's AI tabs in the running desktop app: open a
// new tab (optionally seeded with a prompt), close, rename, star/unstar, and
// move. These mirror the tab bar and AI tab overlay menu via the new_tab,
// new_ai_tab_with_prompt, close_tab, rename_tab, star_tab, and reorder_tab WS
// messages.
//
// Mutating verbs accept a tab ID (exact or unique prefix) and resolve the
// owning agent automatically, so "maestro-cli tab close <tab-id>" just works.
// The literal "active" targets whatever tab is on screen (of --agent's agent,
// or of the focused agent). Find tab IDs with "maestro-cli session list".
//
// The per-tab settings verbs (thinking, read-only, model, effort,
// enter-to-send, save-to-history) are the CLI half of the composer chips: one
// tab's state, written through the allowlisted + flushed config path so a
// script can set a value and read it straight back with "tab show".

import {
	sendSimpleCommand,
	reportResult,
	failCommand,
	resolveAgentOrFail,
	resolveTabEntry,
	resolveTabOwner,
	listDesktopTabs,
	type SimpleResult,
} from '../services/session-command';
import { formatSuccess } from '../output/formatter';
import { nextThinkingMode, type ThinkingMode } from '../../shared/types';
import type { DesktopTabEntry } from '../../shared/desktopTabs';

interface TabNewOptions {
	agent: string;
	prompt?: string;
	/**
	 * Create the tab without making it the visible one. The tab still lands in
	 * the tab bar and is addressable by id, but the agent stays on whatever tab
	 * the user was looking at.
	 */
	background?: boolean;
	json?: boolean;
}

interface TabMutateOptions {
	/** Disambiguates the `active` tab id: whose active tab did you mean? */
	agent?: string;
	json?: boolean;
}

export async function tabNew(options: TabNewOptions): Promise<void> {
	const sessionId = resolveAgentOrFail(options.agent, options.json);
	const prompt = options.prompt?.trim();

	// `new_ai_tab_with_prompt` already carried a `background` field for
	// `dispatch --new-tab`; `new_tab` gained one so both halves of `tab new`
	// answer the same flag. Absent means focus, exactly as before.
	const background = options.background === true;

	try {
		const payload = prompt
			? {
					type: 'new_ai_tab_with_prompt',
					sessionId,
					prompt,
					...(background ? { background: true } : {}),
				}
			: { type: 'new_tab', sessionId, ...(background ? { background: true } : {}) };
		const responseType = prompt ? 'new_ai_tab_with_prompt_result' : 'new_tab_result';
		const result = await sendSimpleCommand(payload, responseType);

		if (!result.success) {
			failCommand((result.error as string) || 'Failed to create tab', options.json);
		}
		const tabId = result.tabId as string | undefined;
		if (options.json) {
			console.log(JSON.stringify({ success: true, sessionId, tabId: tabId ?? null }));
		} else {
			console.log(
				formatSuccess(
					background
						? `Opened new background tab for ${sessionId}`
						: `Opened new tab for ${sessionId}`
				)
			);
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
		owner = await resolveTabOwner(tabId, options.agent);
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
		owner = await resolveTabOwner(tabId, options.agent);
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
async function writeTabPatch(
	owner: { agentId: string; tabId: string },
	patch: Record<string, unknown>,
	successMessage: string,
	options: TabMutateOptions
): Promise<void> {
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
			successMessage,
			jsonExtra: { tabId: owner.tabId, agentId: owner.agentId, ...patch },
		});
	} catch (error) {
		failCommand(error instanceof Error ? error.message : String(error), options.json);
	}
}

async function tabFlag(
	tabId: string,
	patch: Record<string, unknown>,
	successMessage: (owner: { agentId: string; tabId: string }) => string,
	options: TabMutateOptions
): Promise<void> {
	let owner: { agentId: string; tabId: string };
	try {
		owner = await resolveTabOwner(tabId, options.agent);
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), options.json);
	}
	await writeTabPatch(owner, patch, successMessage(owner), options);
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

/**
 * Set (or cycle) the thinking display for one tab: `off`, `on` (temporary),
 * `sticky` (pinned), or `cycle` to advance one step the way clicking the chip
 * does. `cycle` reads the tab's current mode from the same list call that
 * resolved it, so it agrees with what is on screen rather than with a value the
 * caller guessed.
 */
export async function tabThinking(
	tabId: string,
	mode: ThinkingMode | 'cycle',
	options: TabMutateOptions
): Promise<void> {
	let entry: DesktopTabEntry;
	try {
		entry = await resolveTabEntry(tabId, options.agent);
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), options.json);
	}
	const next = mode === 'cycle' ? nextThinkingMode(entry.thinking) : mode;
	await writeTabPatch(
		entry,
		{ showThinking: next },
		`Thinking for tab ${entry.tabId} is now ${next}`,
		options
	);
}

/** Put one tab into read-only / plan mode (the agent may not modify files). */
export async function tabReadOnly(
	tabId: string,
	readOnly: boolean,
	options: TabMutateOptions
): Promise<void> {
	await tabFlag(
		tabId,
		{ readOnlyMode: readOnly },
		(owner) => `${readOnly ? 'Enabled' : 'Disabled'} read-only mode for tab ${owner.tabId}`,
		options
	);
}

/**
 * Override the model for one tab, or pass `null` to drop the override so the
 * tab inherits the agent's model again. Values are not validated against the
 * provider's model list - same as `update-agent --model`, which lets you name a
 * model the local install knows about before Maestro has probed for it.
 */
export async function tabModel(
	tabId: string,
	model: string | null,
	options: TabMutateOptions
): Promise<void> {
	await tabFlag(
		tabId,
		{ customModel: model },
		(owner) =>
			model === null
				? `Tab ${owner.tabId} now inherits the agent's model`
				: `Set tab ${owner.tabId} model to ${model}`,
		options
	);
}

/** Override the effort/reasoning level for one tab, or `null` to inherit. */
export async function tabEffort(
	tabId: string,
	effort: string | null,
	options: TabMutateOptions
): Promise<void> {
	await tabFlag(
		tabId,
		{ customEffort: effort },
		(owner) =>
			effort === null
				? `Tab ${owner.tabId} now inherits the agent's effort`
				: `Set tab ${owner.tabId} effort to ${effort}`,
		options
	);
}

/**
 * Override the send key for one tab, or `null` to inherit the global
 * `enterToSendAI` setting. `false` is not the same as inheriting: it pins the
 * tab to Cmd+Enter even if the global default is Enter.
 */
export async function tabEnterToSend(
	tabId: string,
	enterToSend: boolean | null,
	options: TabMutateOptions
): Promise<void> {
	await tabFlag(
		tabId,
		{ enterToSend },
		(owner) =>
			enterToSend === null
				? `Tab ${owner.tabId} now inherits the enter-to-send setting`
				: `Tab ${owner.tabId} now sends on ${enterToSend ? 'Enter' : 'Cmd+Enter'}`,
		options
	);
}

/**
 * Print one tab's settings - the read half of the verbs above, so a script can
 * check state without diffing `session list --json`. Everything comes from the
 * single list call that resolves the tab.
 */
export async function tabShow(tabId: string, options: TabMutateOptions): Promise<void> {
	let entry: DesktopTabEntry;
	try {
		entry = await resolveTabEntry(tabId, options.agent);
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), options.json);
	}

	if (options.json) {
		console.log(JSON.stringify({ success: true, tab: entry }, null, 2));
		return;
	}

	// `inherited` rather than a bare value: the three nullable fields fall back
	// to the agent (model / effort) or the global setting (enter-to-send), and
	// printing an empty column would read as "off". `undefined` is folded in
	// too: an app older than this CLI does not send these fields at all, and
	// "undefined" in a settings column reads as a bug rather than as skew.
	const inherited = (value: string | boolean | null | undefined): string =>
		value === null || value === undefined ? 'inherited' : String(value);
	const row = (label: string, value: string): void =>
		console.log(`  ${`${label}:`.padEnd(17)}${value}`);
	console.log(`Tab ${entry.tabId}${entry.active ? ' (active)' : ''}`);
	row('Agent', `${entry.agentName} (${entry.agentId})`);
	row('Provider', entry.toolType);
	row('Name', entry.name ?? '(unnamed)');
	row('State', entry.state);
	row('Session', entry.agentSessionId ?? '(none yet)');
	row('Model', inherited(entry.model));
	row('Effort', inherited(entry.effort));
	row('Thinking', entry.thinking ?? 'off');
	row('Read-only', String(entry.readOnly ?? false));
	row('Save to History', String(entry.saveToHistory ?? false));
	row('Enter to send', inherited(entry.enterToSend));
	row('Starred', String(entry.starred));
	row('Unread', String(entry.hasUnread ?? false));
}
