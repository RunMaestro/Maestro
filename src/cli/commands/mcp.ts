/**
 * `maestro-cli mcp serve` - an MCP stdio server that exposes the running app's
 * registered plugin tools to an agent's model.
 *
 * An agent (claude/codex/opencode/...) launches this as a subprocess and speaks
 * MCP over its stdin/stdout. We bridge `tools/list` / `tools/call` to the desktop
 * app over the existing CLI WebSocket, where each call is risk-gated before the
 * broker invokes the plugin handler.
 *
 * Wire discipline (MCP stdio, 2025-06-18 spec): messages are newline-delimited
 * JSON, one per line, no embedded newlines. stdout carries ONLY MCP messages; all
 * diagnostics go to stderr. The framing lives here; the protocol + app bridge are
 * in `mcp-protocol.ts` / `mcp-bridge.ts`.
 */
import { MaestroClient } from '../services/maestro-client';
import { createMcpBridge } from '../services/mcp-bridge';

interface McpServeOptions {
	/** Originating desktop tab id - diagnostics only. */
	tab?: string;
}

export async function mcpServe(options: McpServeOptions): Promise<void> {
	// stderr is the ONLY log channel; stdout is reserved for MCP messages.
	const log = (msg: string): void => {
		process.stderr.write(`${msg}\n`);
	};

	if (options.tab) log(`[mcp] serving plugin tools for tab ${options.tab}`);

	const client = new MaestroClient();
	try {
		await client.connect();
	} catch (e) {
		// Serve anyway: the agent's MCP handshake should still succeed; tools/list
		// will report zero tools until the app is reachable.
		log(`[mcp] not connected to Maestro: ${e instanceof Error ? e.message : String(e)}`);
	}

	const { server } = createMcpBridge({
		serverInfo: { name: 'maestro-plugins', version: '1.0.0' },
		request: (message, responseType, timeoutMs) =>
			client.sendCommand(message, responseType, timeoutMs),
		log,
	});

	// Newline-delimited JSON-RPC read loop.
	let buffer = '';
	process.stdin.setEncoding('utf8');

	const handleLine = (line: string): void => {
		const trimmed = line.trim();
		if (!trimmed) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			// Malformed JSON-RPC frame: per the spec, answer with a Parse Error
			// (id null) rather than silently dropping it, which can hang clients.
			log('[mcp] malformed JSON-RPC frame on stdin');
			const parseError = {
				jsonrpc: '2.0',
				id: null,
				error: { code: -32700, message: 'Parse error' },
			};
			process.stdout.write(`${JSON.stringify(parseError)}\n`);
			return;
		}
		void server
			.handleMessage(parsed)
			.then((response) => {
				if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
			})
			.catch((e) => log(`[mcp] handler error: ${e instanceof Error ? e.message : String(e)}`));
	};

	process.stdin.on('data', (chunk: string) => {
		buffer += chunk;
		let nl = buffer.indexOf('\n');
		while (nl >= 0) {
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			handleLine(line);
			nl = buffer.indexOf('\n');
		}
	});

	// Resolve when the client closes stdin (subprocess teardown).
	await new Promise<void>((resolve) => {
		process.stdin.on('end', () => {
			client.disconnect();
			resolve();
		});
		process.stdin.on('close', () => {
			client.disconnect();
			resolve();
		});
	});
}
