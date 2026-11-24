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
import {
	BROWSER_PICK_RECT_MIN_SIDE,
	BROWSER_PICK_TIMEOUT_MS,
	formatBrowserPickRect,
	parseBrowserPickRect,
	type BrowserPickTarget,
} from '../../shared/coworkingBrowser';
import type {
	DesignPickCommandRequest,
	DesignPickCommandResult,
	DesignPickSummary,
} from '../../shared/designPickCommands';
import {
	BROWSER_VIEWPORT_PRESETS,
	browserViewportWidth,
	describeBrowserViewport,
	parseBrowserViewportPreset,
	type BrowserViewportPreset,
} from '../../shared/browserViewport';

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
	/** `x,y,width,height` in the page's CSS px; the region instead of an element. */
	rect?: string;
	note?: string;
	agent?: string;
	background?: boolean;
	focus?: boolean;
	queue?: boolean;
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
	queueItemId?: string;
	background?: boolean;
}

/** The desktop gives a pick BROWSER_PICK_TIMEOUT_MS; wait a little longer so
 *  its own error (tab not live, no match) reaches the caller instead of a bare
 *  CLI timeout. */
const BROWSER_PICK_CLI_TIMEOUT_MS = BROWSER_PICK_TIMEOUT_MS + 5_000;

/**
 * Design Mode by selector or by region: describe the first element matching
 * `--selector` in a browser tab (selector path, trimmed HTML, computed styles,
 * cropped screenshot), or list the outermost elements in the `--rect` box with
 * the region's screenshot, and stage it as a chip in the owning agent's
 * composer, as a click or a drag in Design Mode does. Exactly one of the two.
 * `<tab>` is the tab id `open-browser` printed, or the tab's Coworking id
 * (`browser:N`, which needs Coworking on).
 *
 * `--rect x,y,width,height` is in the page's CSS px from the top-left of its
 * viewport (what `getBoundingClientRect()` reports), so it names what is on
 * screen now; the page clips the box to its viewport, as a drag stops at the
 * page's edge.
 *
 * The chip is for the person at the composer; the caller gets the full block
 * the chip adds to the message at send, and the chip's id for `browser-picks`.
 *
 * `--queue` is the pick card's Queue button: the pick goes out as its own
 * message on the agent's execution queue (an idle agent starts it, a busy one
 * runs it after its turn) and no chip is staged. The composer and the view stay
 * as they are, so the caller gets the queue item's id for `queue remove`
 * instead of a chip id, and the same block.
 */
export async function browserPick(tab: string, options: BrowserPickOptions): Promise<void> {
	const fail = (error: string): never => {
		if (options.json) console.log(JSON.stringify({ success: false, error }));
		else console.error(`Error: ${error}`);
		process.exit(1);
	};

	const tabRef = tab.trim();
	if (!tabRef) return fail('Tab cannot be empty');
	// An element or a region, never both: a flag that is present counts, even
	// blank, so a script that fills both is told rather than guessed for.
	if (options.selector !== undefined && options.rect !== undefined) {
		return fail('Pass --selector or --rect, not both');
	}
	let target: BrowserPickTarget;
	if (options.rect !== undefined) {
		const rect = parseBrowserPickRect(options.rect);
		if (!rect) {
			return fail(
				`--rect must be x,y,width,height in CSS px, with width and height at least ${BROWSER_PICK_RECT_MIN_SIDE} (got "${options.rect}")`
			);
		}
		target = { rect };
	} else {
		const selector = (options.selector ?? '').trim();
		if (!selector) return fail('--selector or --rect is required');
		target = { selector };
	}
	// How the summary names the pick: the selector, or the region as typed.
	const picked =
		target.rect !== undefined ? `region ${formatBrowserPickRect(target.rect)}` : target.selector;

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
					...target,
					...(options.note ? { note: options.note } : {}),
					background,
					...(options.queue ? { queue: true } : {}),
				},
				'pick_browser_element_result',
				BROWSER_PICK_CLI_TIMEOUT_MS
			)
		);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}

	if (!result.success) {
		return fail(result.error || (target.rect ? 'Failed to pick region' : 'Failed to pick element'));
	}

	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				sessionId,
				tabId: result.tabId ?? null,
				browserId: result.browserId ?? null,
				aiTabId: result.aiTabId ?? null,
				pickId: result.pickId ?? null,
				queueItemId: result.queueItemId ?? null,
				// What was asked for: one is set, the other null.
				selector: target.selector ?? null,
				rect: target.rect ?? null,
				screenshot: result.screenshot === true,
				background,
				text: result.text ?? '',
			})
		);
		return;
	}
	if (options.queue) {
		// Nothing moved, so there is no "(background)" to report.
		console.log(
			`Queued ${picked} from ${tabRef} for tab ${result.aiTabId ?? 'unknown'} as its own message`
		);
		// The handle for `queue remove`, like the chip id below.
		if (result.queueItemId) console.log(`  Queue item: ${result.queueItemId}`);
	} else {
		console.log(
			`Added ${picked} from ${tabRef} to the composer of tab ${result.aiTabId ?? 'unknown'}${
				background ? ' (background)' : ''
			}`
		);
		// The chip id is the handle for `browser-picks --remove`; a plain-mode
		// caller should not need --json to get it.
		if (result.pickId) console.log(`  Chip: ${result.pickId}`);
	}
	if (result.browserId) console.log(`  Coworking id: ${result.browserId}`);
	console.log(`  Screenshot: ${result.screenshot ? 'attached' : 'none'}`);
	// The chip in the composer is short; the caller gets what it adds at send.
	if (result.text) console.log(`\n${result.text}`);
}

interface BrowserPicksOptions {
	agent?: string;
	remove?: string;
	edit?: string;
	note?: string;
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
 * block it adds to the message; `--edit <pickId> --note <text>` replaces a
 * chip's note, as the chip's note box does (an empty note clears it);
 * `--remove <pickId>` takes one off, as the chip's X does.
 */
export async function browserPicks(options: BrowserPicksOptions): Promise<void> {
	const { json } = options;
	if (options.remove !== undefined && options.edit !== undefined) {
		return failCommand('Pass --remove or --edit, not both', json);
	}
	const removeId = options.remove?.trim();
	if (options.remove !== undefined && !removeId) {
		return failCommand('--remove needs a chip id (from browser-picks or browser-pick)', json);
	}
	const editId = options.edit?.trim();
	if (options.edit !== undefined && !editId) {
		return failCommand('--edit needs a chip id (from browser-picks or browser-pick)', json);
	}
	if (editId && options.note === undefined) {
		return failCommand('--edit needs --note <text> (an empty note clears it)', json);
	}
	if (!editId && options.note !== undefined) {
		return failCommand('--note needs --edit <pickId> to say which chip', json);
	}

	let sessionId: string;
	try {
		// The agent on screen, like `browser-pick`: the chips belong to a composer.
		sessionId = resolveAgentOrActive(options.agent, 'whose composer you mean');
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), json);
	}

	const request: DesignPickCommandRequest = removeId
		? { action: 'remove', sessionId, pickId: removeId }
		: editId
			? { action: 'note', sessionId, pickId: editId, note: options.note ?? '' }
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

	if (removeId) {
		const removed = result.removed ?? null;
		if (json) {
			console.log(JSON.stringify({ success: true, sessionId, aiTabId, removed }));
			return;
		}
		console.log(
			`Removed Design Mode chip ${removeId}${removed ? ` (${removed.label})` : ''} from ${where}`
		);
		return;
	}

	if (editId) {
		// The chip as it reads now, so the write is its own read.
		const edited = result.edited ?? null;
		if (json) {
			console.log(JSON.stringify({ success: true, sessionId, aiTabId, edited }));
			return;
		}
		console.log(`Updated the note on Design Mode chip ${editId} in ${where}`);
		if (edited) console.log(describeDesignPick(edited));
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

interface BrowserViewportOptions {
	agent?: string;
	json?: boolean;
}

interface BrowserViewportReply {
	type: string;
	success: boolean;
	error?: string;
	tabId?: string;
	browserId?: string;
	preset?: string;
	previous?: string;
}

/**
 * Set or read a browser tab's viewport preset: the width the tab shows its page
 * at (`fit`, `desktop` 1440, `laptop` 1280, `tablet` 768, `phone` 390), as the
 * toolbar's viewport control and the palette's `Browser: Viewport ...` entries
 * choose it. With a preset it sets it; without, it only reads. Either way it
 * reports the preset the tab shows afterwards and the one it showed before, so
 * a write is its own read and `Was:` is the way back.
 *
 * `<tab>` is the tab id `open-browser` printed, or the tab's Coworking id
 * (`browser:N`, which needs Coworking on). The preset is a saved field of the
 * tab, so the tab need not be on screen, and nothing moves the view.
 */
export async function browserViewport(
	tab: string,
	preset: string | undefined,
	options: BrowserViewportOptions
): Promise<void> {
	const { json } = options;
	const tabRef = tab.trim();
	if (!tabRef) return failCommand('Tab cannot be empty', json);

	// A preset that is given but is not one of the five is refused, never read as
	// "no preset": a script that typos `phone` must not get a quiet read back.
	let wanted: BrowserViewportPreset | undefined;
	if (preset !== undefined) {
		const parsed = parseBrowserViewportPreset(preset);
		if (!parsed) {
			return failCommand(
				`Unknown viewport preset "${preset}". Use one of: ${BROWSER_VIEWPORT_PRESETS.join(', ')}`,
				json
			);
		}
		wanted = parsed;
	}

	let sessionId: string;
	try {
		// The agent on screen, like `browser-pick`: the tab is looked up in its list.
		sessionId = resolveAgentOrActive(options.agent, 'whose tab you mean');
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), json);
	}

	let result: BrowserViewportReply;
	try {
		result = await withMaestroClient((client) =>
			client.sendCommand<BrowserViewportReply>(
				{
					type: 'browser_viewport',
					sessionId,
					tab: tabRef,
					...(wanted ? { preset: wanted } : {}),
				},
				'browser_viewport_result'
			)
		);
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), json);
	}
	if (!result.success) {
		return failCommand(result.error || 'Failed to set or read the viewport', json);
	}

	// What the tab shows now, as the desktop read it back from the tab itself.
	const current = parseBrowserViewportPreset(result.preset);
	const previous = parseBrowserViewportPreset(result.previous);
	if (!current || !previous) {
		return failCommand("Maestro did not report the tab's viewport", json);
	}
	const changed = current !== previous;

	if (json) {
		console.log(
			JSON.stringify({
				success: true,
				sessionId,
				tabId: result.tabId ?? null,
				browserId: result.browserId ?? null,
				preset: current,
				width: browserViewportWidth(current),
				previous,
				changed,
			})
		);
		return;
	}
	if (!wanted) {
		console.log(`The viewport of ${tabRef} is ${describeBrowserViewport(current)}`);
	} else if (changed) {
		console.log(`Set the viewport of ${tabRef} to ${describeBrowserViewport(current)}`);
		console.log(`  Was: ${describeBrowserViewport(previous)}`);
	} else {
		console.log(`The viewport of ${tabRef} is already ${describeBrowserViewport(current)}`);
	}
}
