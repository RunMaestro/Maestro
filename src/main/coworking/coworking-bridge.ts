/**
 * Coworking bridge - main-process IPC server that the coworking-mcp-server
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
 * Session binding: every connection MUST send `{method: "hello", params: {...}}`
 * as its first message. The bridge stores the resolved sessionId per-connection
 * and uses it to scope tool calls. Pre-handshake `listTerminals`/`readTerminal`
 * calls are rejected. This is what stops Agent A from reading Agent B's terminals
 * when the user switches focus mid-call (the privacy bug fixed in PR #948).
 *
 * The hello payload supports two resolution sources, in priority order:
 *   1. `sessionId`: injected via `MAESTRO_COWORKING_SESSION_ID` env at agent-CLI
 *      spawn time and propagated by the agent CLI to its MCP subprocess. Works
 *      for Claude Code and OpenCode.
 *   2. `ppid`: the MCP subprocess's parent PID. Used when the agent CLI does NOT
 *      propagate parent env (e.g. Codex, which only passes the env declared in
 *      its config TOML). The bridge walks the process tree up from `ppid` until
 *      it finds a known agent-CLI PID, then binds to that agent's session.
 *
 * Either source is sufficient. If both are absent, or `ppid` is sent but resolves
 * to no known agent, the bridge rejects the connection - fail closed.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { logger } from '../utils/logger';
import { COWORKING_SOCKET_ENV_VAR } from './coworking-types';
import type {
	BrowserOp,
	CoworkingBridgeRequest,
	CoworkingBridgeResponse,
	CoworkingBridgeMethod,
} from './coworking-types';
import { coworkingRegistry } from './coworking-registry';
import {
	browserInteract,
	getBrowserUrl,
	listBrowsers,
	listTerminals,
	readBrowser,
	readTerminal,
} from './coworking-tools';
import {
	recordBrowserAudit,
	redactBrowserOpDetail,
	type BrowserAuditEntry,
} from './coworking-audit';

const LOG_CTX = '[Coworking][Bridge]';

let server: net.Server | null = null;

/** Run a browser tool call and emit one audit record with its outcome (ok or
 *  error). Denied calls are audited separately by the caller. */
async function auditedBrowserCall<T>(
	base: Omit<BrowserAuditEntry, 'ts' | 'status'>,
	run: () => Promise<T> | T
): Promise<T> {
	try {
		const result = await run();
		recordBrowserAudit({ ...base, ts: Date.now(), status: 'ok' });
		return result;
	} catch (err) {
		recordBrowserAudit({ ...base, ts: Date.now(), status: 'error' });
		throw err;
	}
}

/**
 * Optional fallback resolver: maps a peer-process PID (sent by the MCP
 * subprocess in its handshake as `ppid`) to the owning Maestro session id by
 * walking the process tree until a known agent-CLI PID is found. Wired by the
 * main-process startup so the bridge can support agent CLIs (notably Codex)
 * that do not propagate `MAESTRO_COWORKING_SESSION_ID` env into MCP subprocesses.
 */
export type CoworkingSessionFromPidResolver = (pid: number) => string | null;

let resolveSessionFromPid: CoworkingSessionFromPidResolver | null = null;

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
export async function startCoworkingBridge(options?: {
	resolveSessionFromPid?: CoworkingSessionFromPidResolver;
}): Promise<void> {
	if (options?.resolveSessionFromPid !== undefined) {
		resolveSessionFromPid = options.resolveSessionFromPid;
	}
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

	// Restrict the socket to the owner (POSIX). Node creates Unix sockets with the
	// process umask, which can leave them group/other-connectable; the coworking
	// bridge exposes terminal scrollback + live browser control, so lock it to the
	// current user. (Windows named pipes are per-user via the userData-slug name.)
	if (process.platform !== 'win32') {
		try {
			await fs.promises.chmod(socketPath, 0o600);
		} catch (e) {
			logger.warn(`${LOG_CTX} Could not chmod socket to 0600: ${String(e)}`, 'Coworking');
		}
	}

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
		// Bad JSON - close the connection. The MCP subprocess will log and exit.
		conn.end();
		return;
	}
	const resp = await dispatch(conn, req);
	conn.write(JSON.stringify(resp) + '\n');
}

/** Allowlist of URL schemes an agent may navigate a browser tab to. Only
 *  http/https (plus about:blank) are permitted. Blocks file: (local-file
 *  exfiltration via a follow-up read_browser), javascript: and data: (a second
 *  eval path that would bypass the eval approval gate), and privileged schemes
 *  like chrome:. */
function isAllowedNavigateUrl(url: string): boolean {
	const trimmed = url.trim();
	if (trimmed.toLowerCase() === 'about:blank') return true;
	try {
		const scheme = new URL(trimmed).protocol.toLowerCase();
		return scheme === 'http:' || scheme === 'https:';
	} catch {
		return false;
	}
}

/** Validate an untyped interaction op from the MCP JSON into a BrowserOp. Returns
 *  null for unknown kinds or missing required fields (caller maps to -32602).
 *  `read` is intentionally rejected here - reads go through `readBrowser`. */
function validateInteractionOp(raw: unknown): BrowserOp | null {
	if (typeof raw !== 'object' || raw === null) return null;
	if (!('kind' in raw) || typeof raw.kind !== 'string') return null;
	switch (raw.kind) {
		case 'back':
			return { kind: 'back' };
		case 'forward':
			return { kind: 'forward' };
		case 'reload':
			return { kind: 'reload' };
		case 'stop':
			return { kind: 'stop' };
		case 'screenshot':
			return { kind: 'screenshot' };
		case 'navigate':
			return 'url' in raw && typeof raw.url === 'string' && isAllowedNavigateUrl(raw.url)
				? { kind: 'navigate', url: raw.url }
				: null;
		case 'click':
			return 'selector' in raw && typeof raw.selector === 'string'
				? { kind: 'click', selector: raw.selector }
				: null;
		case 'type':
			return 'selector' in raw &&
				'text' in raw &&
				typeof raw.selector === 'string' &&
				typeof raw.text === 'string'
				? { kind: 'type', selector: raw.selector, text: raw.text }
				: null;
		case 'eval':
			return 'code' in raw && typeof raw.code === 'string'
				? { kind: 'eval', code: raw.code }
				: null;
		default:
			return null;
	}
}

async function dispatch(
	conn: net.Socket,
	req: CoworkingBridgeRequest
): Promise<CoworkingBridgeResponse> {
	const method = req.method as CoworkingBridgeMethod;
	const state = connections.get(conn);
	try {
		if (method === 'hello') {
			const params = (req.params ?? {}) as { sessionId?: string | null; ppid?: number };
			let bound: string | null = null;

			// Explicit sessionId wins. Agents that propagate env (Claude Code,
			// OpenCode) take this path; the env is the strongest binding signal
			// because the main process injected it at agent-CLI spawn time.
			if (typeof params.sessionId === 'string' && params.sessionId.length > 0) {
				bound = params.sessionId;
			} else if (
				typeof params.ppid === 'number' &&
				Number.isInteger(params.ppid) &&
				params.ppid > 0
			) {
				// Fallback for agents that don't propagate env (e.g. Codex CLI):
				// walk the process tree from the MCP subprocess up to a tracked
				// agent-CLI PID. If nothing matches, fail closed - silent default
				// would reintroduce the privacy hole PR #948 closed.
				if (!resolveSessionFromPid) {
					return {
						id: req.id,
						error: {
							code: -32602,
							message: 'coworking bridge: ppid resolver not configured',
						},
					};
				}
				bound = resolveSessionFromPid(params.ppid);
				if (!bound) {
					return {
						id: req.id,
						error: {
							code: -32602,
							message: 'coworking bridge: could not resolve session from peer PID',
						},
					};
				}
			} else {
				return {
					id: req.id,
					error: {
						code: -32602,
						message: '`sessionId` or `ppid` is required for hello',
					},
				};
			}

			if (state) state.sessionId = bound;
			return { id: req.id, result: { ok: true } };
		}

		// Every other RPC requires a bound session.
		const sessionId = state?.sessionId;
		if (!sessionId) {
			return {
				id: req.id,
				error: {
					code: -32002,
					message:
						'coworking bridge: handshake required (send `hello` with sessionId or ppid first)',
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
		if (method === 'listBrowsers') {
			const agentType = coworkingRegistry.getAgentType(sessionId);
			const result = await auditedBrowserCall({ sessionId, agentType, tool: 'list_browsers' }, () =>
				listBrowsers(sessionId)
			);
			return { id: req.id, result };
		}
		if (method === 'getBrowserUrl') {
			const params: Record<string, unknown> = req.params ?? {};
			const id = params.id;
			if (typeof id !== 'string') {
				return { id: req.id, error: { code: -32602, message: '`id` is required' } };
			}
			const agentType = coworkingRegistry.getAgentType(sessionId);
			const result = await auditedBrowserCall(
				{ sessionId, agentType, tool: 'get_browser_url', detail: `id=${id}` },
				() => getBrowserUrl(sessionId, { id })
			);
			return { id: req.id, result };
		}
		if (method === 'readBrowser') {
			const params: Record<string, unknown> = req.params ?? {};
			const id = params.id;
			if (typeof id !== 'string') {
				return { id: req.id, error: { code: -32602, message: '`id` is required' } };
			}
			const format = params.format;
			if (
				format !== undefined &&
				format !== 'text' &&
				format !== 'innerText' &&
				format !== 'html'
			) {
				return {
					id: req.id,
					error: {
						code: -32602,
						message: "`format` must be one of 'text', 'innerText', 'html'",
					},
				};
			}
			const maxChars = params.maxChars;
			if (
				maxChars !== undefined &&
				(typeof maxChars !== 'number' || !Number.isInteger(maxChars) || maxChars <= 0)
			) {
				return {
					id: req.id,
					error: { code: -32602, message: '`maxChars` must be a positive integer' },
				};
			}
			const agentType = coworkingRegistry.getAgentType(sessionId);
			const result = await auditedBrowserCall(
				{
					sessionId,
					agentType,
					tool: 'read_browser',
					detail: `id=${id} format=${format ?? 'text'}`,
				},
				() => readBrowser(sessionId, { id, format, maxChars })
			);
			return { id: req.id, result };
		}
		if (method === 'browserInteract') {
			const agentType = coworkingRegistry.getAgentType(sessionId);
			if (!coworkingRegistry.isBrowserInteractionEnabled(sessionId)) {
				recordBrowserAudit({
					ts: Date.now(),
					sessionId,
					agentType,
					tool: 'browser_interact',
					status: 'denied',
				});
				return {
					id: req.id,
					error: {
						code: -32002,
						message:
							'coworking bridge: browser interaction is not enabled for this agent (enable it in Settings -> Encore Features -> Coworking)',
					},
				};
			}
			const params: Record<string, unknown> = req.params ?? {};
			const id = params.id;
			if (typeof id !== 'string') {
				return { id: req.id, error: { code: -32602, message: '`id` is required' } };
			}
			const op = validateInteractionOp(params.op);
			if (!op) {
				return { id: req.id, error: { code: -32602, message: 'invalid or missing `op`' } };
			}
			const result = await auditedBrowserCall(
				{
					sessionId,
					agentType,
					tool: 'browser_interact',
					opKind: op.kind,
					detail: redactBrowserOpDetail(op),
				},
				() => browserInteract(sessionId, { id, op })
			);
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
	setResolveSessionFromPid(fn: CoworkingSessionFromPidResolver | null) {
		resolveSessionFromPid = fn;
	},
};
