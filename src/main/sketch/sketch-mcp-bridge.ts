/**
 * Sketch Book MCP bridge: the host-owned socket that each agent's
 * `maestro-sketch` MCP subprocess dials to call the sketch tools T1-T12
 * (docs/sketch-book-spec.md section 4).
 *
 * Design note: how Sketch reuses the Coworking bridge (src/main/coworking/)
 * ---------------------------------------------------------------------------
 * Coworking already solves "an agent's MCP stdio subprocess calls back into
 * the main process, scoped to that agent". Sketch reuses each piece instead of
 * inventing a second mechanism:
 *
 * 1. Handshake. The first request on a connection must be `hello`. The owning
 *    agent is resolved FROM THE HANDSHAKE ONLY, through the same
 *    `bindHandshakeOwner()` Coworking uses (coworking/pid-resolution.ts):
 *    - `agentId`, read by the subprocess from `MAESTRO_SKETCH_AGENT_ID`, which
 *      ProcessManager injects into the agent CLI's env at spawn. It wins, but
 *      when the subprocess also sends `ppid` and the process tree names a
 *      DIFFERENT agent, the hello is refused.
 *    - `ppid` alone, for CLIs that do not pass their env to MCP subprocesses
 *      (Codex): the bridge walks the process tree up to an agent CLI that
 *      ProcessManager tracks (`getSessionIdByPid`, terminals excluded).
 *    No match fails closed. There is NO active-session fallback anywhere (the
 *    PR #948 privacy bug): which tab the user is looking at never decides
 *    which sketches a call can reach. The bound id is the bare agent id
 *    (`agentIdFromProcessId` strips `-ai-<tab>`, `-batch-`, `-synopsis-` and
 *    `-cue-`, on both the env and the PID path), the same id a sketch's
 *    `ownerAgentId` holds.
 *
 * 2. Socket path. `getAppSocketPath('sketch')` (coworking-socket-path.ts): the
 *    same rule as Coworking's socket with its own name, so the two features
 *    switch on and off independently. POSIX: `<userData>/sketch.sock`, or
 *    `<tmp>/maestro-sketch-<userData hash>.sock` when userData is too deep for
 *    `sun_path`; chmod 0600. Windows: the per-user pipe
 *    `\\.\pipe\maestro-sketch-<userData hash>`. The listener is the shared
 *    `createNdjsonSocketServer()` (utils/ndjson-socket-server.ts), the one
 *    Coworking runs on: one JSON request per line, single-flight start, and a
 *    stop that drops live connections.
 *
 * 3. MCP config injection, per provider. Coworking's two layers, with the
 *    server name `maestro-sketch` and the script `<userData>/sketch-mcp-server.js`
 *    (sketch-mcp-server-script.ts, built by the same `buildMcpStdioServerScript()`
 *    as Coworking's, so both carry one bridge client):
 *    - Config entry: the Coworking installer strategies (coworking/installers/),
 *      called with the server name `maestro-sketch`, write the entry, with
 *      `MAESTRO_SKETCH_SOCKET`, into each provider's user-level MCP config:
 *      Claude Code `~/.claude.json`, Codex `~/.codex/config.toml` (sentinel
 *      block), OpenCode `~/.config/opencode/opencode.json`, Factory Droid
 *      `~/.factory/mcp.json`. sketch-mcp-install.ts writes it when `sketchBook`
 *      turns on (only for providers set up on this machine) and removes it when
 *      the flag turns off.
 *    - Spawn env: ProcessManager.spawn injects, beside Coworking's pair,
 *      `MAESTRO_SKETCH_AGENT_ID` and `MAESTRO_SKETCH_SOCKET_OVERRIDE` (this
 *      window's socket, which the script prefers over the config value), only
 *      while `sketchBook` is on and never for terminals. The names live in
 *      sketch-mcp-types.ts.
 *    Claude Code and OpenCode pass that env on, so they bind by id to the
 *    window that spawned them. Codex passes only its config's env, so it binds
 *    by `ppid` and is single-window, exactly as with Coworking. OpenCode's
 *    shared `serve` transport gets no per-agent env and its parent is the
 *    shared server, so the hello fails closed there, as Coworking's does.
 *
 * What Sketch adds on top:
 * - Lifecycle follows the `sketchBook` Encore flag (the Encore lifecycle in
 *   main/index.ts): on starts the socket and writes the config entries, off
 *   stops it, drops connections and removes the entries.
 * - Ownership. Every tool that names a sketch has its `sketchId` checked before
 *   the tool runs: the sketch's `ownerAgentId` must be the connection's agent.
 *   A foreign sketch and a missing one get the same refusal, so a call cannot
 *   probe for other agents' sketches.
 * - Local agents only (spec Q12). An SSH-remote agent's MCP subprocess would
 *   run on the remote host and cannot reach this socket anyway; the bridge also
 *   refuses it by name at the handshake and on every call, in case the agent
 *   moved to SSH after it connected.
 * - The tools themselves live in a tool service (sketch-tools.ts) the bridge
 *   routes to; the bridge owns only identity, ownership and the transport.
 */

import type * as net from 'net';
import type { SketchAgentActivity } from '../../shared/sketch/commands';
import type { SketchRecord } from '../../shared/sketch/types';
import {
	bindHandshakeOwner,
	resolveSessionFromPidWalk,
	type HandshakeBindFailure,
} from '../coworking/pid-resolution';
import { createNdjsonSocketServer } from '../utils/ndjson-socket-server';
import { agentIdFromProcessId } from '../utils/process-ids';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { findSketchOwnerAgent, getSketchService, type SketchOwnerAgent } from './sketch-service';
import {
	SKETCH_CANVAS_WRITE_TOOLS,
	getSketchBridgeSocketPath,
	isSketchToolName,
	type SketchToolName,
} from './sketch-mcp-types';

const LOG_CTX = '[SketchBook][Bridge]';

/** The push each sketch-scoped tool call sends to every window. Matches the preload. */
export const SKETCH_AGENT_ACTIVITY_CHANNEL = 'sketch:agentActivity';

/** Tools that act on the agent rather than on one sketch. Every other tool names one by `sketchId`. */
const AGENT_SCOPED_TOOLS: ReadonlySet<SketchToolName> = new Set(['sketch_list', 'sketch_create']);

/** One tool call, after the bridge has checked who is calling and what it may touch. */
export interface SketchToolCall {
	/** The connection's agent: live and local. */
	agent: SketchOwnerAgent;
	/** The tool's arguments as the MCP client sent them. The tool checks their shape. */
	params: Record<string, unknown>;
	/** The sketch the call names, already checked to belong to `agent`. Absent for T1 and T2. */
	sketch?: SketchRecord;
}

export type SketchToolHandler = (call: SketchToolCall) => Promise<unknown>;

/** The tool implementations the bridge routes to. A missing tool answers "not available". */
export type SketchToolService = Partial<Record<SketchToolName, SketchToolHandler>>;

export interface SketchBridgeRequest {
	id: number | string;
	method: string;
	params?: Record<string, unknown>;
}

export type SketchBridgeResponse =
	| { id: number | string; result: unknown }
	| { id: number | string; error: { code: number; message: string } };

/** JSON-RPC style error codes the bridge answers with. */
export const SKETCH_BRIDGE_ERRORS = {
	/** Bad or missing arguments, or a refused handshake. */
	invalidParams: -32602,
	/** Not a T1-T12 tool, or one this build does not serve yet. */
	unknownMethod: -32601,
	/** A call before a successful `hello`. */
	handshakeRequired: -32002,
	/** The agent is gone, runs over SSH, or does not own the sketch. */
	refused: -32003,
	/** The tool ran and failed. */
	toolFailed: -32000,
} as const;

/** What a failed `hello` tells the MCP subprocess. */
const HELLO_FAILURE_MESSAGES: Record<HandshakeBindFailure, string> = {
	missing: 'sketch bridge: `agentId` or `ppid` is required for hello',
	mismatch: 'sketch bridge: agent id does not match the caller process',
	'no-resolver': 'sketch bridge: ppid resolver not configured',
	unresolved: 'sketch bridge: could not resolve the agent from the peer PID',
};

/** Per-connection state. The agent id is set once, by `hello`, and never changes. */
export interface SketchBridgeConnection {
	agentId: string | null;
}

export interface SketchBridgeDispatcherDeps {
	/** Maps the subprocess's parent PID to the owning agent id (Codex path). */
	resolveAgentFromPid?: ((pid: number) => Promise<string | null>) | null;
	/** The live agent with this id, or `null`. */
	findAgent?: (agentId: string) => SketchOwnerAgent | null;
	/** The sketch record with this id, or `null`. Throws while Sketch Book is off. */
	getSketch?: (sketchId: string) => Promise<SketchRecord | null>;
	tools?: SketchToolService;
	/**
	 * A checked call on one sketch is about to run, so the windows can show the
	 * agent working on it. Not called for T1 and T2, which name no sketch.
	 */
	onToolCall?: (activity: SketchAgentActivity) => void;
}

export type SketchBridgeDispatcher = (
	connection: SketchBridgeConnection,
	request: SketchBridgeRequest
) => Promise<SketchBridgeResponse>;

function errorResponse(id: number | string, code: number, message: string): SketchBridgeResponse {
	return { id, error: { code, message } };
}

/** The agent when it may use the sketch tools: live and local (Q12). */
function checkLocalAgent(
	agentId: string,
	agent: SketchOwnerAgent | null
): { ok: true; agent: SketchOwnerAgent } | { ok: false; message: string } {
	if (!agent) {
		return { ok: false, message: `sketch bridge: agent "${agentId}" is not a live Maestro agent.` };
	}
	if (agent.sshRemote) {
		return {
			ok: false,
			message: `Sketch Book runs on local agents only. "${agent.name}" runs over SSH, so it cannot use the maestro-sketch tools.`,
		};
	}
	return { ok: true, agent };
}

/**
 * The request router: identity at `hello`, then for every tool call the live
 * local agent check, the ownership check, and the hand-off to the tool service.
 * Pure over its deps, so it is tested without a socket.
 */
export function createSketchBridgeDispatcher(
	deps: SketchBridgeDispatcherDeps = {}
): SketchBridgeDispatcher {
	const findAgent = deps.findAgent ?? findSketchOwnerAgent;
	const getSketch = deps.getSketch ?? ((sketchId) => getSketchService().getSketch(sketchId));
	const tools = deps.tools ?? {};

	return async (connection, request) => {
		const id = request.id;
		const params: Record<string, unknown> =
			typeof request.params === 'object' && request.params !== null ? request.params : {};
		try {
			if (request.method === 'hello') {
				const binding = await bindHandshakeOwner(
					{ claimedId: params.agentId, ppid: params.ppid },
					deps.resolveAgentFromPid ?? null
				);
				if (!binding.ok) {
					return errorResponse(
						id,
						SKETCH_BRIDGE_ERRORS.invalidParams,
						HELLO_FAILURE_MESSAGES[binding.reason]
					);
				}
				const local = checkLocalAgent(binding.ownerId, findAgent(binding.ownerId));
				if (!local.ok) return errorResponse(id, SKETCH_BRIDGE_ERRORS.refused, local.message);
				connection.agentId = binding.ownerId;
				return { id, result: { ok: true } };
			}

			const agentId = connection.agentId;
			if (!agentId) {
				return errorResponse(
					id,
					SKETCH_BRIDGE_ERRORS.handshakeRequired,
					'sketch bridge: handshake required (send `hello` with agentId or ppid first)'
				);
			}
			if (!isSketchToolName(request.method)) {
				return errorResponse(
					id,
					SKETCH_BRIDGE_ERRORS.unknownMethod,
					`sketch bridge: unknown method "${String(request.method)}"`
				);
			}
			const tool = request.method;

			// Checked on every call: the agent may have been removed or moved to
			// SSH since it connected.
			const local = checkLocalAgent(agentId, findAgent(agentId));
			if (!local.ok) return errorResponse(id, SKETCH_BRIDGE_ERRORS.refused, local.message);

			let sketch: SketchRecord | undefined;
			if (!AGENT_SCOPED_TOOLS.has(tool)) {
				const sketchId = params.sketchId;
				if (typeof sketchId !== 'string' || !sketchId) {
					return errorResponse(
						id,
						SKETCH_BRIDGE_ERRORS.invalidParams,
						'`sketchId` must be a non-empty string'
					);
				}
				const record = await getSketch(sketchId);
				// One answer for "missing" and "someone else's", so nothing leaks.
				if (!record || record.ownerAgentId !== agentId) {
					return errorResponse(
						id,
						SKETCH_BRIDGE_ERRORS.refused,
						`sketch bridge: this agent owns no sketch with the id "${sketchId}".`
					);
				}
				sketch = record;
			}

			const handler = tools[tool];
			if (!handler) {
				return errorResponse(
					id,
					SKETCH_BRIDGE_ERRORS.unknownMethod,
					`sketch bridge: ${tool} is not available yet.`
				);
			}
			if (sketch) {
				deps.onToolCall?.({
					agentId,
					sketchId: sketch.sketchId,
					writes: SKETCH_CANVAS_WRITE_TOOLS.has(tool),
				});
			}
			const result = await handler({ agent: local.agent, params, ...(sketch ? { sketch } : {}) });
			return { id, result };
		} catch (err) {
			return errorResponse(
				id,
				SKETCH_BRIDGE_ERRORS.toolFailed,
				err instanceof Error ? err.message : String(err)
			);
		}
	};
}

/** The slice of ProcessManager the bridge needs to bind a connection to an agent. */
export interface SketchProcessLookup {
	getSessionIdByPid(pid: number): string | null;
}

const connections = new WeakMap<net.Socket, SketchBridgeConnection>();
let dispatch: SketchBridgeDispatcher = createSketchBridgeDispatcher();

const bridgeServer = createNdjsonSocketServer({
	socketPath: getSketchBridgeSocketPath,
	logContext: LOG_CTX,
	logCategory: 'SketchBook',
	onConnect: (conn) => connections.set(conn, { agentId: null }),
	onClose: (conn) => connections.delete(conn),
	onRequest: async (conn, request) => {
		const connection = connections.get(conn) ?? { agentId: null };
		const req: Partial<SketchBridgeRequest> =
			typeof request === 'object' && request !== null ? request : {};
		return dispatch(connection, {
			id: typeof req.id === 'number' || typeof req.id === 'string' ? req.id : 0,
			method: typeof req.method === 'string' ? req.method : '',
			params: req.params,
		});
	},
});

export interface SketchMcpBridgeOptions {
	/** ProcessManager, read at call time (it may not exist yet at boot). */
	getProcessManager: () => SketchProcessLookup | null;
	/** The tool service. Defaults to none, so every tool answers "not available". */
	tools?: SketchToolService;
	/** Each checked call on one sketch, before it runs (the windows' working indicator). */
	onToolCall?: (activity: SketchAgentActivity) => void;
}

/**
 * Start the bridge. Idempotent. Called when the `sketchBook` flag is on at boot
 * and whenever it turns on. Startup is non-fatal: the tools are unavailable
 * until the next start.
 */
export async function startSketchMcpBridge(options: SketchMcpBridgeOptions): Promise<void> {
	dispatch = createSketchBridgeDispatcher({
		resolveAgentFromPid: (pid) =>
			resolveSessionFromPidWalk(pid, (candidate) => {
				// An Auto Run, synopsis or Cue process belongs to its agent too, and the
				// spawn env names that agent the same way (agentIdFromProcessId), so
				// the two halves of the handshake agree.
				const processId = options.getProcessManager()?.getSessionIdByPid(candidate);
				return processId ? agentIdFromProcessId(processId) : null;
			}),
		tools: options.tools,
		onToolCall: options.onToolCall,
	});
	try {
		await bridgeServer.start();
	} catch (err) {
		// EADDRINUSE: another Maestro process owns this userData's socket. Losing
		// that race is expected, not a defect (the same rule as Coworking).
		const code = (err as NodeJS.ErrnoException | null)?.code;
		if (code !== 'EADDRINUSE') {
			void captureException(err instanceof Error ? err : new Error(String(err)), {
				operation: 'sketchBook:startBridge',
			});
		}
		logger.warn(`${LOG_CTX} Failed to start: ${String(err)}`, 'SketchBook');
	}
}

/**
 * Stop the bridge and drop live connections. Idempotent. Called when the
 * `sketchBook` flag turns off and on quit, so no agent keeps its tools after.
 */
export async function stopSketchMcpBridge(): Promise<void> {
	try {
		await bridgeServer.stop();
	} catch (err) {
		void captureException(err instanceof Error ? err : new Error(String(err)), {
			operation: 'sketchBook:stopBridge',
		});
		logger.warn(`${LOG_CTX} Failed to stop: ${String(err)}`, 'SketchBook');
	}
}

/** True while the bridge socket listens. */
export function isSketchMcpBridgeRunning(): boolean {
	return bridgeServer.isListening();
}
