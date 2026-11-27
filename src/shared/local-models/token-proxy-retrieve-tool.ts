/**
 * The `retrieve_compressed_original` tool: what the model is told and what it
 * may pass. Pure, so every reader (the bridge handlers, and the
 * compressor's recovery veto) shares one definition.
 *
 * The tool is a core tool on the per-launch MCP bridge (`maestro-cli mcp
 * serve`), not a plugin tool: it is offered to an agent whose retrieval switch
 * is on while the proxy compresses for it, with the Plugins feature on or off.
 * It answers through `readTokenProxyBlock()` in `src/main/local-models/proxy/
 * service.ts`. Design: "Retrieval: the model asks for an original" in
 * `docs/architecture/local-models.md`.
 */
import { TOKEN_PROXY_ORIGINAL_RANGE_MAX_LINES } from './token-proxy';

/** The name the model sees. A client may prefix it (`mcp__<server>__`). */
export const TOKEN_PROXY_RETRIEVE_TOOL_NAME = 'retrieve_compressed_original';

/**
 * The id the bridge sends back on a call. A colon is not valid in a plugin id,
 * so it can never be a plugin tool's `pluginId/localId`.
 */
export const TOKEN_PROXY_RETRIEVE_TOOL_ID = 'maestro:retrieve_compressed_original';

/** Lines returned when the call names no range. */
export const TOKEN_PROXY_RETRIEVE_DEFAULT_LINES = 200;

/** The marker a shortened result ends with, as the model reads it. */
const MARKER_SHAPE = '[maestro-compressed sha256=<hash> original_tokens=<n>]';

export const TOKEN_PROXY_RETRIEVE_TOOL_DESCRIPTION =
	`Return the original lines of a tool result that Maestro shortened. A shortened result ends in ${MARKER_SHAPE}; pass that hash exactly. ` +
	`Returns lines 1 to ${TOKEN_PROXY_RETRIEVE_DEFAULT_LINES} by default; start_line and end_line (1-based, inclusive, at most ${TOKEN_PROXY_ORIGINAL_RANGE_MAX_LINES} lines) select others. ` +
	'The first line of the answer says which lines were returned and whether more follow. It reaches only originals this machine still holds.';

/**
 * The MCP server's `instructions`, sent on `initialize` when the tool is
 * offered. The marker text itself never changes, so no stored verdict changes
 * bytes because of this tool.
 */
export const TOKEN_PROXY_RETRIEVE_INSTRUCTIONS =
	`A tool result that ends in ${MARKER_SHAPE} was shortened by Maestro before you read it, and lines may have been left out. ` +
	`When you need what was left out, call ${TOKEN_PROXY_RETRIEVE_TOOL_NAME} with that hash: it returns the original lines. Do not guess at content that was left out.`;

export const TOKEN_PROXY_RETRIEVE_INPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
	type: 'object',
	properties: {
		hash: {
			type: 'string',
			pattern: '^[0-9a-f]{64}$',
			description: 'The sha256 value from the [maestro-compressed ...] marker.',
		},
		start_line: {
			type: 'integer',
			minimum: 1,
			description: 'First original line to return (1-based). Default 1.',
		},
		end_line: {
			type: 'integer',
			minimum: 1,
			description: `Last original line to return (inclusive). Default start_line + ${TOKEN_PROXY_RETRIEVE_DEFAULT_LINES - 1}.`,
		},
	},
	required: ['hash'],
	additionalProperties: false,
});
