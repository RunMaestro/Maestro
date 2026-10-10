/**
 * Provider Account Directories
 *
 * Answers one question for any provider that keeps its account in a config
 * directory: which account dirs exist on this machine, deduped to the distinct
 * transcript pools behind them.
 *
 * The account-selecting env var per provider (`CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME`, `COPILOT_HOME`) lives in `PROVIDER_PROFILE_CONFIGS`, so this
 * module is provider-agnostic: a provider gains multi-account attribution by
 * gaining an entry there, not by gaining a discovery function here.
 *
 * Four sources, in order:
 *   1. Every live agent's effective env. Authoritative - it is literally the
 *      value the spawned process receives - and the only source that can find
 *      an account dir outside `$HOME`.
 *   2. Maestro's own `process.env`, for a user who exports the var in a shell
 *      profile.
 *   3. `~/<defaultSubdir>`, the implicit default account.
 *   4. A sibling scan of `$HOME` for `<defaultSubdir>` and `<defaultSubdir>-*`.
 *      The only source that still finds an account whose agents have all been
 *      deleted.
 *
 * Sources 1, 2 and 4 are each sorted before being appended, so the output order
 * (and therefore which dir wins a dedupe) is stable across runs.
 */

import os from 'os';
import path from 'path';
import fsp from 'fs/promises';

import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { isInitialized } from '../stores/instances';
import { getAgentConfigsStore, getSessionsStore } from '../stores/getters';
import { isBlankEnvValue } from '../../shared/agentEnvironment';
import {
	effectiveAgentCustomEnvVars,
	getProviderProfileConfig,
	isAccountDirName,
	type ProviderProfileConfig,
} from '../../shared/providerProfiles';

const LOG_CONTEXT = '[ProviderAccountDirs]';

/** Filesystem errors that mean "not an account dir", not "something is wrong". */
const RECOVERABLE_FS_ERROR_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ELOOP']);

function errorCode(err: unknown): string | undefined {
	if (!err || typeof err !== 'object' || !('code' in err)) return undefined;
	const code = (err as { code?: unknown }).code;
	return typeof code === 'string' ? code : undefined;
}

function isRecoverableFsError(err: unknown): boolean {
	const code = errorCode(err);
	return code !== undefined && RECOVERABLE_FS_ERROR_CODES.has(code);
}

export interface ProviderAccountDirsOptions {
	/** Defaults to `os.homedir()`. */
	homeDir?: string;
	/** Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Stored agents. Defaults to the sessions store, or none when stores are cold. */
	sessions?: Array<Record<string, unknown>>;
	/** Provider-level `customEnvVars`. Defaults to the agent configs store. */
	agentLevelEnvVars?: Record<string, string>;
}

/** Stored agents, or an empty list before `initializeStores()` has run. */
function readStoredSessions(): Array<Record<string, unknown>> {
	if (!isInitialized()) return [];
	return getSessionsStore().get('sessions', []) as Array<Record<string, unknown>>;
}

/** Provider-level `customEnvVars`, or none before `initializeStores()` has run. */
function readAgentLevelEnvVars(toolType: string): Record<string, string> {
	if (!isInitialized()) return {};
	const configs = getAgentConfigsStore().get('configs', {});
	const envVars = configs[toolType]?.customEnvVars;
	return envVars && typeof envVars === 'object' ? (envVars as Record<string, string>) : {};
}

/**
 * Account dirs named by a configured agent of this provider.
 *
 * SSH-remote agents are skipped: their env var names a directory on the REMOTE
 * host, so resolving it locally either misses or, worse, hits an unrelated
 * local directory that happens to share the name.
 */
function collectConfiguredAccountDirs(
	toolType: string,
	config: ProviderProfileConfig,
	options: ProviderAccountDirsOptions
): string[] {
	const agentLevelEnvVars = options.agentLevelEnvVars ?? readAgentLevelEnvVars(toolType);
	const sessions = options.sessions ?? readStoredSessions();
	const dirs = new Set<string>();

	const add = (value: unknown): void => {
		if (typeof value !== 'string' || isBlankEnvValue(value)) return;
		dirs.add(value.trim());
	};

	for (const session of sessions) {
		if (session?.toolType !== toolType) continue;
		const sshConfig = session.sessionSshRemoteConfig as { enabled?: boolean } | undefined;
		if (sshConfig?.enabled) continue;
		const sessionEnvVars =
			session.customEnvVars && typeof session.customEnvVars === 'object'
				? (session.customEnvVars as Record<string, string>)
				: undefined;
		add(effectiveAgentCustomEnvVars(sessionEnvVars, agentLevelEnvVars)[config.envVar]);
	}

	// The provider-level value counts even when no agent inherits it: the
	// transcripts under it are still this machine's spend.
	add(agentLevelEnvVars[config.envVar]);

	return Array.from(dirs).sort((a, b) => a.localeCompare(b));
}

/**
 * `$HOME` entries that look like an account dir for this provider AND hold its
 * sessions subtree. The subtree requirement is what keeps an unrelated
 * `.codex-notes` folder from being reported as an account.
 */
async function scanHomeForAccountDirs(
	config: ProviderProfileConfig,
	homeDir: string
): Promise<string[]> {
	let entries;
	try {
		entries = await fsp.readdir(homeDir, { withFileTypes: true });
	} catch (err) {
		if (!isRecoverableFsError(err)) throw err;
		logger.warn('Failed to scan $HOME for provider account dirs', LOG_CONTEXT, {
			homeDir,
			error: err instanceof Error ? err.message : String(err),
		});
		return [];
	}

	const dirs: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (!isAccountDirName(entry.name, config.defaultSubdir)) continue;
		const dir = path.join(homeDir, entry.name);
		try {
			const stat = await fsp.stat(path.join(dir, config.sessionsSubdir));
			if (!stat.isDirectory()) continue;
		} catch (err) {
			if (!isRecoverableFsError(err)) throw err;
			continue;
		}
		dirs.push(dir);
	}
	return dirs.sort((a, b) => a.localeCompare(b));
}

/**
 * The account dirs to read for a provider, deduped by the REAL path of their
 * sessions subtree.
 *
 * Returns `[]` for a provider with no account concept, which callers read as
 * "one pass against the default root".
 *
 * The dedupe is load-bearing, not defensive. A common multi-account setup
 * symlinks `~/.claude-<name>/projects` back at `~/.claude/projects` so every
 * account shares one transcript pool (only the credentials differ). Reading
 * each config dir blindly would then count the same sessions once per account
 * and multiply the reported tokens. Collapsing on the resolved target means a
 * shared pool is read exactly once; genuinely separate accounts still each get
 * read. First writer wins, and every source is sorted, so a shared pool is
 * attributed to the same dir on every run.
 */
export async function getProviderAccountDirs(
	toolType: string,
	options: ProviderAccountDirsOptions = {}
): Promise<string[]> {
	const config = getProviderProfileConfig(toolType);
	if (!config) return [];

	const homeDir = options.homeDir ?? os.homedir();
	const env = options.env ?? process.env;

	const candidates = collectConfiguredAccountDirs(toolType, config, options);
	const fromProcessEnv = env[config.envVar];
	if (typeof fromProcessEnv === 'string' && !isBlankEnvValue(fromProcessEnv)) {
		candidates.push(fromProcessEnv.trim());
	}
	candidates.push(path.join(homeDir, config.defaultSubdir));
	candidates.push(...(await scanHomeForAccountDirs(config, homeDir)));

	const byRealSessionsDir = new Map<string, string>();
	for (const candidate of candidates) {
		const resolved = path.resolve(candidate);
		let realSessionsDir: string;
		try {
			realSessionsDir = await fsp.realpath(path.join(resolved, config.sessionsSubdir));
		} catch (err) {
			if (!isRecoverableFsError(err)) {
				void captureException(err, {
					operation: 'providerAccountDirs:realpath',
					toolType,
					accountDir: resolved,
				});
				continue;
			}
			// No sessions subtree yet (a fresh account): key on the dir itself so
			// it still appears rather than silently collapsing into another one.
			realSessionsDir = resolved;
		}
		if (!byRealSessionsDir.has(realSessionsDir)) {
			byRealSessionsDir.set(realSessionsDir, resolved);
		}
	}
	return Array.from(byRealSessionsDir.values());
}
