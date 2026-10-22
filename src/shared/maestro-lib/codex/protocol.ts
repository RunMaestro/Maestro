// src/main/codex-app-server/protocol.ts

/**
 * Wire shapes for `codex app-server` (newline-delimited JSON-RPC 2.0 on stdio).
 *
 * Only the fields Maestro reads are typed. Everything here was derived from the
 * live traffic in `src/__tests__/fixtures/codex-app-server/` and the schema
 * `codex app-server generate-json-schema` prints; see
 * `docs/agent-guides/CODEX-APP-SERVER.md` for the line-by-line evidence.
 *
 * Three kinds of line arrive on the server's stdout, told apart by which of
 * `id` and `method` they carry:
 *   - a NOTIFICATION has `method` and no `id`,
 *   - a RESPONSE to one of our requests has `id` and no `method`,
 *   - a REQUEST from the server has both, and must always be answered or the
 *     turn stalls forever.
 * Server lines omit `jsonrpc`.
 */

/** A JSON-RPC error object, as the server returns it on a failed request. */
export interface CodexRpcError {
	code: number;
	message: string;
	data?: unknown;
}

/** One decoded line from the server's stdout. */
export interface CodexAppServerMessage {
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: CodexRpcError;
}

export interface CodexAppServerNotification extends CodexAppServerMessage {
	method: string;
	id?: undefined;
}

export interface CodexAppServerResponse extends CodexAppServerMessage {
	id: number | string;
	method?: undefined;
}

export interface CodexAppServerRequest extends CodexAppServerMessage {
	id: number | string;
	method: string;
}

export function isCodexNotification(msg: CodexAppServerMessage): msg is CodexAppServerNotification {
	return typeof msg.method === 'string' && msg.id === undefined;
}

export function isCodexResponse(msg: CodexAppServerMessage): msg is CodexAppServerResponse {
	return msg.id !== undefined && msg.method === undefined;
}

export function isCodexServerRequest(msg: CodexAppServerMessage): msg is CodexAppServerRequest {
	return msg.id !== undefined && typeof msg.method === 'string';
}

/** `ThreadItem` members the translator maps. The rest of the union is dropped. */
export interface CodexAppServerItem {
	type: string;
	id: string;
	/** agentMessage */
	text?: string;
	phase?: string;
	/** userMessage */
	content?: Array<{ type: string; text?: string }> | string[];
	/** reasoning */
	summary?: string[];
	/** commandExecution */
	command?: string;
	aggregatedOutput?: string | null;
	exitCode?: number | null;
	status?: string;
}

/** The counters on a `thread/tokenUsage/updated` breakdown. */
export interface CodexAppServerTokenBreakdown {
	totalTokens?: number;
	inputTokens?: number;
	cachedInputTokens?: number;
	outputTokens?: number;
	reasoningOutputTokens?: number;
}

/** `TurnError`, carried by a failed turn and by the `error` notification. */
export interface CodexAppServerTurnError {
	message: string;
	additionalDetails?: string | null;
}

/** The `turn` object on `turn/started`, `turn/completed` and the `turn/start` response. */
export interface CodexAppServerTurn {
	id: string;
	status?: 'inProgress' | 'completed' | 'interrupted' | 'failed' | string;
	error?: CodexAppServerTurnError | null;
}

/** The `thread` object on the `thread/start` / `thread/resume` response and `thread/started`. */
export interface CodexAppServerThread {
	id: string;
}

/**
 * What a running app-server turn exposes on its `ManagedProcess`, for the
 * steering phase: the ids `turn/steer` needs, the channel to send it on, and
 * the `userMessage` items that tell an absorbed steer from a dropped one.
 */
export interface CodexAppServerProcessHandle {
	/** The thread (provider session) id, once `thread/start` or `thread/resume` answered. */
	readonly threadId: string | null;
	/** The running turn's id; null before `turn/start` answers and after the turn ends. */
	readonly activeTurnId: string | null;
	/**
	 * Send a request to this turn's server. Rejects with `CodexRpcRequestError`
	 * (carrying the server's error code) or `CodexRpcTransportError`.
	 */
	sendRequest<T = unknown>(
		method: string,
		params?: unknown,
		options?: { timeoutMs?: number }
	): Promise<T>;
	/** Subscribe to `userMessage` items completing in the active turn. Returns an unsubscribe. */
	onUserMessage(
		listener: (message: { turnId: string; itemId: string; text: string }) => void
	): () => void;
	/**
	 * Subscribe to the end of this process's turn: `turn/completed` arrived, the
	 * turn failed, or the child is gone. Fires once, BEFORE the exit is reported,
	 * so a verdict raised from it reaches the renderer ahead of the exit. A
	 * listener added after the end is called at once. Returns an unsubscribe.
	 */
	onTurnEnd(listener: () => void): () => void;
}
