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
	/** Temp file holding the MCP config JSON; caller deletes it on cleanup. */
	configPath: string;
}

/** Build the MCP server config object Claude loads via --mcp-config. */
function buildMcpConfig(execPath: string, bridgeScriptPath: string, socketPath: string, token: string) {
	return {
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
}

/**
 * Build the relay CLI args. `execPath` is the Node/Electron binary the bridge
 * runs under (pass `process.execPath`); `bridgeScriptPath` from
 * `resolveBridgeScriptPath()`; `configDir` a writable dir for the temp config
 * (pass the app's userData dir).
 *
 * The MCP config is written to a temp JSON file and passed to --mcp-config by
 * PATH rather than as an inline JSON string. On Windows, non-SSH agent spawns
 * run through a shell (`useShell: true`, to dodge cmd.exe length limits), and a
 * raw `JSON.stringify(...)` arg's embedded quotes would not be re-escaped for
 * PowerShell/cmd - Claude would receive a malformed --mcp-config and standard
 * mode would silently abort on the first tool call. A file path has no shell
 * metacharacters, so it survives quoting on every platform. `--mcp-config` has
 * accepted a file path since the flag was introduced.
 */
export function buildRelayArgs(
	execPath: string,
	bridgeScriptPath: string,
	socketPath: string,
	token: string,
	configDir: string
): RelayArgsResult {
	const mcpConfig = buildMcpConfig(execPath, bridgeScriptPath, socketPath, token);
	// Token is a 64-hex-char nonce; a short prefix keeps the filename unique
	// per spawn without leaking the full auth token into a predictable path.
	const configPath = path.join(configDir, `permission-relay-mcp-${token.slice(0, 16)}.json`);
	fs.writeFileSync(configPath, JSON.stringify(mcpConfig), { mode: 0o600 });

	return {
		args: [
			'--permission-prompt-tool',
			RELAY_PERMISSION_PROMPT_TOOL,
			'--mcp-config',
			configPath,
		],
		configPath,
	};
}
