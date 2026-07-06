/**
 * Stdio MCP bridge for the Claude Code permission relay.
 *
 * Claude Code spawns this script as an MCP server (via `--mcp-config`) and is
 * told to use its `approve` tool for permission prompts (via
 * `--permission-prompt-tool`). When Claude wants to run a non-allowed tool it
 * calls `approve`; this bridge forwards the request over a unix-domain socket
 * to the Maestro main process, waits for the user's decision, and returns it.
 *
 * Runs as a standalone Node process (under Electron via ELECTRON_RUN_AS_NODE),
 * so it must use ONLY Node builtins. It imports runtime constants from
 * `./types`, which is likewise builtins-only, keeping the compiled
 * `dist/main/permission-relay/bridge.js` self-contained.
 *
 * PROTOCOL DISCIPLINE: stdout carries ONLY newline-delimited JSON-RPC. All
 * diagnostics go to stderr.
 */

import * as net from 'net';
import type { BridgeToServerMessage, PermissionDecision, ServerToBridgeMessage } from './types';
import {
	RELAY_MCP_TOOL_NAME,
	RELAY_SOCKET_ENV,
	RELAY_TOKEN_ENV,
	RELAY_DECISION_TIMEOUT_MS,
} from './types';

const PROTOCOL_VERSION_DEFAULT = '2024-11-05';
const SERVER_INFO = { name: 'maestro-permissions', version: '1.0.0' };

function logStderr(message: string): void {
	process.stderr.write(`[maestro-relay-bridge] ${message}\n`);
}

// --- JSON-RPC output (stdout) ---

function writeMessage(msg: Record<string, unknown>): void {
	process.stdout.write(JSON.stringify(msg) + '\n');
}

function writeResult(id: unknown, result: unknown): void {
	writeMessage({ jsonrpc: '2.0', id, result });
}

function writeError(id: unknown, code: number, message: string): void {
	writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

// --- Socket to Maestro ---

const socketPath = process.env[RELAY_SOCKET_ENV];
const token = process.env[RELAY_TOKEN_ENV];

let socket: net.Socket | null = null;
let socketReady: Promise<net.Socket> | null = null;
let localReqCounter = 0;
const pending = new Map<string, (decision: PermissionDecision) => void>();

function connectSocket(): Promise<net.Socket> {
	if (socketReady) {
		return socketReady;
	}
	socketReady = new Promise<net.Socket>((resolve, reject) => {
		if (!socketPath || !token) {
			reject(new Error('relay socket path/token missing from env'));
			return;
		}
		const s = net.createConnection(socketPath);
		s.setEncoding('utf8');
		let buffer = '';

		s.on('connect', () => {
			socket = s;
			sendToServer(s, { type: 'hello', token });
			resolve(s);
		});
		s.on('data', (chunk: string) => {
			buffer += chunk;
			let idx: number;
			while ((idx = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (line.length > 0) {
					handleServerLine(line);
				}
			}
		});
		s.on('error', (err) => {
			logStderr(`socket error: ${err.message}`);
			reject(err);
		});
		s.on('close', () => {
			socket = null;
			socketReady = null;
			// Deny anything still waiting - the relay is gone.
			for (const [, resolvePending] of pending) {
				resolvePending({ behavior: 'deny', message: 'Permission relay disconnected.' });
			}
			pending.clear();
		});
	});
	return socketReady;
}

function sendToServer(s: net.Socket, msg: BridgeToServerMessage): void {
	s.write(JSON.stringify(msg) + '\n');
}

function handleServerLine(line: string): void {
	let msg: ServerToBridgeMessage;
	try {
		msg = JSON.parse(line) as ServerToBridgeMessage;
	} catch {
		logStderr('unparseable line from server');
		return;
	}
	if (msg.type === 'permission-response') {
		const resolvePending = pending.get(msg.requestId);
		if (resolvePending) {
			pending.delete(msg.requestId);
			resolvePending(msg.decision);
		}
	}
	// hello-ack is informational; nothing to do.
}

/** Forward a permission request to Maestro and await the decision. */
async function requestDecision(
	toolName: string,
	input: Record<string, unknown>
): Promise<PermissionDecision> {
	let s: net.Socket;
	try {
		s = await connectSocket();
	} catch (e) {
		return {
			behavior: 'deny',
			message: `Could not reach Maestro permission relay: ${
				e instanceof Error ? e.message : String(e)
			}`,
		};
	}

	const requestId = `b${++localReqCounter}`;
	return new Promise<PermissionDecision>((resolve) => {
		const timer = setTimeout(() => {
			pending.delete(requestId);
			resolve({ behavior: 'deny', message: 'Permission request timed out.' });
		}, RELAY_DECISION_TIMEOUT_MS + 5_000);
		if (typeof timer.unref === 'function') {
			timer.unref();
		}
		pending.set(requestId, (decision) => {
			clearTimeout(timer);
			resolve(decision);
		});
		sendToServer(s, {
			type: 'permission-request',
			token: token as string,
			requestId,
			toolName,
			input,
		});
	});
}

// --- MCP request handling (stdin) ---

async function handleRpc(msg: Record<string, unknown>): Promise<void> {
	const { id, method, params } = msg as {
		id?: unknown;
		method?: string;
		params?: Record<string, unknown>;
	};

	// Notifications (no id) require no response.
	if (id === undefined || id === null) {
		return;
	}

	switch (method) {
		case 'initialize': {
			const clientProtocol =
				(params?.protocolVersion as string | undefined) ?? PROTOCOL_VERSION_DEFAULT;
			writeResult(id, {
				protocolVersion: clientProtocol,
				capabilities: { tools: {} },
				serverInfo: SERVER_INFO,
			});
			return;
		}
		case 'ping': {
			writeResult(id, {});
			return;
		}
		case 'tools/list': {
			writeResult(id, {
				tools: [
					{
						name: RELAY_MCP_TOOL_NAME,
						description:
							'Maestro permission prompt. Routes Claude Code tool-permission ' +
							'requests to the Maestro UI for an interactive allow/deny decision.',
						inputSchema: {
							type: 'object',
							properties: {
								tool_name: {
									type: 'string',
									description: 'The tool Claude is requesting permission to use.',
								},
								input: {
									type: 'object',
									description: 'The proposed input for that tool.',
								},
							},
							required: ['tool_name', 'input'],
						},
					},
				],
			});
			return;
		}
		case 'tools/call': {
			const name = params?.name as string | undefined;
			const args = (params?.arguments as Record<string, unknown> | undefined) ?? {};
			if (name !== RELAY_MCP_TOOL_NAME) {
				writeError(id, -32602, `Unknown tool: ${String(name)}`);
				return;
			}
			const toolName = (args.tool_name as string | undefined) ?? 'unknown';
			const toolInput = (args.input as Record<string, unknown> | undefined) ?? {};
			const decision = await requestDecision(toolName, toolInput);
			// The permission-prompt-tool contract: result text is the JSON of the
			// PermissionResult. On allow, echo the (unchanged) input as updatedInput.
			const payload =
				decision.behavior === 'allow'
					? { behavior: 'allow', updatedInput: decision.updatedInput ?? toolInput }
					: { behavior: 'deny', message: decision.message };
			writeResult(id, {
				content: [{ type: 'text', text: JSON.stringify(payload) }],
			});
			return;
		}
		default: {
			writeError(id, -32601, `Method not found: ${String(method)}`);
			return;
		}
	}
}

function main(): void {
	let buffer = '';
	process.stdin.setEncoding('utf8');
	process.stdin.on('data', (chunk: string) => {
		buffer += chunk;
		let idx: number;
		while ((idx = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, idx).trim();
			buffer = buffer.slice(idx + 1);
			if (line.length === 0) {
				continue;
			}
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(line);
			} catch {
				logStderr('unparseable rpc line from stdin');
				continue;
			}
			void handleRpc(msg);
		}
	});
	process.stdin.on('end', () => {
		if (socket) {
			socket.end();
		}
		process.exit(0);
	});
	logStderr('bridge started');
}

main();
