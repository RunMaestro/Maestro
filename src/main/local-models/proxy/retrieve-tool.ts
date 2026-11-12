/**
 * The core `retrieve_compressed_original` tool on the MCP bridge: who is
 * offered it, and what one call answers.
 *
 * The bridge handlers (`plugins_list_tools` / `plugins_call_tool` in
 * `src/main/web-server/handlers/messageHandlers/plugins.ts`) ask this module
 * first. The caller is the agent named by the bridge's run proof, never an id
 * in the tool arguments; a caller without a valid proof is offered nothing.
 * Lookup is by exact hash only, through `readTokenProxyBlock()`: no search and
 * no listing.
 */
import {
	TOKEN_PROXY_RETRIEVE_DEFAULT_LINES,
	TOKEN_PROXY_RETRIEVE_INPUT_SCHEMA,
	TOKEN_PROXY_RETRIEVE_INSTRUCTIONS,
	TOKEN_PROXY_RETRIEVE_TOOL_DESCRIPTION,
	TOKEN_PROXY_RETRIEVE_TOOL_ID,
	TOKEN_PROXY_RETRIEVE_TOOL_NAME,
} from '../../../shared/local-models/token-proxy-retrieve-tool';
import {
	TOKEN_PROXY_ORIGINAL_RANGE_MAX_LINES,
	type TokenProxyBlockDetail,
	type TokenProxyOriginalLineRange,
} from '../../../shared/local-models/token-proxy';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { agentHasTokenProxyRetrieval, readTokenProxyBlock } from './service';

const LOG_CONTEXT = 'TokenProxyRetrieveTool';

/** One core tool as the bridge's `plugins_list_tools_result` carries it. */
export interface CoreBridgeTool {
	name: string;
	toolId: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export const TOKEN_PROXY_RETRIEVE_BRIDGE_TOOL: Readonly<CoreBridgeTool> = Object.freeze({
	name: TOKEN_PROXY_RETRIEVE_TOOL_NAME,
	toolId: TOKEN_PROXY_RETRIEVE_TOOL_ID,
	description: TOKEN_PROXY_RETRIEVE_TOOL_DESCRIPTION,
	inputSchema: TOKEN_PROXY_RETRIEVE_INPUT_SCHEMA as Record<string, unknown>,
});

/** What the bridge offers one caller beside its plugin tools. */
export interface CoreBridgeOffer {
	tools: CoreBridgeTool[];
	/** The MCP server's `instructions`, or undefined when no core tool is offered. */
	instructions?: string;
}

/** Whether a bridge tool id is a core tool rather than a plugin tool. */
export function isCoreBridgeToolId(toolId: string): boolean {
	return toolId === TOKEN_PROXY_RETRIEVE_TOOL_ID;
}

/**
 * The core tools offered to the agent a run proof resolved to. `null` (no
 * valid proof) is offered nothing.
 */
export async function coreBridgeToolsFor(callerAgentId: string | null): Promise<CoreBridgeOffer> {
	if (callerAgentId === null || !(await agentHasTokenProxyRetrieval(callerAgentId))) {
		return { tools: [] };
	}
	return {
		tools: [{ ...TOKEN_PROXY_RETRIEVE_BRIDGE_TOOL }],
		instructions: TOKEN_PROXY_RETRIEVE_INSTRUCTIONS,
	};
}

export type CoreBridgeToolCallResult = { ok: true; text: string } | { ok: false; error: string };

type ParsedRetrieveArgs =
	| { ok: true; hash: string; range: TokenProxyOriginalLineRange }
	| { ok: false; error: string };

const RANGE_ERROR = `start_line and end_line must be positive integers with start_line <= end_line, at most ${TOKEN_PROXY_ORIGINAL_RANGE_MAX_LINES} lines apart.`;

function isLineNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Read the model's arguments. A missing range is lines 1 to 200; a missing
 * `end_line` is 200 lines from `start_line`; a missing `start_line` is 1.
 */
export function parseRetrieveToolArgs(args: unknown): ParsedRetrieveArgs {
	if (typeof args !== 'object' || args === null || Array.isArray(args)) {
		return { ok: false, error: `${TOKEN_PROXY_RETRIEVE_TOOL_NAME} requires an object with hash.` };
	}
	const { hash, start_line: start, end_line: end } = args as Record<string, unknown>;
	if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
		return {
			ok: false,
			error:
				'hash must be the 64 lowercase hex characters after sha256= in a [maestro-compressed ...] marker.',
		};
	}
	if ((start !== undefined && !isLineNumber(start)) || (end !== undefined && !isLineNumber(end))) {
		return { ok: false, error: RANGE_ERROR };
	}
	const startLine = start ?? 1;
	const endLine = end ?? startLine + TOKEN_PROXY_RETRIEVE_DEFAULT_LINES - 1;
	if (endLine < startLine || endLine - startLine >= TOKEN_PROXY_ORIGINAL_RANGE_MAX_LINES) {
		return { ok: false, error: RANGE_ERROR };
	}
	return { ok: true, hash, range: { startLine, endLine } };
}

/**
 * The answer's first line: which lines came back and whether more follow.
 * The exact original text comes after it, unchanged.
 */
export function formatRetrieveHeader(
	hash: string,
	requested: TokenProxyOriginalLineRange,
	block: Pick<TokenProxyBlockDetail, 'originalRange'>
): string {
	const info = block.originalRange;
	const returned = info?.returned ?? null;
	if (returned === null) {
		return `[original sha256=${hash}: no lines from line ${requested.startLine}; the original has fewer lines]`;
	}
	const lines = `[original sha256=${hash} lines ${returned.startLine}-${returned.endLine}`;
	return info?.hasMore
		? `${lines}; more lines follow, call again with start_line=${returned.endLine + 1}]`
		: `${lines}; this is the end of the original]`;
}

/** Answer one call of the retrieve tool. Every refusal is a message, never a throw. */
export async function callTokenProxyRetrieveTool(args: unknown): Promise<CoreBridgeToolCallResult> {
	const parsed = parseRetrieveToolArgs(args);
	if (!parsed.ok) return parsed;
	const { hash, range } = parsed;
	let block: TokenProxyBlockDetail | null;
	try {
		block = await readTokenProxyBlock(hash, range);
	} catch (error) {
		// A range past the byte or scan limit is the caller's to narrow.
		if (error instanceof RangeError) return { ok: false, error: error.message };
		logger.warn('Retrieve tool could not read a compressed block', LOG_CONTEXT, {
			error: error instanceof Error ? error.message : String(error),
		});
		void captureException(error, { context: LOG_CONTEXT });
		return { ok: false, error: `The original of block ${hash} could not be read.` };
	}
	if (block === null) {
		return {
			ok: false,
			error: `No compressed block with hash ${hash} is stored on this machine. Pass the hash from a [maestro-compressed sha256=...] marker exactly.`,
		};
	}
	if (block.original === null) {
		return {
			ok: false,
			error: `The original of block ${hash} is no longer stored on this machine; only the shortened text remains.`,
		};
	}
	return { ok: true, text: `${formatRetrieveHeader(hash, range, block)}\n${block.original}` };
}
