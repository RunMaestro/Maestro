/**
 * Builds the Claude Code CLI arguments that route tool-permission decisions
 * through the Maestro relay, and resolves the bundled bridge script path.
 *
 * These args are injected only for claude-code, only on the API/print path,
 * only when `permissionMode === 'standard'`, and never over SSH (see
 * `process.ts`). Without them, Claude aborts the run on the first non-allowed
 * tool call.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import {
	RELAY_MCP_SERVER_NAME,
	RELAY_PERMISSION_PROMPT_TOOL,
	RELAY_SOCKET_ENV,
	RELAY_TOKEN_ENV,
} from './types';

const LOG_CONTEXT = '[PermissionRelay]';

/**
 * Locate the bridge script that Claude spawns as its MCP server.
 *
 * Packaged builds MUST list the resources-root candidate first. The bridge is
 * launched via `process.execPath` + ELECTRON_RUN_AS_NODE=1, and that plain-Node
 * process cannot read inside app.asar - so it ships OUTSIDE the asar as a
 * single bundled file at `<resources>/permission-relay-bridge.js` (via
 * extraResources, same as maestro-p.js). The main process's own `fs` IS
 * asar-aware, so if we checked the in-asar `__dirname/bridge.js` first,
 * accessSync would happily succeed and hand the spawned Node an unreadable
 * path. Checking resourcesPath first avoids that trap; in dev `resourcesPath`
 * points at Electron's own resources (no bridge there), so it falls through to
 * the tsc-compiled `__dirname/bridge.js` sibling, which dev spawns fine.
 */
export function resolveBridgeScriptPath(): string | null {
	const candidates: string[] = [];

	// Packaged: bundled single-file bridge at the resources root (outside asar).
	if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
		candidates.push(path.join(process.resourcesPath, 'permission-relay-bridge.js'));
	}

	// Dev: tsc output next to this module (has a `require('./types')` sibling).
	candidates.push(
		path.join(__dirname, 'bridge.js'),
		path.resolve(__dirname, '..', 'permission-relay', 'bridge.js')
	);

	for (const candidate of candidates) {
		try {
			fs.accessSync(candidate, fs.constants.R_OK);
			return candidate;
		} catch {
			continue;
		}
	}
	logger.warn('No readable permission-relay bridge script candidate found', LOG_CONTEXT, {
		candidates,
	});
	return null;
}

export interface RelayArgsResult {
	/** Args to append to the Claude spawn (permission-prompt-tool + mcp-config). */
	args: string[];
}

/**
 * Build the relay CLI args. `execPath` is the Node/Electron binary the bridge
 * runs under (pass `process.execPath`); `bridgeScriptPath` from
 * `resolveBridgeScriptPath()`. Returns null if the bridge can't be located
 * (caller must fail loud rather than silently spawn without the relay).
 */
export function buildRelayArgs(
	execPath: string,
	bridgeScriptPath: string,
	socketPath: string,
	token: string
): RelayArgsResult {
	const mcpConfig = {
		mcpServers: {
			[RELAY_MCP_SERVER_NAME]: {
				command: execPath,
				args: [bridgeScriptPath],
				env: {
					// Run the bridge as plain Node under the Electron binary.
					ELECTRON_RUN_AS_NODE: '1',
					[RELAY_SOCKET_ENV]: socketPath,
					[RELAY_TOKEN_ENV]: token,
				},
			},
		},
	};

	return {
		args: [
			'--permission-prompt-tool',
			RELAY_PERMISSION_PROMPT_TOOL,
			'--mcp-config',
			JSON.stringify(mcpConfig),
		],
	};
}
