/**
 * Model discovery for an agent, local or on an SSH remote.
 *
 * Lifted out of the `agents:*` IPC handlers so the desktop picker (over IPC)
 * and `maestro-cli models` (over the WebSocket bridge) run the same code.
 * `discoverAgentModels()` is the one entry point; a FORCED discovery also
 * broadcasts the fresh list on `MODELS_REFRESHED_CHANNEL`, which is what keeps
 * every picker already on screen in step with the Refresh button that ran it.
 */

import { AGENT_DEFINITIONS } from './definitions';
import { parseOpenCodeConfig, extractModelsFromConfig } from './opencode-config';
import type { AgentDetector } from './detector';
import {
	CLAUDE_CATALOG_SUBDIR,
	CLAUDE_MODEL_ALIASES,
	claudeCatalogModelIds,
} from './claude-model-catalog';
import { logger } from '../utils/logger';
import {
	buildSshCommand,
	execSshCommand,
	RemoteCommandOptions,
} from '../utils/ssh-command-builder';
import { stripAnsi } from '../utils/stripAnsi';
import type { SshRemoteConfig } from '../../shared/types';
import { parseJsonWithBom } from '../../shared/jsonUtils';
import { parseAntigravityModelList } from '../../shared/antigravityModels';
import {
	MODELS_REFRESHED_CHANNEL,
	type ModelsRefreshedPayload,
} from '../../shared/agentModelsRefresh';

const LOG_CONTEXT = '[AgentDetector]';

// Remote model discovery cache
const remoteModelCache = new Map<string, { models: string[]; timestamp: number }>();
const REMOTE_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
export const SSH_MODEL_TIMEOUT_MS = 10000;

const REMOTE_FILE_START = '___MAESTRO_REMOTE_FILE_START___';
const REMOTE_FILE_END = '___MAESTRO_REMOTE_FILE_END___';

/** One file read off an SSH remote: the path the remote shell expanded, and its text. */
interface RemoteTextFile {
	path: string;
	text: string;
}

/**
 * Read text files off an SSH remote in one round trip.
 *
 * Each pattern is a shell word the REMOTE shell expands (`~`, `$VAR`, a glob),
 * so one pattern may name several files and the remote's own home and
 * environment decide where they are. A pattern that matches nothing, or names a
 * file that does not exist, contributes nothing.
 *
 * Fails soft by design: a timeout, a non-zero exit or an ssh failure returns
 * what it has (usually nothing) and logs, because every caller treats remote
 * files as an optional source next to a list that is usable without them.
 */
async function readRemoteTextFiles(
	sshRemote: SshRemoteConfig,
	patterns: readonly string[],
	what: string
): Promise<RemoteTextFile[]> {
	const script = `for f in ${patterns.join(' ')}; do [ -f "$f" ] || continue; echo "${REMOTE_FILE_START} $f"; cat "$f"; echo; echo "${REMOTE_FILE_END}"; done`;
	const remoteOptions: RemoteCommandOptions = {
		command: 'sh',
		args: ['-c', script],
		env: sshRemote.remoteEnv,
	};

	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const sshCommand = await buildSshCommand(sshRemote, remoteOptions);
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${what} read timed out`)), SSH_MODEL_TIMEOUT_MS);
		});
		const result = await Promise.race([execSshCommand(sshRemote, sshCommand), timeout]);
		if (result.exitCode !== 0) {
			logger.warn(
				`Reading ${what} on ${sshRemote.host} exited with ${result.exitCode}`,
				LOG_CONTEXT,
				{
					stderr: result.stderr,
				}
			);
			return [];
		}

		const files: RemoteTextFile[] = [];
		for (const block of result.stdout.split(REMOTE_FILE_START).slice(1)) {
			const newline = block.indexOf('\n');
			if (newline < 0) continue;
			const endIdx = block.indexOf(REMOTE_FILE_END, newline);
			files.push({
				path: block.slice(0, newline).trim(),
				text: (endIdx >= 0 ? block.slice(newline + 1, endIdx) : block.slice(newline + 1)).trim(),
			});
		}
		return files;
	} catch (error) {
		logger.warn(`Failed to read ${what} on ${sshRemote.host}`, LOG_CONTEXT, { error });
		return [];
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Read OpenCode config files from a remote SSH host and extract model IDs.
 *
 * Probes the same config paths OpenCode uses on POSIX systems:
 *   ~/.opencode/opencode.json, ~/.opencode.json, ~/.config/opencode/opencode.json
 *
 * Returns unique model IDs in provider/model format.
 */
async function discoverModelsFromRemoteConfigs(sshRemote: SshRemoteConfig): Promise<string[]> {
	const files = await readRemoteTextFiles(
		sshRemote,
		[
			'~/.opencode/opencode.json',
			'~/.opencode.json',
			'${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json',
		],
		'remote OpenCode configs'
	);

	const seen = new Set<string>();
	const models: string[] = [];
	for (const { text } of files) {
		if (!text) continue;
		const config = parseOpenCodeConfig(text);
		if (!config) continue;
		for (const modelId of extractModelsFromConfig(config)) {
			if (!seen.has(modelId)) {
				seen.add(modelId);
				models.push(modelId);
			}
		}
	}

	if (models.length > 0) {
		logger.info(
			`Extracted ${models.length} models from remote OpenCode configs on ${sshRemote.host}`,
			LOG_CONTEXT,
			{ models }
		);
	}
	return models;
}

/**
 * Claude Code's models on an SSH remote.
 *
 * Claude Code has no `models` subcommand, so the generic `<binary> models`
 * probe can only fail (or worse, read `models` as a prompt). Local discovery
 * assembles the list from the aliases plus the catalog the CLI caches; this is
 * the same list for the remote, with the catalog read from the REMOTE's config
 * dir (`$CLAUDE_CONFIG_DIR`, else `~/.claude`) and parsed by the same rules.
 * The aliases alone are always a usable list, so an unreachable remote or a
 * missing cache still offers them.
 */
async function discoverClaudeModelsRemote(sshRemote: SshRemoteConfig): Promise<string[]> {
	const catalogDir = `"\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/${CLAUDE_CATALOG_SUBDIR.join('/')}`;
	const files = await readRemoteTextFiles(
		sshRemote,
		[`${catalogDir}/*.json`],
		'remote Claude model catalog'
	);
	const models = [...CLAUDE_MODEL_ALIASES];
	for (const id of claudeCatalogModelIds(
		files.map(({ path, text }) => ({ name: path.slice(path.lastIndexOf('/') + 1), text }))
	)) {
		if (!models.includes(id)) models.push(id);
	}
	return models;
}

/**
 * Discover available models for an agent on a remote SSH host.
 * Uses the agent's `models` subcommand over SSH, supplemented by models
 * from remote opencode.json config files for OpenCode agents.
 * Returns an empty array on timeout, non-zero exit, or unknown agent.
 * Throws on unexpected errors (e.g., SSH config issues, parsing bugs).
 */
export async function discoverModelsRemote(
	agentId: string,
	sshRemote: SshRemoteConfig,
	forceRefresh: boolean
): Promise<string[]> {
	const cacheKey = `${agentId}:${sshRemote.id}`;

	// Check cache unless force refresh
	if (!forceRefresh) {
		const cached = remoteModelCache.get(cacheKey);
		if (cached && Date.now() - cached.timestamp < REMOTE_MODEL_CACHE_TTL_MS) {
			logger.info(`Using cached remote models for ${agentId} on ${sshRemote.host}`, LOG_CONTEXT);
			return cached.models;
		}
	}

	if (agentId === 'claude-code') {
		const models = await discoverClaudeModelsRemote(sshRemote);
		logger.info(
			`Discovered ${models.length} models for Claude Code on remote ${sshRemote.host}`,
			LOG_CONTEXT
		);
		remoteModelCache.set(cacheKey, { models, timestamp: Date.now() });
		return models;
	}

	// Look up the agent's binary name
	const agentDef = AGENT_DEFINITIONS.find((a) => a.id === agentId);
	if (!agentDef) {
		logger.warn(`Unknown agent for remote model discovery: ${agentId}`, LOG_CONTEXT);
		return [];
	}

	const remoteOptions: RemoteCommandOptions = {
		command: agentDef.binaryName,
		args: agentId === 'omp' ? ['models', '--json'] : ['models'],
		env: sshRemote.remoteEnv,
	};

	try {
		const sshCommand = await buildSshCommand(sshRemote, remoteOptions);
		logger.info(
			`Discovering models for "${agentDef.name}" on remote ${sshRemote.host}`,
			LOG_CONTEXT
		);

		// Execute with timeout matching detectAgentsRemote pattern
		const resultPromise = execSshCommand(sshRemote, sshCommand);
		const timeoutPromise = new Promise<{ exitCode: number; stdout: string; stderr: string }>(
			(_, reject) => {
				setTimeout(
					() =>
						reject(
							new Error(`SSH model discovery timed out after ${SSH_MODEL_TIMEOUT_MS / 1000}s`)
						),
					SSH_MODEL_TIMEOUT_MS
				);
			}
		);

		const result = await Promise.race([resultPromise, timeoutPromise]);

		if (result.exitCode !== 0) {
			logger.warn(
				`Remote model discovery for "${agentDef.name}" exited with code ${result.exitCode}`,
				LOG_CONTEXT,
				{ stderr: result.stderr }
			);
			return [];
		}

		const seen = new Set<string>();
		const models: string[] = [];
		const sanitizedStdout = stripAnsi(result.stdout);

		if (agentId === 'omp') {
			// `omp models` prints a human table; the machine-readable form is
			// `omp models --json` -> { models: [{ selector, id, ... }] }. Use the
			// provider-qualified selector, mirroring the local discovery path so the
			// remote picker is not filled with table headings/box rows.
			try {
				const parsed = parseJsonWithBom<{ models?: Array<{ id?: string; selector?: string }> }>(
					sanitizedStdout
				);
				for (const entry of parsed.models ?? []) {
					const modelId = entry.selector || entry.id;
					if (modelId && !seen.has(modelId)) {
						seen.add(modelId);
						models.push(modelId);
					}
				}
			} catch (parseError) {
				logger.warn('Failed to parse remote omp models --json output', LOG_CONTEXT, {
					error: parseError,
				});
			}
		} else if (agentId === 'antigravity') {
			// `agy models` prints `<id>\t<label>` under a heading; take the base ids,
			// the same list the local picker shows (effort is its own axis).
			for (const modelId of parseAntigravityModelList(sanitizedStdout).models) {
				if (!seen.has(modelId)) {
					seen.add(modelId);
					models.push(modelId);
				}
			}
		} else {
			// Source 1: CLI-discovered models (one per line)
			const cliModels = sanitizedStdout
				.split('\n')
				.map((l) => l.trim())
				.filter((l) => l.length > 0);
			for (const m of cliModels) {
				if (!seen.has(m)) {
					seen.add(m);
					models.push(m);
				}
			}
		}

		// Source 2: Remote opencode.json config files (OpenCode only)
		if (agentId === 'opencode') {
			const configModels = await discoverModelsFromRemoteConfigs(sshRemote);
			for (const m of configModels) {
				if (!seen.has(m)) {
					seen.add(m);
					models.push(m);
				}
			}
		}

		logger.info(
			`Discovered ${models.length} models for "${agentDef.name}" on remote ${sshRemote.host}`,
			LOG_CONTEXT
		);

		// Cache the result
		remoteModelCache.set(cacheKey, { models, timestamp: Date.now() });

		return models;
	} catch (error) {
		// Timeout is an expected SSH failure - return empty gracefully
		if (error instanceof Error && error.message.includes('SSH model discovery timed out')) {
			logger.warn(
				`Timed out discovering models for "${agentDef.name}" on ${sshRemote.host}`,
				LOG_CONTEXT
			);
			return [];
		}
		// Unexpected errors should propagate to withIpcErrorLogging / Sentry
		throw error;
	}
}

type ModelsRefreshedBroadcaster = (channel: string, payload: ModelsRefreshedPayload) => void;
let broadcaster: ModelsRefreshedBroadcaster | undefined;

/**
 * Install the transport for the refreshed-models broadcast, normally the app's
 * `safeSend` (every window plus web-desktop clients). Before it is set, a
 * forced discovery still returns its list; nothing else hears about it.
 */
export function setModelsRefreshedBroadcaster(next: ModelsRefreshedBroadcaster | undefined): void {
	broadcaster = next;
}

export interface DiscoverAgentModelsDeps {
	getAgentDetector: () => AgentDetector | null;
	/** Resolve an SSH remote by id; undefined when it does not exist. */
	getSshRemote: (sshRemoteId: string) => SshRemoteConfig | undefined;
}

export interface DiscoverAgentModelsOptions {
	agentId: string;
	/** Bypass the cache and re-run discovery, then broadcast the result. */
	forceRefresh?: boolean;
	/** Discover on this SSH remote instead of this machine. */
	sshRemoteId?: string;
}

/**
 * Discover the models an agent offers. Throws when the SSH remote does not
 * exist or the agent detector is not ready, since an empty list there would
 * read as "this agent has no models" rather than as the failure it is.
 */
export async function discoverAgentModels(
	deps: DiscoverAgentModelsDeps,
	{ agentId, forceRefresh = false, sshRemoteId }: DiscoverAgentModelsOptions
): Promise<string[]> {
	logger.info(`Discovering models for agent: ${agentId}`, LOG_CONTEXT, {
		forceRefresh,
		sshRemoteId,
	});

	let models: string[];
	if (sshRemoteId) {
		const sshConfig = deps.getSshRemote(sshRemoteId);
		if (!sshConfig) {
			throw new Error(`SSH remote not found: ${sshRemoteId}`);
		}
		models = await discoverModelsRemote(agentId, sshConfig, forceRefresh);
	} else {
		const agentDetector = deps.getAgentDetector();
		if (!agentDetector) {
			throw new Error('Agent detector not available');
		}
		models = await agentDetector.discoverModels(agentId, forceRefresh);
	}

	if (forceRefresh && broadcaster) {
		try {
			broadcaster(MODELS_REFRESHED_CHANNEL, {
				agentId,
				sshRemoteId: sshRemoteId ?? null,
				models,
			});
		} catch (error) {
			// A window tearing down must not turn a good discovery into a failure.
			logger.debug('Failed to broadcast refreshed models', LOG_CONTEXT, { error: String(error) });
		}
	}
	return models;
}
