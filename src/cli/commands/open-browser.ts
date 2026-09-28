// Open/close browser commands - manage browser tabs in the Maestro desktop app.
//
// `--background` creates the tab without moving the user: the active agent is
// left alone and the new tab does not become the visible one. This verb has had
// the flag since it shipped and is the model the others now follow. Agents doing
// research should always pass it, then `close-browser <tab-id>` when done.

import { withMaestroClient, resolveSessionId } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';
import { resolveBackgroundFlag } from '../../shared/focusPlacement';

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
