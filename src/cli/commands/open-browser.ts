// Open browser command - open a URL as a browser tab in the Maestro desktop app

import { withMaestroClient, resolveSessionId } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';

interface OpenBrowserOptions {
	agent?: string;
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
	// almost certainly malformed — reject rather than silently prepending
	// `https://` and producing `https://foo:bar@baz/`.
	if (!hasExplicitScheme && (parsed.username || parsed.password)) {
		console.error(`Error: Invalid URL: ${url}`);
		process.exit(1);
	}

	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		console.error(`Error: Only http(s) URLs are supported (got ${parsed.protocol})`);
		process.exit(1);
	}

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{ type: string; success: boolean; error?: string }>(
				{ type: 'open_browser_tab', sessionId, url: parsed.toString() },
				'open_browser_tab_result'
			);
		});

		if (result.success) {
			console.log(`Opened ${parsed.toString()} in Maestro`);
		} else {
			console.error(`Error: ${result.error || 'Failed to open browser tab'}`);
			process.exit(1);
		}
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
