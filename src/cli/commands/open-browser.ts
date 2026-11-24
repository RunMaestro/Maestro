// Open/close browser commands - manage browser tabs in the Maestro desktop app.
//
// `--background` creates the tab without moving the user: the active agent is
// left alone and the new tab does not become the visible one. This verb has had
// the flag since it shipped and is the model the others now follow. Agents doing
// research should always pass it, then `close-browser <tab-id>` when done.

import { withMaestroClient, resolveSessionId } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';
import { failCommand, resolveAgentOrActive } from '../services/session-command';
import { resolveBackgroundFlag } from '../../shared/focusPlacement';
import { BROWSER_PICK_TIMEOUT_MS } from '../../shared/coworkingBrowser';
import type {
	DesignPickCommandRequest,
	DesignPickCommandResult,
	DesignPickSummary,
} from '../../shared/designPickCommands';

interface OpenBrowserOptions {
	agent?: string;
	background?: boolean;
	focus?: boolean;
	json?: boolean;
}

interface CloseBrowserOptions {
	json?: boolean;
}

export async function openBrowser(url: string, options: OpenBrowserOptions): Promise<void> {
	let sessionId: string;
	if (options.agent) {
		try {
			sessionId = resolveAgentId(options.agent);
		} catch (error) {
			console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		}
	} else {
		sessionId = resolveSessionId({});
	}

	const trimmed = url.trim();
	if (!trimmed) {
		console.error('Error: URL cannot be empty');
		process.exit(1);
	}

	// Prepend https:// for scheme-less URLs so the user doesn't need to type it.
	// Require `://` so inputs like `localhost:3000` or `example.com:8080` are
	// treated as scheme-less host:port rather than an unknown protocol.
	const hasExplicitScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed);
	const normalized = hasExplicitScheme ? trimmed : `https://${trimmed}`;

	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		console.error(`Error: Invalid URL: ${url}`);
		process.exit(1);
	}

	// A scheme-less input that parses with userinfo (e.g. `foo:bar@baz`) is
	// almost certainly malformed - reject rather than silently prepending
	// `https://` and producing `https://foo:bar@baz/`.
	if (!hasExplicitScheme && (parsed.username || parsed.password)) {
		console.error(`Error: Invalid URL: ${url}`);
		process.exit(1);
	}

	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		console.error(`Error: Only http(s) URLs are supported (got ${parsed.protocol})`);
		process.exit(1);
	}

	const background = resolveBackgroundFlag(options, 'open-browser');

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{
				type: string;
				success: boolean;
				error?: string;
				tabId?: string;
			}>(
				{ type: 'open_browser_tab', sessionId, url: parsed.toString(), background },
				'open_browser_tab_result'
			);
		});

		if (result.success) {
			if (options.json) {
				console.log(
					JSON.stringify({
						success: true,
						sessionId,
						url: parsed.toString(),
						tabId: result.tabId ?? null,
						background,
					})
				);
			} else {
				console.log(
					`Opened ${parsed.toString()} in Maestro${background ? ' (background tab)' : ''}`
				);
				// Surface the id in plain output too - it's the handle for
				// `close-browser`, and agents shouldn't need --json just to clean up.
				if (result.tabId) console.log(`  Tab: ${result.tabId}`);
			}
		} else {
			const error = result.error || 'Failed to open browser tab';
			if (options.json) console.log(JSON.stringify({ success: false, error }));
			else console.error(`Error: ${error}`);
			process.exit(1);
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if (options.json) console.log(JSON.stringify({ success: false, error: msg }));
		else console.error(`Error: ${msg}`);
		process.exit(1);
	}
}

/**
 * Close a browser tab by the id `open-browser` returned. The owning agent is
 * resolved in the desktop app, so no --agent is needed.
 */
export async function closeBrowser(tabId: string, options: CloseBrowserOptions): Promise<void> {
	const trimmed = tabId.trim();
	if (!trimmed) {
		console.error('Error: Tab ID cannot be empty');
		process.exit(1);
	}

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{ type: string; success: boolean; error?: string }>(
				{ type: 'close_browser_tab', tabId: trimmed },
				'close_browser_tab_result'
			);
		});

		if (result.success) {
			if (options.json) console.log(JSON.stringify({ success: true, tabId: trimmed }));
			else console.log(`Closed browser tab ${trimmed}`);
		} else {
			const error = result.error || 'Failed to close browser tab';
			if (options.json) console.log(JSON.stringify({ success: false, error }));
			else console.error(`Error: ${error}`);
			process.exit(1);
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if (options.json) console.log(JSON.stringify({ success: false, error: msg }));
		else console.error(`Error: ${msg}`);
		process.exit(1);
	}
}

interface BrowserPickOptions {
	selector?: string;
	note?: string;
	agent?: string;
	background?: boolean;
	focus?: boolean;
	json?: boolean;
}

interface BrowserPickResult {
	type: string;
	success: boolean;
	error?: string;
	tabId?: string;
	browserId?: string;
	text?: string;
	screenshot?: boolean;
	aiTabId?: string;
	pickId?: string;
	background?: boolean;
}

/** The desktop gives a pick BROWSER_PICK_TIMEOUT_MS; wait a little longer so
 *  its own error (tab not live, no match) reaches the caller instead of a bare
 *  CLI timeout. */
const BROWSER_PICK_CLI_TIMEOUT_MS = BROWSER_PICK_TIMEOUT_MS + 5_000;

/**
 * Design Mode by selector: describe the first element matching `--selector`
 * in a browser tab (selector path, trimmed HTML, computed styles, cropped
 * screenshot) and stage it as a chip in the owning agent's composer, as a
 * click in Design Mode does. `<tab>` is the tab id `open-browser` printed, or
 * the tab's Coworking id (`browser:N`, which needs Coworking on).
 *
 * The chip is for the person at the composer; the caller gets the full block
 * the chip adds to the message at send, and the chip's id for `browser-picks`.
 */
export async function browserPick(tab: string, options: BrowserPickOptions): Promise<void> {
	const fail = (error: string): never => {
		if (options.json) console.log(JSON.stringify({ success: false, error }));
		else console.error(`Error: ${error}`);
		process.exit(1);
	};

	const tabRef = tab.trim();
	if (!tabRef) return fail('Tab cannot be empty');
	const selector = (options.selector ?? '').trim();
	if (!selector) return fail('--selector is required');

	let sessionId = '';
	try {
		// The agent the user has selected, not the first stored one: a pick lands
		// in a composer and can switch the view, so the wrong agent is visible harm.
		sessionId = resolveAgentOrActive(options.agent, 'whose tab you mean');
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}

	const background = resolveBackgroundFlag(options, 'browser-pick');

	let result: BrowserPickResult;
	try {
		result = await withMaestroClient((client) =>
			client.sendCommand<BrowserPickResult>(
				{
					type: 'pick_browser_element',
					sessionId,
					tab: tabRef,
					selector,
					...(options.note ? { note: options.note } : {}),
					background,
				},
				'pick_browser_element_result',
				BROWSER_PICK_CLI_TIMEOUT_MS
			)
		);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}

	if (!result.success) return fail(result.error || 'Failed to pick element');

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				sessionId,
				tabId: result.tabId ?? null,
				browserId: result.browserId ?? null,
				aiTabId: result.aiTabId ?? null,
				pickId: result.pickId ?? null,
				selector,
				screenshot: result.screenshot === true,
				background,
				text: result.text ?? '',
			})
		);
		return;
	}
	console.log(
		`Added ${selector} from ${tabRef} to the composer of tab ${result.aiTabId ?? 'unknown'}${
			background ? ' (background)' : ''
		}`
	);
	// The chip id is the handle for `browser-picks --remove`; a plain-mode
	// caller should not need --json to get it.
	if (result.pickId) console.log(`  Chip: ${result.pickId}`);
	if (result.browserId) console.log(`  Coworking id: ${result.browserId}`);
	console.log(`  Screenshot: ${result.screenshot ? 'attached' : 'none'}`);
	// The chip in the composer is short; the caller gets what it adds at send.
	if (result.text) console.log(`\n${result.text}`);
}

interface BrowserPicksOptions {
	agent?: string;
	remove?: string;
	json?: boolean;
}

/** One chip in plain output: id, kind and label, then what else it carries. */
function describeDesignPick(pick: DesignPickSummary): string {
	return [
		`${pick.id}  ${pick.kind}  ${pick.label}`,
		`  URL: ${pick.url || '(none)'}`,
		`  Note: ${pick.note || '(none)'}`,
		`  Screenshot: ${pick.screenshot ? 'attached' : 'none'}`,
	].join('\n');
}

/**
 * The Design Mode chips waiting in an agent's composer: the strip a person
 * sees above the message box. Lists the chips on the agent's composer target
 * tab (the tab a pick lands in) in the order they are sent, each with the
 * block it adds to the message; `--remove <pickId>` takes one off, as the
 * chip's X does.
 */
export async function browserPicks(options: BrowserPicksOptions): Promise<void> {
	const { json } = options;
	const pickId = options.remove?.trim();
	if (options.remove !== undefined && !pickId) {
		return failCommand('--remove needs a chip id (from browser-picks or browser-pick)', json);
	}

	let sessionId: string;
	try {
		// The agent on screen, like `browser-pick`: the chips belong to a composer.
		sessionId = resolveAgentOrActive(options.agent, 'whose composer you mean');
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), json);
	}

	const request: DesignPickCommandRequest = pickId
		? { action: 'remove', sessionId, pickId }
		: { action: 'list', sessionId };
	let result: DesignPickCommandResult;
	try {
		result = await withMaestroClient((client) =>
			client.sendCommand<DesignPickCommandResult>(
				{ type: 'design_pick_command', ...request },
				'design_pick_command_result'
			)
		);
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), json);
	}
	if (!result.success) return failCommand(result.error || 'Design Mode chip command failed', json);

	const aiTabId = result.aiTabId ?? null;
	const where = `the composer of tab ${aiTabId ?? 'unknown'}`;

	if (pickId) {
		const removed = result.removed ?? null;
		if (json) {
			console.log(JSON.stringify({ success: true, sessionId, aiTabId, removed }));
			return;
		}
		console.log(
			`Removed Design Mode chip ${pickId}${removed ? ` (${removed.label})` : ''} from ${where}`
		);
		return;
	}

	const picks = result.picks ?? [];
	if (json) {
		console.log(JSON.stringify({ success: true, sessionId, aiTabId, picks }));
		return;
	}
	if (picks.length === 0) {
		console.log(`No Design Mode chips in ${where}`);
		return;
	}
	console.log(`Design Mode chips in ${where} (${picks.length}):`);
	for (const pick of picks) console.log(`\n${describeDesignPick(pick)}\n\n${pick.text}`);
}
