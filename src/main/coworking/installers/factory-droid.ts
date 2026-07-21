/**
 * Factory Droid installer - writes the `maestro-coworking` MCP entry into
 * `~/.factory/mcp.json`. Droid's stdio MCP shape uses `type: "stdio"` plus
 * the standard `command / args / env` triple.
 */

import * as os from 'os';
import * as path from 'path';
const commentJson = require('comment-json');
import { createCommentJsonConfigStore } from './comment-json-config-store';
import { COWORKING_MCP_SERVER_NAME } from '../coworking-types';
import type { CoworkingMcpServerSpec } from '../coworking-types';
import type { AgentMcpInstaller } from './types';

function configPath(): string {
	return path.join(os.homedir(), '.factory', 'mcp.json');
}

const configStore = createCommentJsonConfigStore(configPath);

export const factoryDroidInstaller: AgentMcpInstaller = {
	agentId: 'factory-droid',
	configPath,

	async isInstalled() {
		const cfg = (await configStore.readConfig()) as Record<string, unknown>;
		const servers = cfg?.mcpServers as Record<string, unknown> | undefined;
		return !!servers && Object.prototype.hasOwnProperty.call(servers, COWORKING_MCP_SERVER_NAME);
	},

	async install(spec: CoworkingMcpServerSpec) {
		const cfg = (await configStore.readConfig()) as Record<string, unknown>;
		if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') {
			cfg.mcpServers = commentJson.parse('{}');
		}
		const servers = cfg.mcpServers as Record<string, unknown>;
		servers[COWORKING_MCP_SERVER_NAME] = {
			type: 'stdio',
			command: spec.command,
			args: spec.args,
			env: spec.env,
		};
		await configStore.writeConfig(cfg);
	},

	async uninstall() {
		const cfg = (await configStore.readConfig()) as Record<string, unknown>;
		const servers = cfg?.mcpServers as Record<string, unknown> | undefined;
		if (!servers) return;
		if (!Object.prototype.hasOwnProperty.call(servers, COWORKING_MCP_SERVER_NAME)) return;
		delete servers[COWORKING_MCP_SERVER_NAME];
		if (Object.keys(servers).length === 0) {
			delete cfg.mcpServers;
		}
		await configStore.writeConfig(cfg);
	},
};
