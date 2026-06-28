/**
 * MCP bridge core (testable; transport + I/O injected).
 *
 * Backs `maestro-cli mcp serve` - the MCP stdio server an agent spawns to reach
 * the running Maestro app. This module owns the app-facing half: it turns the
 * pure {@link createMcpToolServer}'s `listTools`/`callTool` callbacks into
 * `plugins_list_tools` / `plugins_call_tool` requests over the desktop
 * WebSocket, and maintains the MCP-name <-> namespaced-toolId map.
 *
 * The WS `request` fn is injected (the command supplies a real `MaestroClient`),
 * so this is unit-testable with a fake transport. The newline-delimited stdio
 * loop + stdout/stderr discipline live in the command, not here.
 */
import {
	createMcpToolServer,
	type McpToolDef,
	type McpToolCallResult,
	type McpToolServer,
} from '../../shared/plugins/mcp-protocol';

/**
 * Command timeout for a model-initiated tool call. MUST exceed the sandbox
 * broker's `TOOL_INVOKE_TIMEOUT_MS` (30s) so a healthy long-running tool isn't
 * cut off early by the WS client's default 10s.
 */
export const MCP_CALL_TIMEOUT_MS = 35_000;

/** One tool as returned by the app's `plugins_list_tools_result`. */
interface AppToolEntry {
	name: string;
	toolId: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

export interface McpBridgeDeps {
	serverInfo: { name: string; version: string };
	/** Send a command to the running app and await its typed response. */
	request: <T>(
		message: Record<string, unknown>,
		responseType: string,
		timeoutMs?: number
	) => Promise<T>;
	/** Diagnostics sink. MUST write to stderr only (stdout is reserved for MCP). */
	log: (msg: string) => void;
}

export interface McpBridge {
	server: McpToolServer;
	/** Exposed for tests. */
	listTools: () => Promise<McpToolDef[]>;
	callTool: (name: string, args: unknown) => Promise<McpToolCallResult>;
}

export function createMcpBridge(deps: McpBridgeDeps): McpBridge {
	// MCP name -> namespaced toolId, rebuilt on every tools/list. MCP clients list
	// before they call, so this is always fresh for a subsequent tools/call.
	const nameToId = new Map<string, string>();

	async function listTools(): Promise<McpToolDef[]> {
		let entries: AppToolEntry[] = [];
		try {
			const res = await deps.request<{ tools?: AppToolEntry[] }>(
				{ type: 'plugins_list_tools' },
				'plugins_list_tools_result'
			);
			entries = Array.isArray(res.tools) ? res.tools : [];
		} catch (e) {
			// App unreachable / not running: advertise zero tools rather than failing
			// the agent's MCP handshake.
			deps.log(`[mcp] tools/list unavailable: ${e instanceof Error ? e.message : String(e)}`);
			return [];
		}

		nameToId.clear();
		const out: McpToolDef[] = [];
		for (const t of entries) {
			if (typeof t.name !== 'string' || typeof t.toolId !== 'string') continue;
			// Deterministic de-collision: distinct toolIds can sanitize to the same
			// MCP name (local ids may contain underscores). Suffix __2, __3, ...
			let name = t.name;
			if (nameToId.has(name)) {
				let i = 2;
				while (nameToId.has(`${name}__${i}`)) i++;
				name = `${name}__${i}`;
			}
			nameToId.set(name, t.toolId);
			out.push({
				name,
				description: t.description,
				inputSchema: t.inputSchema ?? { type: 'object' },
			});
		}
		return out;
	}

	async function callTool(name: string, args: unknown): Promise<McpToolCallResult> {
		// Reject any name not in the current tools/list map - never guess a toolId,
		// which could resolve to a non-tool command handler in the sandbox's map.
		const toolId = nameToId.get(name);
		if (!toolId) {
			return {
				content: [{ type: 'text', text: `Unknown tool: ${name}` }],
				isError: true,
			};
		}
		const res = await deps.request<{
			ok?: boolean;
			result?: unknown;
			error?: string;
			blocked?: boolean;
			reason?: string;
		}>(
			{ type: 'plugins_call_tool', toolId, args },
			'plugins_call_tool_result',
			MCP_CALL_TIMEOUT_MS
		);

		if (res.blocked) {
			return {
				content: [
					{ type: 'text', text: `Blocked by Maestro risk gate: ${res.reason ?? 'high-risk'}` },
				],
				isError: true,
			};
		}
		if (!res.ok) {
			return {
				content: [{ type: 'text', text: `Error: ${res.error ?? 'tool call failed'}` }],
				isError: true,
			};
		}
		const text = typeof res.result === 'string' ? res.result : JSON.stringify(res.result ?? null);
		return { content: [{ type: 'text', text }] };
	}

	const server = createMcpToolServer({
		serverInfo: deps.serverInfo,
		listTools,
		callTool,
		onError: (e, ctx) => deps.log(`[mcp] ${ctx}: ${e instanceof Error ? e.message : String(e)}`),
	});

	return { server, listTools, callTool };
}
