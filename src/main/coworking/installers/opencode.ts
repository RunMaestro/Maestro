/**
 * OpenCode installer - writes the `maestro-coworking` MCP entry into
 * `~/.config/opencode/opencode.json` (XDG-style location). OpenCode's stdio
 * MCP shape uses `type: "local"` and a single combined `command` array.
 */

import * as os from 'os';
import * as path from 'path';
const commentJson = require('comment-json');
import { createCommentJsonConfigStore } from './comment-json-config-store';
import { COWORKING_MCP_SERVER_NAME } from '../coworking-types';
import type { CoworkingMcpServerSpec } from '../coworking-types';
import type { AgentMcpInstaller } from './types';

function configDir(): string {
	const xdg = process.env.XDG_CONFIG_HOME;
	if (xdg && xdg.trim().length > 0) return path.join(xdg, 'opencode');
	return path.join(os.homedir(), '.config', 'opencode');
}

function configPath(): string {
	return path.join(configDir(), 'opencode.json');
}

const configStore = createCommentJsonConfigStore(configPath);

export const opencodeInstaller: AgentMcpInstaller = {
	agentId: 'opencode',
	configPath,

	async isInstalled() {
		const cfg = (await configStore.readConfig()) as Record<string, unknown>;
		const mcp = cfg?.mcp as Record<string, unknown> | undefined;
		return !!mcp && Object.prototype.hasOwnProperty.call(mcp, COWORKING_MCP_SERVER_NAME);
	},

	async install(spec: CoworkingMcpServerSpec) {
		const cfg = (await configStore.readConfig()) as Record<string, unknown>;
		if (!cfg.mcp || typeof cfg.mcp !== 'object') {
			cfg.mcp = commentJson.parse('{}');
		}
		const mcp = cfg.mcp as Record<string, unknown>;
		mcp[COWORKING_MCP_SERVER_NAME] = {
			type: 'local',
			command: [spec.command, ...spec.args],
			environment: spec.env,
			enabled: true,
		};
		await configStore.writeConfig(cfg);
	},

	async uninstall() {
		const cfg = (await configStore.readConfig()) as Record<string, unknown>;
		const mcp = cfg?.mcp as Record<string, unknown> | undefined;
		if (!mcp) return;
		if (!Object.prototype.hasOwnProperty.call(mcp, COWORKING_MCP_SERVER_NAME)) return;
		delete mcp[COWORKING_MCP_SERVER_NAME];
		if (Object.keys(mcp).length === 0) {
			delete cfg.mcp;
		}
		await configStore.writeConfig(cfg);
	},
};
