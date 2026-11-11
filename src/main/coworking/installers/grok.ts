/**
 * Grok installer - writes the `maestro-coworking` MCP entry into the selected
 * Grok account's `config.toml` (`$GROK_HOME/config.toml`, else
 * `~/.grok/config.toml`; the account root comes from the one Grok profile
 * config, `getProviderProfileConfig('grok')`).
 *
 * The table body is the phase-07 Grok MCP representation: it is produced by
 * `buildMcpInjection()` over `MCP_CONFIG_BY_AGENT.grok` (the
 * `[mcp_servers.<name>]` schema of the pinned grok-build source, serialized by
 * smol-toml, never templated) and only renamed to the coworking server. Like the
 * Codex installer the entry sits in a sentinel-delimited block so comments and
 * key order of the user's file survive, and uninstall removes only that block.
 *
 * Every write is validated before it lands: the user's file must parse, the
 * candidate must parse to the user's own tables plus exactly our entry, and a
 * `maestro-coworking` server the user defined themselves is theirs. Anything
 * else refuses with a `GrokCoworkingInstallRefusedError` and touches nothing.
 * Installing the entry is not qualification: whether a given Grok binary loads
 * it stays a live-evidence blocker (parity S35).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseToml } from 'smol-toml';
import { isBlankEnvValue } from '../../../shared/agentEnvironment';
import {
	buildMcpInjection,
	MCP_CONFIG_BY_AGENT,
	MCP_SERVER_NAME,
} from '../../../shared/plugins/mcp-agent-config';
import { getProviderProfileConfig } from '../../../shared/providerProfiles';
import { atomicWriteFile } from '../../utils/atomic-json-store';
import { COWORKING_MCP_SERVER_NAME } from '../coworking-types';
import type { CoworkingMcpServerSpec } from '../coworking-types';
import type { AgentMcpInstaller } from './types';

const SENTINEL_BEGIN = '# >>> maestro-coworking BEGIN - managed by Maestro, do not edit';
const SENTINEL_END = '# <<< maestro-coworking END';

/** Why a Grok coworking install was refused. Each one leaves the file untouched. */
export type GrokCoworkingRefusal =
	/** No pinned native schema for Grok MCP servers is registered. */
	| 'schema-unknown'
	/** The account's `config.toml` is not TOML, or `mcp_servers` is not a table. */
	| 'config-unreadable'
	/** The user defines a `maestro-coworking` server outside Maestro's block. */
	| 'entry-not-owned'
	/** Appending the entry would not yield the user's tables plus exactly ours. */
	| 'schema-conflict'
	/** The config path is not a regular file (a symlink or a directory). */
	| 'target-unsupported';

export class GrokCoworkingInstallRefusedError extends Error {
	constructor(
		readonly refusal: GrokCoworkingRefusal,
		detail: string
	) {
		super(`Grok coworking install refused (${refusal}): ${detail}`);
		this.name = 'GrokCoworkingInstallRefusedError';
	}
}

function configDir(): string {
	const profile = getProviderProfileConfig('grok');
	const envVar = profile?.envVar ?? 'GROK_HOME';
	const selected = process.env[envVar];
	if (selected !== undefined && !isBlankEnvValue(selected)) return selected;
	return path.join(os.homedir(), profile?.defaultSubdir ?? '.grok');
}

function configPath(): string {
	return path.join(configDir(), 'config.toml');
}

function refuse(refusal: GrokCoworkingRefusal, detail: string): never {
	throw new GrokCoworkingInstallRefusedError(refusal, detail);
}

/** Refuse a target Maestro cannot replace atomically without changing its kind. */
async function assertWritableTarget(file: string): Promise<void> {
	let stat: fs.Stats;
	try {
		stat = await fs.promises.lstat(file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
		throw err;
	}
	if (stat.isSymbolicLink()) {
		refuse('target-unsupported', `${file} is a symbolic link; replacing it would break the link`);
	}
	if (!stat.isFile()) refuse('target-unsupported', `${file} is not a regular file`);
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
	await fs.promises.mkdir(configDir(), { recursive: true });
	// Atomic write so a crash mid-write can't truncate the user's config.toml.
	await atomicWriteFile(configPath(), content);
}

function findBlock(content: string): { start: number; end: number } | null {
	const start = content.indexOf(SENTINEL_BEGIN);
	if (start === -1) return null;
	const endMarker = content.indexOf(SENTINEL_END, start);
	if (endMarker === -1) return null;
	return { start, end: endMarker + SENTINEL_END.length };
}

type TomlTable = Record<string, unknown>;

function isTable(value: unknown): value is TomlTable {
	return (
		typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
	);
}

function parseConfig(content: string, what: string): TomlTable {
	let parsed: unknown;
	try {
		parsed = parseToml(content);
	} catch (err) {
		refuse(
			'config-unreadable',
			`${what} is not valid TOML: ${err instanceof Error ? err.message : String(err)}`
		);
	}
	if (!isTable(parsed)) refuse('config-unreadable', `${what} is not a TOML table`);
	const servers = parsed.mcp_servers;
	if (servers !== undefined && !isTable(servers)) {
		refuse('config-unreadable', `${what} defines mcp_servers as something other than a table`);
	}
	return parsed;
}

function serversOf(config: TomlTable): TomlTable {
	return isTable(config.mcp_servers) ? config.mcp_servers : {};
}

/**
 * The coworking table in the phase-07 Grok representation: the one injection
 * builder's payload for the pinned schema, renamed from the per-spawn `maestro`
 * server to `maestro-coworking`.
 */
function buildBlock(spec: CoworkingMcpServerSpec): { block: string; server: TomlTable } {
	const cap = MCP_CONFIG_BY_AGENT.grok;
	if (!cap || cap.strategy !== 'grok-config-overlay' || !cap.schemaSource) {
		refuse('schema-unknown', 'no pinned Grok MCP server schema is registered');
	}
	const injection = buildMcpInjection(
		cap,
		{ command: spec.command, args: spec.args, env: spec.env },
		{ tmpDir: '', join: (...parts: string[]) => parts.join('/') }
	);
	const payload = injection.files[0]?.content;
	const server = payload
		? serversOf(parseConfig(payload, 'the Grok MCP payload'))[MCP_SERVER_NAME]
		: undefined;
	if (!isTable(server)) refuse('schema-unknown', 'the Grok MCP payload carries no server table');
	const body = payload!
		.split('\n')
		.map((line) =>
			line.startsWith(`[mcp_servers.${MCP_SERVER_NAME}`)
				? line.replace(
						`[mcp_servers.${MCP_SERVER_NAME}`,
						`[mcp_servers.${COWORKING_MCP_SERVER_NAME}`
					)
				: line
		)
		.join('\n')
		.trim();
	return { block: `${SENTINEL_BEGIN}\n${body}\n${SENTINEL_END}`, server };
}

/** Deterministic deep equality over parsed TOML values (tables compare by key set). */
function sameValue(a: unknown, b: unknown): boolean {
	if (a instanceof Date || b instanceof Date) {
		return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((v, i) => sameValue(v, b[i]))
		);
	}
	if (isTable(a) || isTable(b)) {
		if (!isTable(a) || !isTable(b)) return false;
		const keys = Object.keys(a);
		return (
			keys.length === Object.keys(b).length &&
			keys.every((k) => hasOwn(b, k) && sameValue(a[k], b[k]))
		);
	}
	return Object.is(a, b);
}

function hasOwn(table: TomlTable, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(table, key);
}

/** The configuration with Maestro's entry (and an emptied `mcp_servers`) taken out, for comparison. */
function withoutCoworking(config: TomlTable): TomlTable {
	const servers = { ...serversOf(config) };
	delete servers[COWORKING_MCP_SERVER_NAME];
	const out: TomlTable = { ...config };
	if (Object.keys(servers).length > 0) out.mcp_servers = servers;
	else delete out.mcp_servers;
	return out;
}

export const grokInstaller: AgentMcpInstaller = {
	agentId: 'grok',
	configPath,

	async isInstalled() {
		const content = await readConfig();
		if (!content) return false;
		if (!findBlock(content)) return false;
		// Installed means Grok would read our table, not merely that a marker exists.
		return isTable(serversOf(parseConfig(content, configPath()))[COWORKING_MCP_SERVER_NAME]);
	},

	async install(spec: CoworkingMcpServerSpec) {
		const { block, server } = buildBlock(spec);
		await assertWritableTarget(configPath());
		const existing = (await readConfig()) ?? '';
		const found = findBlock(existing);
		const userContent = found
			? existing.slice(0, found.start) + existing.slice(found.end)
			: existing;
		const userConfig = parseConfig(userContent, configPath());
		if (hasOwn(serversOf(userConfig), COWORKING_MCP_SERVER_NAME)) {
			refuse(
				'entry-not-owned',
				`${configPath()} defines its own ${COWORKING_MCP_SERVER_NAME} server outside Maestro's block`
			);
		}
		let next: string;
		if (found) {
			next = existing.slice(0, found.start) + block + existing.slice(found.end);
		} else if (existing.length === 0) {
			next = block + '\n';
		} else {
			// Append, ensuring exactly one blank line between user content and our block.
			const sep = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
			next = existing + sep + block + '\n';
		}
		let candidate: TomlTable;
		try {
			candidate = parseConfig(next, 'the updated configuration');
		} catch (err) {
			if (err instanceof GrokCoworkingInstallRefusedError) {
				refuse(
					'schema-conflict',
					`adding the entry to ${configPath()} would not parse: ${err.message}`
				);
			}
			throw err;
		}
		if (
			!sameValue(serversOf(candidate)[COWORKING_MCP_SERVER_NAME], server) ||
			!sameValue(withoutCoworking(candidate), withoutCoworking(userConfig))
		) {
			refuse(
				'schema-conflict',
				`adding the entry to ${configPath()} would change the user's own configuration`
			);
		}
		await writeConfig(next);
	},

	async uninstall() {
		const existing = await readConfig();
		if (!existing) return;
		const found = findBlock(existing);
		// A `maestro-coworking` server outside the block is the user's: never removed.
		if (!found) return;
		await assertWritableTarget(configPath());
		let endTrim = found.end;
		if (existing[endTrim] === '\n') endTrim += 1;
		let startTrim = found.start;
		if (startTrim >= 2 && existing[startTrim - 1] === '\n' && existing[startTrim - 2] === '\n') {
			startTrim -= 1;
		}
		await writeConfig(existing.slice(0, startTrim) + existing.slice(endTrim));
	},
};
