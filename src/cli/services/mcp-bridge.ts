/**
 * MCP bridge core (testable; transport + I/O injected).
 *
 * Backs `maestro-cli mcp serve` - the MCP stdio server an agent spawns to reach
 * the running Maestro app. This module owns the app-facing half: it turns the
 * pure {@link createMcpToolServer}'s `listTools`/`callTool` callbacks into
 * `plugins_list_tools` / `plugins_call_tool` requests over the desktop
 * WebSocket, and maintains the MCP-name <-> namespaced-toolId map. The app
 * may also offer core tools (the token proxy's retrieve tool) to the agent
 * its run proof names, with the server `instructions` that go with them.
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

/** The app's `plugins_list_tools_result`. */
interface AppToolListResponse {
	tools?: AppToolEntry[];
	/** The MCP server's `instructions`, present when a core tool is offered. */
	instructions?: string;
}

/** Private desktop reply; the proof is never part of a result. */
interface AppToolCallResponse {
	ok?: boolean;
	result?: unknown;
	error?: string;
	/** A core tool's own failure, written for the model; shown even on a verified call. */
	toolError?: string;
	blocked?: boolean;
	reason?: string;
}

export interface McpBridgeDeps {
	serverInfo: { name: string; version: string };
	/** Host-only bearer proof, outside tool args; explicit invalid values deny. */
	runToken?: string | null;
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
	// Capture once: subsequent dependency mutations cannot change this run.
	const proofConfigured = Object.prototype.hasOwnProperty.call(deps, 'runToken');
	const runToken = deps.runToken;
	const proofValid =
		typeof runToken === 'string' && runToken.length === 64 && /^[0-9a-f]{64}$/.test(runToken);
	// MCP name -> namespaced toolId, rebuilt on every tools/list. MCP clients list
	// before they call, so this is always fresh for a subsequent tools/call.
	const nameToId = new Map<string, string>();
	// From the last tools/list; the app sends them only with a core tool.
	let appInstructions: string | undefined;

	async function listTools(): Promise<McpToolDef[]> {
		let entries: AppToolEntry[] = [];
		try {
			// The proof names the calling agent, so the app can offer its core
			// tools. An invalid proof is not sent: it would be offered none anyway.
			const res = await deps.request<AppToolListResponse>(
				{ type: 'plugins_list_tools', ...(proofValid ? { runToken } : {}) },
				'plugins_list_tools_result'
			);
			entries = Array.isArray(res.tools) ? res.tools : [];
			appInstructions =
				typeof res.instructions === 'string' && res.instructions ? res.instructions : undefined;
		} catch (e) {
			// App unreachable / not running: advertise zero tools rather than failing
			// the agent's MCP handshake.
			appInstructions = undefined;
			deps.log(
				proofConfigured
					? '[mcp] tools/list unavailable'
					: `[mcp] tools/list unavailable: ${e instanceof Error ? e.message : String(e)}`
			);
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
		if (proofConfigured && !proofValid)
			return { content: [{ type: 'text', text: 'Error: PLUGIN_DENIED' }], isError: true };
		// Reject any name not in the current tools/list map - never guess a toolId,
		// which could resolve to a non-tool command handler in the sandbox's map.
		const toolId = nameToId.get(name);
		if (!toolId) {
			return {
				content: [
					{ type: 'text', text: proofConfigured ? 'Unknown tool' : `Unknown tool: ${name}` },
				],
				isError: true,
			};
		}
		const res = await deps
			.request<AppToolCallResponse>(
				{ type: 'plugins_call_tool', toolId, args, ...(proofConfigured ? { runToken } : {}) },
				'plugins_call_tool_result',
				MCP_CALL_TIMEOUT_MS
			)
			.catch((error: unknown): AppToolCallResponse => {
				if (proofConfigured) return { ok: false, error: 'PLUGIN_DENIED' };
				throw error;
			});

		if (res.blocked) {
			return {
				content: [
					{
						type: 'text',
						text: `Blocked by Maestro risk gate: ${proofConfigured ? 'high-risk' : (res.reason ?? 'high-risk')}`,
					},
				],
				isError: true,
			};
		}
		if (!res.ok && typeof res.toolError === 'string' && res.toolError) {
			return { content: [{ type: 'text', text: `Error: ${res.toolError}` }], isError: true };
		}
		if (!res.ok) {
			return {
				content: [
					{
						type: 'text',
						text: `Error: ${proofConfigured ? 'PLUGIN_DENIED' : (res.error ?? 'tool call failed')}`,
					},
				],
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
		// The app decides what is offered, so ask it once at initialize. A list
		// that fails leaves no instructions, never a failed handshake.
		instructions: async () => {
			await listTools();
			return appInstructions;
		},
		onError: (e, ctx) =>
			deps.log(
				proofConfigured
					? '[mcp] request failed'
					: `[mcp] ${ctx}: ${e instanceof Error ? e.message : String(e)}`
			),
	});

	return { server, listTools, callTool };
}
