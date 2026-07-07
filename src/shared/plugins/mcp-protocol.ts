/**
 * Minimal MCP server core (pure, bundle-safe, transport-agnostic).
 *
 * Implements the JSON-RPC 2.0 method set an MCP *client* (a spawned agent CLI)
 * needs to discover and call tools over stdio: `initialize`,
 * `notifications/initialized`, `tools/list`, `tools/call`, and `ping`.
 *
 * The MCP **stdio** wire format is newline-delimited JSON - one JSON-RPC message
 * per line, no embedded newlines (2025-06-18 spec, "Transports"). The framing and
 * the stdout-is-MCP-only / logs-to-stderr discipline live in the CLI transport
 * ({@link file://../../cli/services/mcp-bridge.ts}), NOT here, so this core stays
 * pure and unit-testable with raw JSON-RPC frames.
 *
 * Kept dependency-free (no Node, no Electron) - matching the repo convention for
 * plugin contracts - so it bundles into the CLI without pulling a runtime dep.
 */

/** Protocol version this server implements. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
/** Versions we will echo back on `initialize` if the client requests them. */
const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05'];

// JSON-RPC 2.0 error codes.
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** An MCP tool as advertised to the model on `tools/list`. */
export interface McpToolDef {
	/** MCP-safe stable name (see the bridge's id<->name mapping). */
	name: string;
	description?: string;
	/** JSON-schema object describing the tool input (defaults to an open object). */
	inputSchema: Record<string, unknown>;
}

/** The result of a `tools/call`. Tool-level failures are reported via `isError`
 *  in the result (NOT a JSON-RPC error), per MCP convention. */
export interface McpToolCallResult {
	content: Array<{ type: 'text'; text: string }>;
	isError?: boolean;
}

export interface McpToolServerDeps {
	serverInfo: { name: string; version: string };
	/** List currently-available tools. May reject; surfaced as an INTERNAL_ERROR. */
	listTools: () => Promise<McpToolDef[]>;
	/** Invoke a tool by its advertised name. Tool errors SHOULD be returned as a
	 *  result with `isError: true`; a thrown error is converted to one. */
	callTool: (name: string, args: unknown) => Promise<McpToolCallResult>;
	/** Optional diagnostics sink. MUST NOT write to stdout (reserved for MCP). */
	onError?: (err: unknown, context: string) => void;
}

export interface McpToolServer {
	/**
	 * Handle one parsed JSON-RPC message. Returns the response object to send
	 * back, or `null` for notifications (which take no response). Never throws.
	 */
	handleMessage(message: unknown): Promise<Record<string, unknown> | null>;
}

type JsonRpcId = string | number | null;

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// `ok`/`err` build the two JSON-RPC response envelopes; kept as helpers because
// every method (4+ call sites) must emit byte-identical envelope shapes.
function ok(id: JsonRpcId, result: unknown): Record<string, unknown> {
	return { jsonrpc: '2.0', id, result };
}
function err(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
	return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Create a pure MCP tool server. Feed it parsed JSON-RPC messages one at a time;
 * it returns the response to write back (or null for notifications).
 */
export function createMcpToolServer(deps: McpToolServerDeps): McpToolServer {
	function report(e: unknown, ctx: string): void {
		try {
			deps.onError?.(e, ctx);
		} catch {
			/* a diagnostics sink must never break the protocol loop */
		}
	}

	async function handleMessage(message: unknown): Promise<Record<string, unknown> | null> {
		if (!isRecord(message)) {
			// Not a JSON-RPC object at all - cannot correlate a response, so drop it.
			return null;
		}
		const rawId = message.id;
		const hasId = typeof rawId === 'string' || typeof rawId === 'number' || rawId === null;
		const id: JsonRpcId = hasId ? (rawId as JsonRpcId) : null;
		const method = typeof message.method === 'string' ? message.method : '';
		// Missing own `id` => a notification: act for effect, never respond.
		const isNotification = !('id' in message);

		if (!method) {
			return isNotification ? null : err(id, INVALID_REQUEST, 'missing method');
		}

		// Notifications (`notifications/initialized`, `.../cancelled`, ...) are
		// no-ops for a stateless tool bridge.
		if (isNotification) {
			return null;
		}

		const params = isRecord(message.params) ? message.params : {};

		switch (method) {
			case 'initialize': {
				const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
				const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
					? requested
					: MCP_PROTOCOL_VERSION;
				return ok(id, {
					protocolVersion,
					capabilities: { tools: { listChanged: false } },
					serverInfo: deps.serverInfo,
				});
			}
			case 'ping':
				return ok(id, {});
			case 'tools/list': {
				try {
					const tools = await deps.listTools();
					return ok(id, { tools });
				} catch (e) {
					report(e, 'tools/list');
					const reason = e instanceof Error ? e.message : String(e);
					return err(id, INTERNAL_ERROR, `tools/list failed: ${reason}`);
				}
			}
			case 'tools/call': {
				const name = typeof params.name === 'string' ? params.name : '';
				if (!name) {
					return err(id, INVALID_PARAMS, 'tools/call requires a string "name"');
				}
				const args = 'arguments' in params ? params.arguments : {};
				try {
					const result = await deps.callTool(name, args);
					return ok(id, result);
				} catch (e) {
					// MCP convention: tool execution failures are a successful response
					// carrying an error result, not a JSON-RPC protocol error.
					report(e, 'tools/call');
					const reason = e instanceof Error ? e.message : String(e);
					return ok(id, {
						content: [{ type: 'text', text: `Tool call failed: ${reason}` }],
						isError: true,
					});
				}
			}
			default:
				return err(id, METHOD_NOT_FOUND, `method not found: ${method}`);
		}
	}

	return { handleMessage };
}
