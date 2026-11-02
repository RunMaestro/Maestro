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
//
// "tab closed" and "tab reopen" are the CLI half of Cmd+Shift+T: they read and
// restore an agent's closed-tab stack through the closed_tab_command message,
// which the renderer answers with the shortcut's own reopen function.
//
// "tab compact", "tab merge" and "tab transfer" are the overlay menu's Context:
// Compact, Merge Into and Send to Agent, sent as summarize_context,
// merge_context and transfer_context and run by the menu's own handlers.

import {
	sendSimpleCommand,
	reportResult,
	failCommand,
	resolveAgentOrFail,
	resolveTabEntry,
	resolveTabOwner,
	listDesktopTabs,
	type SimpleResult,
	exitIfMaestroNotRunning,
	errorFrameMessage,
	failFromError,
	ACTIVE_TAB_KEYWORD,
} from '../services/session-command';
import { withMaestroClient, CommandTimeoutError } from '../services/maestro-client';
import { ExitCode, exitWith } from '../exit-codes';
import {
	TAB_CONTEXT_OP_CLI_MARGIN_MS,
	TAB_CONTEXT_OP_MESSAGES,
	TAB_CONTEXT_OP_REPLY_MS,
	buildTabContextOpMessage,
	type TabContextOp,
	type TabContextOpRequest,
	type TabContextOpResult,
} from '../../shared/tabContextOps';
import { formatSuccess } from '../output/formatter';
import { AUTO_MODEL, isAutoModel } from '../../shared/autoModel';
import { nextThinkingMode, type ThinkingMode } from '../../shared/types';
import type { DesktopTabEntry } from '../../shared/desktopTabs';
import { resolveBackgroundFlag } from '../../shared/focusPlacement';
import { formatRelativeTime } from '../../shared/formatters';
import type { ClosedTabCommandRequest, ClosedTabSummary } from '../../shared/closedTabCommands';
import { resolveAgentId, readActiveAgentId } from '../services/storage';

interface TabNewOptions {
	agent: string;
	prompt?: string;
	background?: boolean;
	focus?: boolean;
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
	// Keyed by VERB, not by message. `tab new --prompt` sends the same
	// `new_ai_tab_with_prompt` as `dispatch --new-tab` but has always focused,
	// while dispatch has always been background - so the message cannot be what
	// decides, or one of the two would change behaviour.
	const background = resolveBackgroundFlag(options, 'tab-new');

	try {
		const payload = prompt
			? { type: 'new_ai_tab_with_prompt', sessionId, prompt, background }
			: { type: 'new_tab', sessionId, background };
		const responseType = prompt ? 'new_ai_tab_with_prompt_result' : 'new_tab_result';
		const result = await sendSimpleCommand(payload, responseType);

		if (!result.success) {
			failCommand((result.error as string) || 'Failed to create tab', options.json);
		}
		const tabId = result.tabId as string | undefined;
		if (options.json) {
			console.log(JSON.stringify({ success: true, sessionId, tabId: tabId ?? null, background }));
		} else {
			console.log(
				formatSuccess(`Opened new tab for ${sessionId}${background ? ' (background tab)' : ''}`)
			);
			if (tabId) console.log(`  Tab: ${tabId}`);
		}
	} catch (error) {
		failFromError(error, options.json);
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
		return failFromError(error, options.json);
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
		failFromError(error, options.json);
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
		return failFromError(error, options.json);
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
		return failFromError(error, options.json);
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
		failFromError(error, options.json);
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
		failFromError(error, options.json);
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
		return failFromError(error, options.json);
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
		return failFromError(error, options.json);
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
 * model the local install knows about before Maestro has probed for it. `auto`
 * is the exception.
 */
export async function tabModel(
	tabId: string,
	model: string | null,
	options: TabMutateOptions
): Promise<void> {
	await tabFlag(
		tabId,
		{ customModel: isAutoModel(model) ? AUTO_MODEL : model },
		(owner) =>
			model === null
				? `Tab ${owner.tabId} now inherits its provider's model`
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
		return failFromError(error, options.json);
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
	row('Provider', entry.provider ?? entry.toolType);
	row('Agent default', entry.agentProvider ?? entry.toolType);
	row('Provider pin', entry.tabProvider ?? 'inherited');
	row('Turn provider', entry.turnProvider ?? '(unknown)');
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

interface ClosedTabOptions {
	/** Whose stack. Absent means the agent the desktop has selected. */
	agent?: string;
	json?: boolean;
}

interface TabReopenOptions extends ClosedTabOptions {
	/** Position in the stack, as typed (0 is what Cmd+Shift+T reopens next). */
	index?: string;
	/** The id the tab had when it was closed (exact or unique prefix). */
	tab?: string;
	background?: boolean;
	focus?: boolean;
}

interface ClosedTabResponse extends SimpleResult {
	closedTabs?: ClosedTabSummary[];
	reopened?: ClosedTabSummary;
	tabId?: string;
	tabType?: ClosedTabSummary['type'];
	wasDuplicate?: boolean;
	content?: string;
}

/**
 * The agent whose closed-tab stack a verb acts on: `--agent` when given, else
 * the agent the desktop has selected (the one Cmd+Shift+T would act on).
 */
function resolveClosedTabAgent(options: ClosedTabOptions): string {
	if (options.agent) return resolveAgentOrFail(options.agent, options.json);
	const active = readActiveAgentId();
	if (!active) {
		return failCommand(
			'No active agent recorded. Pass --agent <id> to say whose closed tabs you mean.',
			options.json
		);
	}
	try {
		return resolveAgentId(active);
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), options.json);
	}
}

/** Send one closed-tab verb and hand back the desktop's answer, or exit. */
async function sendClosedTabCommand(
	request: ClosedTabCommandRequest,
	json?: boolean
): Promise<ClosedTabResponse> {
	let result: ClosedTabResponse;
	try {
		result = (await sendSimpleCommand(
			{ type: 'closed_tab_command', ...request },
			'closed_tab_command_result'
		)) as ClosedTabResponse;
	} catch (error) {
		exitIfMaestroNotRunning(error, { json });
		return failCommand(error instanceof Error ? error.message : String(error), json);
	}
	// Outside the try, so the desktop's own refusal ("no closed tabs") is what
	// gets reported rather than being re-caught and re-worded.
	if (!result.success) {
		failCommand(result.error || errorFrameMessage(result) || 'Closed-tab command failed', json);
	}
	return result;
}

/** One row of `tab closed`, for a human. */
function describeClosedTab(entry: ClosedTabSummary): string {
	const kind = entry.tiled ? `${entry.type}, tiled` : entry.type;
	return `  ${String(entry.index).padStart(2)}  ${entry.label}  (${kind}, ${entry.tabId}, closed ${formatRelativeTime(entry.closedAt)})`;
}

/**
 * `maestro-cli tab closed` - list an agent's closed-tab stack, newest first.
 * Index 0 is the entry Cmd+Shift+T (and `tab reopen` with no target) restores
 * next. An empty stack is not an error here: "nothing to reopen" is an answer.
 */
export async function tabClosed(options: ClosedTabOptions): Promise<void> {
	const sessionId = resolveClosedTabAgent(options);
	const result = await sendClosedTabCommand({ action: 'list', sessionId }, options.json);
	const closedTabs = result.closedTabs ?? [];

	if (options.json) {
		console.log(JSON.stringify({ success: true, sessionId, closedTabs }, null, 2));
		return;
	}
	if (closedTabs.length === 0) {
		console.log(`No closed tabs for ${sessionId}`);
		return;
	}
	console.log(`Closed tabs for ${sessionId} (newest first):`);
	for (const entry of closedTabs) console.log(describeClosedTab(entry));
}

/**
 * `maestro-cli tab reopen` - restore one closed tab, by default the newest
 * (exactly what Cmd+Shift+T does), or the one named by `--index` / `--tab`.
 * Prints the restored tab's id, which is usually NEW for an AI tab.
 */
export async function tabReopen(options: TabReopenOptions): Promise<void> {
	const tabId = options.tab?.trim();
	if (options.index !== undefined && tabId) {
		failCommand('Pass --index or --tab, not both', options.json);
	}
	let index: number | undefined;
	if (options.index !== undefined) {
		const raw = options.index.trim();
		if (!/^\d+$/.test(raw)) {
			failCommand(
				`Invalid index "${options.index}". Use a 0-based position from "tab closed".`,
				options.json
			);
		}
		index = Number(raw);
	}

	const sessionId = resolveClosedTabAgent(options);
	const background = resolveBackgroundFlag(options, 'tab-reopen');
	const result = await sendClosedTabCommand(
		{
			action: 'reopen',
			sessionId,
			...(index !== undefined ? { index } : {}),
			...(tabId ? { tabId } : {}),
			background,
		},
		options.json
	);

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				sessionId,
				tabId: result.tabId ?? null,
				tabType: result.tabType ?? null,
				reopened: result.reopened ?? null,
				wasDuplicate: result.wasDuplicate === true,
				content: result.content ?? null,
				background,
			})
		);
		return;
	}
	const label = result.reopened?.label ?? 'tab';
	const where = background ? ' (background)' : '';
	console.log(
		formatSuccess(
			result.wasDuplicate
				? `"${label}" was already open; dropped it from the closed tabs${where}`
				: `Reopened "${label}" for ${sessionId}${where}`
		)
	);
	if (result.tabId) console.log(`  Tab: ${result.tabId}`);
	if (result.content === 'pending') {
		console.log('  Content is still loading in the desktop app.');
	} else if (result.content === 'unavailable' || result.content === 'failed') {
		console.log(`  Content could not be read back (${result.content}).`);
	}
}

interface TabContextOptions extends TabMutateOptions {
	background?: boolean;
	focus?: boolean;
}

interface TabMergeOptions extends TabContextOptions {
	/** The agent whose tab receives the context. */
	into: string;
	/** The tab that receives it (default: that agent's active AI tab). */
	targetTab?: string;
}

interface TabTransferOptions extends TabContextOptions {
	/** The agent that gets a new tab carrying the context. */
	to: string;
}

/** How each operation is named in a human-facing line. */
const TAB_CONTEXT_OP_LABELS: Record<TabContextOp, string> = {
	compact: 'compaction',
	merge: 'context merge',
	transfer: 'context transfer',
};

/**
 * A timeout is reported apart from a refusal: the desktop may still finish the
 * operation (a compaction is a full summarization turn), so the caller is told
 * to look rather than to retry. Exit 5, the CLI's code for "no answer in time".
 */
function failTabContextTimeout(op: TabContextOp, json?: boolean): never {
	const seconds = Math.round(TAB_CONTEXT_OP_REPLY_MS[op] / 1000);
	const message =
		`Timed out after ${seconds}s waiting for the ${TAB_CONTEXT_OP_LABELS[op]} to finish. ` +
		'It may still be running in Maestro; check with "maestro-cli session list".';
	if (json) console.log(JSON.stringify({ success: false, timedOut: true, error: message }));
	else console.error(`Error: ${message}`);
	return exitWith(ExitCode.Timeout);
}

/**
 * Resolve a tab argument (`active` by default) to its entry, and refuse a tab
 * that belongs to a different agent than `--agent` names.
 */
async function resolveContextTab(
	tabId: string | undefined,
	agent: string | undefined,
	json?: boolean
): Promise<DesktopTabEntry> {
	const agentId = agent ? resolveAgentOrFail(agent, json) : undefined;
	let entry: DesktopTabEntry;
	try {
		entry = await resolveTabEntry(tabId ?? ACTIVE_TAB_KEYWORD, agentId);
	} catch (error) {
		exitIfMaestroNotRunning(error, { json });
		return failCommand(error instanceof Error ? error.message : String(error), json);
	}
	if (agentId && entry.agentId !== agentId) {
		failCommand(`Tab ${entry.tabId} belongs to agent ${entry.agentId}, not ${agentId}`, json);
	}
	return entry;
}

/** Send one context operation and hand back the desktop's answer, or exit. */
async function sendTabContextOp(
	request: TabContextOpRequest,
	json?: boolean
): Promise<TabContextOpResult> {
	const { op } = request;
	let result: TabContextOpResult;
	try {
		result = await withMaestroClient((client) =>
			client.sendCommand<TabContextOpResult>(
				buildTabContextOpMessage(request),
				TAB_CONTEXT_OP_MESSAGES[op].resultType,
				TAB_CONTEXT_OP_REPLY_MS[op] + TAB_CONTEXT_OP_CLI_MARGIN_MS
			)
		);
	} catch (error) {
		exitIfMaestroNotRunning(error, { json });
		if (error instanceof CommandTimeoutError) failTabContextTimeout(op, json);
		return failFromError(error, json);
	}
	// Outside the try, so the desktop's own refusal is what gets reported.
	if (result.timedOut) failTabContextTimeout(op, json);
	if (!result.success) {
		failCommand(result.error || errorFrameMessage(result) || `Context ${op} failed`, json);
	}
	return result;
}

/**
 * `maestro-cli tab compact` - Context: Compact. Summarizes the tab into a new
 * tab beside it ("<name> Compacted <date>") and prints the new tab's id. The
 * source tab is left as it was, plus a line saying where the summary went.
 */
export async function tabCompact(
	tabId: string | undefined,
	options: TabContextOptions
): Promise<void> {
	const background = resolveBackgroundFlag(options, 'tab-compact');
	const entry = await resolveContextTab(tabId, options.agent, options.json);
	const result = await sendTabContextOp(
		{ op: 'compact', sessionId: entry.agentId, tabId: entry.tabId, background },
		options.json
	);

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				agentId: entry.agentId,
				tabId: entry.tabId,
				newTabId: result.newTabId ?? null,
				reductionPercent: result.reductionPercent ?? null,
				background,
			})
		);
		return;
	}
	const reduction =
		result.reductionPercent !== undefined ? ` (${result.reductionPercent}% smaller)` : '';
	console.log(formatSuccess(`Compacted tab ${entry.tabId} into a new tab${reduction}`));
	if (result.newTabId) console.log(`  Tab: ${result.newTabId}`);
}

/**
 * `maestro-cli tab merge` - Context: Merge Into. Moves the tab's transcript,
 * verbatim, into a tab of another agent (or another tab of the same agent),
 * whose composer sends it on. With `--background` the context waits on that
 * tab until it is next opened, unless it is already the tab on screen.
 */
export async function tabMerge(tabId: string | undefined, options: TabMergeOptions): Promise<void> {
	const background = resolveBackgroundFlag(options, 'tab-merge');
	const targetAgentId = resolveAgentOrFail(options.into, options.json);
	const entry = await resolveContextTab(tabId, options.agent, options.json);
	const targetTabId = options.targetTab
		? (await resolveContextTab(options.targetTab, targetAgentId, options.json)).tabId
		: undefined;
	const result = await sendTabContextOp(
		{
			op: 'merge',
			sessionId: entry.agentId,
			tabId: entry.tabId,
			targetSessionId: targetAgentId,
			...(targetTabId ? { targetTabId } : {}),
			background,
		},
		options.json
	);

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				agentId: entry.agentId,
				tabId: entry.tabId,
				targetAgentId,
				targetTabId: result.targetTabId ?? targetTabId ?? null,
				staged: result.staged === true,
				background,
			})
		);
		return;
	}
	console.log(formatSuccess(`Merged tab ${entry.tabId} into agent ${targetAgentId}`));
	if (result.targetTabId) console.log(`  Tab: ${result.targetTabId}`);
	if (result.staged) console.log('  The context sends when that tab is next opened.');
}

/**
 * `maestro-cli tab transfer` - Context: Send to Agent. Opens a new tab in the
 * target agent carrying the tab's transcript, verbatim, and starts the agent
 * on it (or queues it behind a running turn). Prints the new tab's id.
 */
export async function tabTransfer(
	tabId: string | undefined,
	options: TabTransferOptions
): Promise<void> {
	const background = resolveBackgroundFlag(options, 'tab-transfer');
	const targetAgentId = resolveAgentOrFail(options.to, options.json);
	const entry = await resolveContextTab(tabId, options.agent, options.json);
	if (entry.agentId === targetAgentId) {
		failCommand('Send to Agent needs a different agent than the source tab', options.json);
	}
	const result = await sendTabContextOp(
		{
			op: 'transfer',
			sessionId: entry.agentId,
			tabId: entry.tabId,
			targetSessionId: targetAgentId,
			background,
		},
		options.json
	);

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				agentId: entry.agentId,
				tabId: entry.tabId,
				targetAgentId,
				newTabId: result.newTabId ?? null,
				queued: result.queued === true,
				background,
			})
		);
		return;
	}
	console.log(formatSuccess(`Sent tab ${entry.tabId} to agent ${targetAgentId}`));
	if (result.newTabId) console.log(`  Tab: ${result.newTabId}`);
	if (result.queued) console.log('  The agent is busy; the context runs when its turn finishes.');
}
