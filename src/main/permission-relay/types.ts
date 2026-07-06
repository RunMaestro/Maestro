/**
 * Shared types for the Claude Code permission relay.
 *
 * When Claude Code runs in `standard` permission mode on the API/print path,
 * it aborts the entire run on the first non-allowed tool call unless a
 * `--permission-prompt-tool` MCP tool answers the request. Maestro supplies
 * that tool via a tiny stdio MCP bridge (`bridge.ts`) that Claude spawns; the
 * bridge dials back to a Maestro-owned unix-domain socket
 * (`PermissionRelayServer`) which surfaces the request to the user and returns
 * their decision.
 *
 * See `docs/agent-guides/` and PR #1155 for the wider 3-way permission-mode
 * design. This module is claude-code-only; other agents do not use the relay.
 */

/**
 * The decision returned to Claude Code for a single tool-permission request.
 * Mirrors the Claude Code permission-prompt-tool contract: the tool result's
 * text content must be a JSON string of exactly this shape.
 */
export type PermissionDecision =
	| { behavior: 'allow'; updatedInput?: Record<string, unknown> }
	| { behavior: 'deny'; message: string };

/**
 * A pending permission request, surfaced to the renderer for a user decision.
 * `requestId` is unique per request; `token` identifies the spawn (and thus
 * the session/tab) that produced it.
 */
export interface PermissionRequest {
	requestId: string;
	token: string;
	sessionId: string;
	tabId?: string;
	/** The tool Claude wants to run, e.g. "Bash", "Edit", "Write". */
	toolName: string;
	/** The tool input Claude proposed (command, file path + contents, etc.). */
	input: Record<string, unknown>;
	createdAt: number;
}

/** Identifies which session/tab a spawn's relay token belongs to. */
export interface RelaySpawnBinding {
	sessionId: string;
	tabId?: string;
}

// --- Wire protocol: bridge (client) <-> Maestro (server) over the UDS. ---
// Newline-delimited JSON. Each line is one message object below.

/** Messages sent from the bridge to Maestro. */
export type BridgeToServerMessage =
	| { type: 'hello'; token: string }
	| {
			type: 'permission-request';
			token: string;
			requestId: string;
			toolName: string;
			input: Record<string, unknown>;
	  };

/** Messages sent from Maestro to the bridge. */
export type ServerToBridgeMessage =
	| { type: 'hello-ack'; ok: boolean; error?: string }
	| { type: 'permission-response'; requestId: string; decision: PermissionDecision };

/** The MCP server name Maestro registers for the relay. */
export const RELAY_MCP_SERVER_NAME = 'maestro_permissions';

/** The MCP tool name (unprefixed) the bridge exposes for approvals. */
export const RELAY_MCP_TOOL_NAME = 'approve';

/**
 * The fully-qualified tool name Claude expects for `--permission-prompt-tool`.
 * Claude prefixes MCP tools with `mcp__<serverName>__<toolName>`.
 */
export const RELAY_PERMISSION_PROMPT_TOOL = `mcp__${RELAY_MCP_SERVER_NAME}__${RELAY_MCP_TOOL_NAME}`;

/** Env var names the bridge reads to find + authenticate to the socket. */
export const RELAY_SOCKET_ENV = 'MAESTRO_RELAY_SOCKET';
export const RELAY_TOKEN_ENV = 'MAESTRO_RELAY_TOKEN';

/** How long a request waits for a user decision before auto-denying (ms). */
export const RELAY_DECISION_TIMEOUT_MS = 300_000;
