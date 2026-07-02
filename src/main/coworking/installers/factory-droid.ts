/**
 * Factory Droid installer - writes the `maestro-coworking` MCP entry into
 * `~/.factory/mcp.json`. Droid's stdio MCP shape uses `type: "stdio"` plus
 * the standard `command / args / env` triple.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const commentJson = require('comment-json');
import { atomicWriteFile } from '../../utils/atomic-json-store';
import { COWORKING_MCP_SERVER_NAME } from '../coworking-types';
import type { CoworkingMcpServerSpec } from '../coworking-types';
import type { AgentMcpInstaller } from './types';

function configPath(): string {
	return path.join(os.homedir(), '.factory', 'mcp.json');
}

async function readConfig(): Promise<unknown> {
	try {
		const raw = await fs.promises.readFile(configPath(), 'utf8');
		return commentJson.parse(raw);
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
			return commentJson.parse('{}');
		}
		throw err;
	}
}

async function writeConfig(config: unknown): Promise<void> {
	await fs.promises.mkdir(path.dirname(configPath()), { recursive: true });
	const out = commentJson.stringify(config, null, 2) + '\n';
	// Atomic write so a crash mid-write can't truncate the user's mcp.json.
	await atomicWriteFile(configPath(), out);
}

export const factoryDroidInstaller: AgentMcpInstaller = {
	agentId: 'factory-droid',
	configPath,

	async isInstalled() {
		const cfg = (await readConfig()) as Record<string, unknown>;
		const servers = cfg?.mcpServers as Record<string, unknown> | undefined;
		return !!servers && Object.prototype.hasOwnProperty.call(servers, COWORKING_MCP_SERVER_NAME);
	},

	async install(spec: CoworkingMcpServerSpec) {
		const cfg = (await readConfig()) as Record<string, unknown>;
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
		await writeConfig(cfg);
	},

	async uninstall() {
		const cfg = (await readConfig()) as Record<string, unknown>;
		const servers = cfg?.mcpServers as Record<string, unknown> | undefined;
		if (!servers) return;
		if (!Object.prototype.hasOwnProperty.call(servers, COWORKING_MCP_SERVER_NAME)) return;
		delete servers[COWORKING_MCP_SERVER_NAME];
		if (Object.keys(servers).length === 0) {
			delete cfg.mcpServers;
		}
		await writeConfig(cfg);
	},
};
