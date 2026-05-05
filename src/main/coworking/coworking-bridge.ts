/**
 * Coworking bridge — main-process IPC server that the coworking-mcp-server
 * subprocess connects back to.
 *
 * Transport: Unix domain socket (Linux/macOS) or named pipe (Windows). Path
 * comes from `getBridgeSocketPath()` and is stable per-userData. The coworking
 * MCP server learns the path via the `MAESTRO_COWORKING_SOCKET` env var that
 * each per-agent installer writes into the user's MCP config.
 *
 * Wire format: newline-delimited JSON-RPC-shaped requests / responses
 * (`{id, method, params}` / `{id, result}` or `{id, error}`).
 *
 * Session binding: every connection MUST send `{method: "hello", params:{sessionId}}`
 * as its first message. The bridge stores that sessionId per-connection and uses it
 * to scope tool calls. Pre-handshake `listTerminals`/`readTerminal` calls are rejected.
 * This is what stops Agent A from reading Agent B's terminals when the user switches
 * focus mid-call (the privacy bug fixed in PR #948).
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { logger } from '../utils/logger';
import { COWORKING_SOCKET_ENV_VAR } from './coworking-types';
import type {
	CoworkingBridgeRequest,
	CoworkingBridgeResponse,
	CoworkingBridgeMethod,
} from './coworking-types';
import { listTerminals, readTerminal } from './coworking-tools';

const LOG_CTX = '[Coworking][Bridge]';

let server: net.Server | null = null;

/** Per-connection state keyed by socket. The sessionId is set on `hello` and
 *  stays put for the lifetime of the connection. */
const connections = new WeakMap<net.Socket, { sessionId: string | null }>();

/** Compute the platform-appropriate IPC bridge socket path. */
export function getBridgeSocketPath(): string {
	if (process.platform === 'win32') {
		// Per-user named pipe; userData path is unique per OS user.
		const slug = path.basename(app.getPath('userData')).replace(/[^A-Za-z0-9_-]/g, '_');
		return `\\\\.\\pipe\\maestro-coworking-${slug}`;
	}
	return path.join(app.getPath('userData'), 'coworking.sock');
}

/** Env-var pair to embed in each agent's MCP-server config entry. */
export function getBridgeEnvVar(): { name: string; value: string } {
	return { name: COWORKING_SOCKET_ENV_VAR, value: getBridgeSocketPath() };
}

/** Start the bridge. Idempotent. Must be called inside `app.whenReady`. */
export async function startCoworkingBridge(): Promise<void> {
	if (server) return;

	const socketPath = getBridgeSocketPath();

	// Clean up stale socket file from a prior crashed run (POSIX only).
	if (process.platform !== 'win32') {
		try {
			await fs.promises.unlink(socketPath);
		} catch (e) {
			const code = (e as NodeJS.ErrnoException)?.code;
			if (code && code !== 'ENOENT') {
				logger.warn(`${LOG_CTX} Could not clean stale socket: ${String(e)}`, 'Coworking');
			}
		}
	}

	const srv = net.createServer((conn) => handleConnection(conn));
	srv.on('error', (err) => {
		logger.error(`${LOG_CTX} server error: ${err.message}`, 'Coworking');
	});

	await new Promise<void>((resolve, reject) => {
		const onError = (err: Error) => {
			srv.removeListener('listening', onListening);
			reject(err);
		};
		const onListening = () => {
			srv.removeListener('error', onError);
			resolve();
		};
		srv.once('error', onError);
		srv.once('listening', onListening);
		srv.listen(socketPath);
	});

	server = srv;
	logger.info(`${LOG_CTX} listening on ${socketPath}`, 'Coworking');
}

/** Stop the bridge. Idempotent. Called on app quit. */
export async function stopCoworkingBridge(): Promise<void> {
	if (!server) return;
	const srv = server;
	server = null;
	await new Promise<void>((resolve) => {
		srv.close(() => resolve());
	});
}

function handleConnection(conn: net.Socket): void {
	connections.set(conn, { sessionId: null });
	conn.setEncoding('utf8');
	let buffer = '';
	conn.on('data', (chunk) => {
		buffer += chunk;
		let nl: number;
		while ((nl = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line) continue;
			handleLine(conn, line).catch((err) => {
				logger.error(`${LOG_CTX} dispatch failed: ${String(err)}`, 'Coworking');
			});
		}
	});
	conn.on('error', (err) => {
		logger.warn(`${LOG_CTX} connection error: ${err.message}`, 'Coworking');
	});
	conn.on('close', () => {
		connections.delete(conn);
	});
}

async function handleLine(conn: net.Socket, line: string): Promise<void> {
	let req: CoworkingBridgeRequest;
	try {
		req = JSON.parse(line) as CoworkingBridgeRequest;
	} catch {
		// Bad JSON — close the connection. The MCP subprocess will log and exit.
		conn.end();
		return;
	}
	const resp = await dispatch(conn, req);
	conn.write(JSON.stringify(resp) + '\n');
}

async function dispatch(
	conn: net.Socket,
	req: CoworkingBridgeRequest
): Promise<CoworkingBridgeResponse> {
	const method = req.method as CoworkingBridgeMethod;
	const state = connections.get(conn);
	try {
		if (method === 'hello') {
			const params = (req.params ?? {}) as { sessionId?: string };
			if (typeof params.sessionId !== 'string' || params.sessionId.length === 0) {
				return {
					id: req.id,
					error: { code: -32602, message: '`sessionId` is required for hello' },
				};
			}
			if (state) state.sessionId = params.sessionId;
			return { id: req.id, result: { ok: true } };
		}

		// Every other RPC requires a bound session.
		const sessionId = state?.sessionId;
		if (!sessionId) {
			return {
				id: req.id,
				error: {
					code: -32002,
					message: 'coworking bridge: handshake required (send `hello` with sessionId first)',
				},
			};
		}

		if (method === 'listTerminals') {
			return { id: req.id, result: listTerminals(sessionId) };
		}
		if (method === 'readTerminal') {
			const params = (req.params ?? {}) as { id?: string; lines?: number };
			if (typeof params.id !== 'string') {
				return { id: req.id, error: { code: -32602, message: '`id` is required' } };
			}
			const result = await readTerminal(sessionId, { id: params.id, lines: params.lines });
			return { id: req.id, result };
		}
		return { id: req.id, error: { code: -32601, message: `Unknown method: ${String(method)}` } };
	} catch (err) {
		return {
			id: req.id,
			error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
		};
	}
}

/** Test-only: synthetic dispatch that bypasses the network and exposes per-connection state. */
export const __testing = {
	dispatch,
	connections,
};
