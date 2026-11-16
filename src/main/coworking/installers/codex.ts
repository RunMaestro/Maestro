/**
 * Codex installer: splice only Maestro's sentinel-delimited TOML block, preserving
 * user comments and formatting. Parse for validation, never rewrite the whole file.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { atomicWriteFile } from '../../utils/atomic-json-store';
import { COWORKING_MCP_SERVER_NAME } from '../coworking-types';
import type { CoworkingMcpServerSpec } from '../coworking-types';
import type { AgentMcpInstaller } from './types';

const SENTINEL_BEGIN = '# >>> maestro-coworking BEGIN - managed by Maestro, do not edit';
const LEGACY_SENTINEL_BEGIN = '# >>> maestro-coworking BEGIN — managed by Maestro, do not edit';
const SENTINEL_END = '# <<< maestro-coworking END';

function configPath(): string {
	return path.join(os.homedir(), '.codex', 'config.toml');
}

async function readConfig(): Promise<string | null> {
	try {
		return await fs.promises.readFile(configPath(), 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
		throw err;
	}
}

async function writeConfig(content: string): Promise<void> {
	try {
		parseToml(content);
	} catch {
		// Parser errors can include excerpts of the user's configuration.
		throw new Error(
			'Codex coworking: updated configuration is not valid TOML; no changes written.'
		);
	}
	await fs.promises.mkdir(path.dirname(configPath()), { recursive: true });
	await atomicWriteFile(configPath(), content);
}

function buildBlock(spec: CoworkingMcpServerSpec): string {
	const body = stringifyToml({ mcp_servers: { [COWORKING_MCP_SERVER_NAME]: spec } }).trimEnd();
	return `${SENTINEL_BEGIN}\n${body}\n${SENTINEL_END}`;
}

function findBlock(content: string): { start: number; end: number } | null {
	// Match reserved marker lines, including malformed ones. Never guess which of
	// multiple/partial blocks to replace, or use a marker embedded in a value.
	const markers = [...content.matchAll(/^.*# (?:>>>|<<<) maestro-coworking[^\r\n]*/gm)];
	let found: { start: number; end: number } | null = null;
	if (markers.length > 0) {
		if (
			markers.length !== 2 ||
			![SENTINEL_BEGIN, LEGACY_SENTINEL_BEGIN].includes(markers[0][0]) ||
			markers[1][0] !== SENTINEL_END
		) {
			throw new Error('Codex coworking: ambiguous or damaged managed markers; no changes written.');
		}
		found = { start: markers[0].index!, end: markers[1].index! + SENTINEL_END.length };
	}

	try {
		const config = parseToml(content);
		const outside = found ? content.slice(0, found.start) + content.slice(found.end) : content;
		const userConfig = parseToml(outside);
		const servers = userConfig.mcp_servers;
		if (
			servers !== undefined &&
			(typeof servers !== 'object' ||
				servers === null ||
				Array.isArray(servers) ||
				servers instanceof Date ||
				Object.hasOwn(servers, COWORKING_MCP_SERVER_NAME))
		) {
			throw new Error('unmanaged server or invalid mcp_servers');
		}
		if (found) {
			const managed = parseToml(content.slice(found.start, found.end));
			const ownedServers = managed.mcp_servers;
			if (
				Object.keys(managed).length !== 1 ||
				typeof ownedServers !== 'object' ||
				ownedServers === null ||
				Array.isArray(ownedServers) ||
				Object.keys(ownedServers).length !== 1 ||
				!Object.hasOwn(ownedServers, COWORKING_MCP_SERVER_NAME) ||
				!isDeepStrictEqual(
					config,
					Object.assign(userConfig, {
						mcp_servers: Object.assign(Object.create(null), servers, ownedServers),
					})
				)
			) {
				throw new Error('managed block includes or changes foreign configuration');
			}
		}
	} catch {
		throw new Error(
			'Codex coworking: invalid TOML, unmanaged maestro-coworking entry, or unsafe managed block; no changes written.'
		);
	}
	return found;
}

export const codexInstaller: AgentMcpInstaller = {
	agentId: 'codex',
	configPath,

	async isInstalled() {
		const content = await readConfig();
		if (!content) return false;
		try {
			return findBlock(content) !== null;
		} catch {
			return false;
		}
	},

	async install(spec: CoworkingMcpServerSpec) {
		const block = buildBlock(spec);
		const existing = (await readConfig()) ?? '';
		const found = findBlock(existing);
		if (found) {
			const newline = existing.includes('\r\n') ? '\r\n' : '\n';
			await writeConfig(
				existing.slice(0, found.start) + block.replace(/\n/g, newline) + existing.slice(found.end)
			);
			return;
		}
		const sep =
			!existing || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
		await writeConfig(existing + sep + block + '\n');
	},

	async uninstall() {
		const existing = await readConfig();
		if (!existing) return;
		const found = findBlock(existing);
		if (!found) return;
		let endTrim = found.end;
		if (existing.slice(endTrim, endTrim + 2) === '\r\n') endTrim += 2;
		else if (existing[endTrim] === '\n') endTrim += 1;
		let startTrim = found.start;
		if (existing.slice(0, startTrim).endsWith('\r\n\r\n')) startTrim -= 2;
		else if (existing.slice(0, startTrim).endsWith('\n\n')) startTrim -= 1;
		await writeConfig(existing.slice(0, startTrim) + existing.slice(endTrim));
	},
};
