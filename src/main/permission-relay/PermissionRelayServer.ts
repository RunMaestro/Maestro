/**
 * PermissionRelayServer: a Maestro-owned unix-domain socket (named pipe on
 * Windows) that the stdio MCP bridge dials back to.
 *
 * Security model: the socket file is created with 0600 permissions in the
 * app's userData dir, so only the current OS user can connect - filesystem
 * permissions are the auth boundary. There is NO TCP port and NO network
 * surface. Every message additionally carries a per-spawn token; an unknown
 * token is rejected. This is deliberately different from
 * `src/main/web-server/WebServer.ts`, which binds 0.0.0.0 and must not be
 * reused for permission decisions.
 *
 * The server is transport-only: it forwards each request to an injected
 * `onRequest` callback (which surfaces it to the renderer) and awaits the
 * user's decision via the registry's pending map. It has no Electron
 * dependency, which keeps it unit-testable.
 */

import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';
import { createPending, lookupBinding, registerSpawn, resolvePending } from './registry';
import { parseQuestionRequest, parseAutomatableQuestionRequest } from './question-request';
import type {
	BridgeToServerMessage,
	PermissionDecision,
	PermissionRequest,
	RelaySpawnBinding,
	ServerToBridgeMessage,
} from './types';
import { rateRisk } from '../../shared/pianola/pianola-risk';
import { canonicalJson } from '../../shared/canonicalJson';
import { nativeCurrentTurns } from '../pianola/current-turn';

const LOG_CONTEXT = '[PermissionRelay]';

/** Called for each validated request; must surface it to the user. */
export type OnPermissionRequest = (request: PermissionRequest) => void;

/**
 * An in-process consent session for one spawn whose permission requests arrive on
 * its own protocol (Grok ACP `session/request_permission`) instead of over the
 * bridge socket. Each request takes the path a bridged one takes: the person,
 * through the renderer prompt.
 *
 * Only an explicit person decision answers `allow`. A timeout, an aborted signal
 * (the turn stopped, or its driver settled the request) and `close()` (the process
 * exited) all answer deny; a request after `close()` is denied at once.
 */
export interface RelayConsentSession {
	request(
		toolName: string,
		input: Record<string, unknown>,
		signal?: AbortSignal
	): Promise<PermissionDecision>;
	close(): void;
}

export class PermissionRelayServer {
	private readonly socketId = randomUUID();
	private server: net.Server | null = null;
	private socketPath: string | null = null;
	private onRequest: OnPermissionRequest | null = null;
	private starting: Promise<string> | null = null;
	private questionAuthority?: () => string;

	/** Native host policy/owner census; absence keeps question automation unsupported. */
	setQuestionAuthority(read: () => string): void {
		this.questionAuthority = read;
	}

	/** Set the callback that surfaces requests to the user (renderer). */
	setOnRequest(cb: OnPermissionRequest): void {
		this.onRequest = cb;
	}

	/** Whether a person can be asked at all: the renderer prompt surface is wired. */
	hasConsentSurface(): boolean {
		return this.onRequest !== null;
	}

	/**
	 * Open an in-process consent session for one spawn, or null when no person can be
	 * asked (no prompt surface). The binding names the agent session and tab the prompt
	 * belongs to; the token it is registered under never leaves the main process.
	 */
	openConsentSession(binding: RelaySpawnBinding): RelayConsentSession | null {
		if (!this.onRequest) return null;
		const { token, cleanup } = registerSpawn({ ...binding });
		let closed = false;
		return {
			request: (toolName, input, signal) =>
				closed
					? Promise.resolve({ behavior: 'deny', message: 'Agent process exited.' })
					: this.decide(token, binding, toolName, input, signal),
			close: () => {
				if (closed) return;
				closed = true;
				cleanup();
			},
		};
	}

	/** True once the socket is listening. */
	isRunning(): boolean {
		return this.server !== null && this.socketPath !== null;
	}

	/**
	 * Lazily start the socket. Idempotent: concurrent callers share one start.
	 * Returns the socket path (or named-pipe path on Windows) to embed in the
	 * bridge env.
	 */
	async ensureStarted(userDataDir: string): Promise<string> {
		if (this.socketPath && this.server) {
			return this.socketPath;
		}
		if (this.starting) {
			return this.starting;
		}
		this.starting = this.start(userDataDir).finally(() => {
			this.starting = null;
		});
		return this.starting;
	}

	private resolveSocketPath(userDataDir: string): string {
		if (process.platform === 'win32') {
			// Named pipes are per-user by default ACL; unique per app instance.
			return `\\\\.\\pipe\\maestro-permission-relay-${process.pid}-${this.socketId}`;
		}
		// Prefer userData, but macOS caps unix socket paths at ~104 bytes. Fall
		// back to tmpdir when the userData-based path would be too long.
		const preferred = path.join(userDataDir, 'permission-relay.sock');
		if (Buffer.byteLength(preferred, 'utf8') <= 100) {
			return preferred;
		}
		return path.join(os.tmpdir(), `mr-${process.pid}-${this.socketId.slice(0, 8)}.sock`);
	}

	private async start(userDataDir: string): Promise<string> {
		const socketPath = this.resolveSocketPath(userDataDir);

		// Remove any stale socket file from a previous unclean shutdown.
		if (process.platform !== 'win32') {
			try {
				fs.unlinkSync(socketPath);
			} catch {
				// Not present - fine.
			}
		}

		const server = net.createServer((socket) => this.handleConnection(socket));

		// Create the socket with 0600 from the start. listen() creates the socket
		// file immediately, so a later chmod leaves a window where another local
		// user could connect (on a permissive umask like 022). Constraining the
		// umask around listen() makes the file restrictive at creation time; the
		// chmod below is a belt-and-suspenders backstop. Not applicable on win32
		// (named pipes are per-user by ACL and umask has no effect).
		const prevUmask = process.platform !== 'win32' ? process.umask(0o177) : undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				server.once('error', reject);
				server.listen(socketPath, () => {
					server.removeListener('error', reject);
					resolve();
				});
			});
		} finally {
			if (prevUmask !== undefined) {
				process.umask(prevUmask);
			}
		}

		// Backstop: ensure 0600 even if the umask path was ineffective.
		if (process.platform !== 'win32') {
			try {
				fs.chmodSync(socketPath, 0o600);
			} catch (e) {
				logger.warn('Failed to chmod relay socket to 0600', LOG_CONTEXT, {
					socketPath,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}

		this.server = server;
		this.socketPath = socketPath;
		logger.info('Permission relay socket listening', LOG_CONTEXT, { socketPath });
		return socketPath;
	}

	private handleConnection(socket: net.Socket): void {
		let buffer = '';
		socket.setEncoding('utf8');

		socket.on('data', (chunk: string) => {
			buffer += chunk;
			let newlineIndex: number;
			while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				if (line.length === 0) {
					continue;
				}
				this.handleLine(socket, line);
			}
		});

		socket.on('error', (err) => {
			logger.debug('Relay socket connection error', LOG_CONTEXT, { error: err.message });
		});
	}

	private handleLine(socket: net.Socket, line: string): void {
		let msg: BridgeToServerMessage;
		try {
			msg = JSON.parse(line) as BridgeToServerMessage;
		} catch {
			logger.warn('Relay received unparseable line', LOG_CONTEXT);
			return;
		}

		if (msg.type === 'hello') {
			const ok = lookupBinding(msg.token) !== undefined;
			this.send(socket, {
				type: 'hello-ack',
				ok,
				...(ok ? {} : { error: 'unknown token' }),
			});
			return;
		}

		if (msg.type === 'permission-request') {
			void this.handlePermissionRequest(socket, msg);
			return;
		}
	}

	private async handlePermissionRequest(
		socket: net.Socket,
		msg: Extract<BridgeToServerMessage, { type: 'permission-request' }>
	): Promise<void> {
		const binding = lookupBinding(msg.token);
		// The bridge's `requestId` is its local correlation id; echo it back so
		// the bridge can match the response to its outstanding tools/call.
		const bridgeRequestId = msg.requestId;

		if (!binding) {
			// Unknown/expired token: deny. Never leak that the token was invalid
			// as an "allow".
			this.send(socket, {
				type: 'permission-response',
				requestId: bridgeRequestId,
				decision: { behavior: 'deny', message: 'Unrecognized permission relay token.' },
			});
			return;
		}

		const decision = await this.decide(
			msg.token,
			binding,
			msg.toolName,
			msg.input ?? {},
			undefined,
			socket
		);
		this.send(socket, {
			type: 'permission-response',
			requestId: bridgeRequestId,
			decision,
		});
	}

	/**
	 * Decide one request of a registered spawn: ask the person. Shared by the bridge
	 * socket and in-process consent sessions, so there is one consent path. An aborted signal denies a request still waiting on the person.
	 */
	private async decide(
		token: string,
		binding: RelaySpawnBinding,
		toolName: string,
		input: Record<string, unknown>,
		signal?: AbortSignal,
		socket?: net.Socket
	): Promise<PermissionDecision> {
		const onRequest = this.onRequest;
		if (!onRequest) {
			// No UI wired: fail closed.
			return { behavior: 'deny', message: 'Permission UI unavailable.' };
		}

		// Server-side globally-unique id used as the pending key + renderer id.
		const requestId = randomUUID();
		// AskUserQuestion is surfaced as a question picker, not an allow/deny
		// prompt. Ordinary tools return null here and stay byte-for-byte unchanged.
		const questionFields = parseQuestionRequest(toolName, input);
		const request: PermissionRequest = {
			requestId,
			token,
			sessionId: binding.sessionId,
			tabId: binding.tabId,
			toolName,
			input,
			createdAt: Date.now(),
			...(questionFields ?? {}),
		};

		const cancelled: PermissionDecision = {
			behavior: 'deny',
			message: 'The request was cancelled before a decision.',
		};
		if (signal?.aborted) return cancelled;
		const native = socket
			? nativeCurrentTurns.readProcessTurn(binding.sessionId, binding.tabId)
			: undefined;
		// Raw automation admission must not inherit the human picker's lossy coercions.
		const question = parseAutomatableQuestionRequest(toolName, input);
		let authority: string | undefined;
		try {
			authority = native && question ? this.questionAuthority?.() : undefined;
		} catch {
			/* Human relay remains available. */
		}
		let authorityCurrent = !!authority;
		const decisionPromise = createPending(
			requestId,
			token,
			undefined,
			native && question
				? {
						requestId,
						processId: binding.sessionId,
						cursor: native.cursor,
						createdAt: request.createdAt,
						question: question.question,
						observedRisk: rateRisk(canonicalJson(input)),
						options: question.options.map((o) =>
							o.description ? `${o.label}: ${o.description}` : o.label
						),
					}
				: undefined,
			(readAuthority = (read) => read()) => {
				try {
					authorityCurrent =
						authorityCurrent &&
						!!this.questionAuthority &&
						readAuthority(this.questionAuthority) === authority;
				} catch {
					authorityCurrent = false;
				}
				return authorityCurrent && !!socket && !socket.destroyed && socket.writable;
			}
		);
		const onClose = () =>
			resolvePending(requestId, { behavior: 'deny', message: 'Question transport disconnected.' });
		socket?.once('close', onClose);
		const onAbort = () => resolvePending(requestId, cancelled);
		signal?.addEventListener('abort', onAbort, { once: true });
		let decision: PermissionDecision;
		try {
			onRequest(request);
			decision = await decisionPromise;
		} finally {
			signal?.removeEventListener('abort', onAbort);
			socket?.removeListener('close', onClose);
		}

		return decision;
	}

	private send(socket: net.Socket, msg: ServerToBridgeMessage): void {
		if (socket.destroyed) {
			return;
		}
		try {
			socket.write(JSON.stringify(msg) + '\n');
		} catch (e) {
			logger.debug('Failed to write to relay socket', LOG_CONTEXT, {
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	/** Stop the server and remove the socket file. */
	stop(): void {
		if (this.server) {
			this.server.close();
			this.server = null;
		}
		if (this.socketPath && process.platform !== 'win32') {
			try {
				fs.unlinkSync(this.socketPath);
			} catch {
				// Already gone.
			}
		}
		this.socketPath = null;
	}
}

/** Singleton used by the main process. */
export const permissionRelayServer = new PermissionRelayServer();
