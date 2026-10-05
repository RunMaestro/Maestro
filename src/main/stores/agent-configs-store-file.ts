/**
 * `maestro-agent-configs.json` read and written straight off disk, for every
 * caller that runs without the desktop's electron-store: the CLI (provider
 * binary paths, `settings agent`), the bundle exporter (provider env) and the
 * bundle importer (`--agent-path`).
 *
 * The file holds per-PROVIDER settings keyed by tool type, not per-agent ones:
 * `configs['claude-code'].customPath` is the binary every Cue run, CLI spawn
 * and the desktop's agent detector use for Claude Code.
 *
 * The desktop keeps this store in its PRODUCTION data path even in dev mode
 * (`stores/instances.ts`), so a dev desktop does not read a dev data dir's copy.
 *
 * No Electron import: the CLI and the standalone Cue engine load this.
 */

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJson } from '../utils/atomic-json-store';

export const AGENT_CONFIGS_STORE_FILENAME = 'maestro-agent-configs.json';

/** One provider's settings (`customPath`, `customEnvVars`, `customArgs`, ...). */
export type AgentConfig = Record<string, unknown>;

/** The file's top level. Keys other than `configs` are kept as they are. */
export interface AgentConfigsStoreData {
	configs?: Record<string, AgentConfig>;
	[key: string]: unknown;
}

export interface AgentConfigsStoreFile {
	/** The parsed file, or undefined when it does not exist. */
	data: AgentConfigsStoreData | undefined;
	/** `data.configs`, or empty when the file or the map is missing. */
	configs: Record<string, AgentConfig>;
}

/** The agent configs file exists but is not a JSON object. */
export class AgentConfigsStoreCorruptError extends Error {
	constructor(
		readonly filePath: string,
		cause: string
	) {
		super(`Could not read ${AGENT_CONFIGS_STORE_FILENAME}: ${cause}`);
		this.name = 'AgentConfigsStoreCorruptError';
	}
}

export function agentConfigsStorePath(dataDir: string): string {
	return path.join(dataDir, AGENT_CONFIGS_STORE_FILENAME);
}

/**
 * Read the agent configs file in `dataDir`. A missing file reads as empty; any
 * other read error is rethrown as is, and content that is not a JSON object
 * throws {@link AgentConfigsStoreCorruptError}.
 */
export function readAgentConfigsStoreFile(dataDir: string): AgentConfigsStoreFile {
	const filePath = agentConfigsStorePath(dataDir);
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { data: undefined, configs: {} };
		}
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new AgentConfigsStoreCorruptError(
			filePath,
			error instanceof Error ? error.message : String(error)
		);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new AgentConfigsStoreCorruptError(filePath, 'the file is not a JSON object');
	}
	const data = parsed as AgentConfigsStoreData;
	const configs =
		data.configs && typeof data.configs === 'object' && !Array.isArray(data.configs)
			? data.configs
			: {};
	return { data, configs };
}

/**
 * Atomically replace the agent configs file in `dataDir` with `data`. The
 * caller passes the whole top level (read with {@link readAgentConfigsStoreFile}),
 * so keys it did not touch survive.
 */
export async function writeAgentConfigsStoreFile(
	dataDir: string,
	data: AgentConfigsStoreData
): Promise<void> {
	await atomicWriteJson(agentConfigsStorePath(dataDir), data);
}
