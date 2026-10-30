/**
 * Names shared by every piece of the `maestro-sketch` MCP transport: the bridge
 * (sketch-mcp-bridge.ts), the generated server script (sketch-mcp-server-script.ts),
 * the config installer (sketch-mcp-install.ts) and ProcessManager's per-spawn env
 * injection.
 *
 * Kept free of the bridge's module graph (sketch service, store, net) so
 * ProcessManager and the script generator can import it cheaply, the same
 * reason Coworking keeps its names in coworking-types.ts.
 */

import { getAppSocketPath } from '../coworking/coworking-socket-path';

/** Name of the MCP server entry in each provider's config. */
export const SKETCH_MCP_SERVER_NAME = 'maestro-sketch';
/** The socket path written into the provider's MCP config entry. */
export const SKETCH_SOCKET_ENV_VAR = 'MAESTRO_SKETCH_SOCKET';
/** The spawning window's socket, injected per spawn; preferred over the config value. */
export const SKETCH_SOCKET_OVERRIDE_ENV_VAR = 'MAESTRO_SKETCH_SOCKET_OVERRIDE';
/** The owning agent's bare id, injected per spawn; sent in `hello`. */
export const SKETCH_AGENT_ID_ENV_VAR = 'MAESTRO_SKETCH_AGENT_ID';

/** The bridge socket path for this userData directory. */
export function getSketchBridgeSocketPath(): string {
	return getAppSocketPath('sketch');
}

/** Tools T1-T12, in spec order. The MCP server forwards a call as `{method: <tool name>}`. */
export const SKETCH_TOOL_NAMES = [
	'sketch_list',
	'sketch_create',
	'sketch_read_scene',
	'sketch_changes',
	'sketch_add_elements',
	'sketch_update_elements',
	'sketch_delete_elements',
	'sketch_from_mermaid',
	'sketch_screenshot',
	'sketch_export',
	'sketch_focus',
	'sketch_chat_post',
] as const;

export type SketchToolName = (typeof SKETCH_TOOL_NAMES)[number];

/** The tools that change the canvas. */
export const SKETCH_CANVAS_WRITE_TOOLS: ReadonlySet<SketchToolName> = new Set([
	'sketch_add_elements',
	'sketch_update_elements',
	'sketch_delete_elements',
	'sketch_from_mermaid',
]);

export function isSketchToolName(value: unknown): value is SketchToolName {
	return typeof value === 'string' && (SKETCH_TOOL_NAMES as readonly string[]).includes(value);
}
