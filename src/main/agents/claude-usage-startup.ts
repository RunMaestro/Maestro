/**
 * Claude Usage Startup Sampler
 *
 * Fires a one-shot `maestro-p --status` per unique CLAUDE_CONFIG_DIR account
 * referenced by any recent Claude Code session, and persists each result into
 * `claudeUsageStore`. Invoked from `src/main/index.ts` after settings/CLI
 * watchers come up, as fire-and-forget - the spawner can still fall through
 * with a null snapshot if sampling never completed, and the 5-min stale
 * refresh inside the spawner's mode-selection block tops the store back up
 * lazily when an `auto`-mode tab actually needs the data.
 *
 * Why "per CLAUDE_CONFIG_DIR account":
 *   The Claude plan quota is bucketed per Anthropic account, and Maestro users
 *   commonly switch accounts via `CLAUDE_CONFIG_DIR=/Users/foo/.claude-gmail`
 *   vs `.claude-smash`. Each canonical path is its own snapshot key. We
 *   resolve the effective env per session (agent-level customEnvVars merged
 *   with session-level customEnvVars; session wins, matching the spawner's
 *   runtime precedence), then `resolveConfigDirKey()`-dedup so two sessions
 *   pointing at the same account only sample once.
 *
 * Filter window:
 *   Only sessions younger than 7 days (`createdAt >= now - 7d`) are sampled.
 *   The intent is to skip stale tabs the user hasn't touched in a long
 *   time - sampling those would waste a 30s spawn budget per account that
 *   isn't actually being used in this run.
 *
 * Skip conditions (each logged at warn, then a clean return):
 *   - The claude-code agent isn't detected on this host.
 *   - No Claude Code sessions exist, or none are within the 7-day window.
 *
 * Binary path resolution mirrors the existing speckit-manager / cli pattern:
 *   - In dev, `dist/main/agents/claude-usage-startup.js` resolves
 *     `../cli/maestro-p.js` as a sibling under `dist/`.
 *   - In a packaged build, `process.resourcesPath/maestro-p.js` (added to
 *     `extraResources` in `package.json` for mac/win/linux).
 */

import * as fs from 'fs';
import os from 'os';
import path from 'path';
import Store from 'electron-store';

import type { AgentDetector } from './detector';
import type { AgentConfigsData, SessionsData } from '../stores/types';
import type { MaestroSettings } from '../ipc/handlers/persistence';
import { logger } from '../utils/logger';
import { isMaestroPBinaryPath } from './claudeSpawnCore';
import { sampleUsage } from './claude-usage-sampler';
import { resolveConfigDirKey, setSnapshot } from '../stores/claudeUsageStore';

const LOG_CONTEXT = '[ClaudeUsageStartup]';

/** Only consider Claude sessions touched within the last week. */
export const STARTUP_SESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Snapshots older than this are refreshed inline by the spawner before
 * running the mode selector. Re-exported so the spawner imports one constant
 * instead of hardcoding 5 minutes in two places.
 */
export const USAGE_SNAPSHOT_STALE_MS = 5 * 60 * 1000;

export interface StartupUsageSamplingDeps {
	// Read-only slice of the sessions store: the sampler only enumerates stored
	// sessions, never writes. Typing it as `Pick<Store<SessionsData>, 'get'>`
	// (rather than a looser `Store<{ sessions: any[] }>`) lets the real store
	// instance assign without an `as unknown as` cast at the call site.
	sessionsStore: Pick<Store<SessionsData>, 'get'>;
	agentConfigsStore: Store<AgentConfigsData>;
	settingsStore: Store<MaestroSettings>;
	agentDetector: AgentDetector;
	/** Override for tests; defaults to `Date.now()`. */
	now?: () => number;
	/**
	 * 'startup' (default): strict filter - only sample for sessions that will
	 * spawn through maestro-p (Adaptive Mode toggle on, or maestro-p set as the
	 * session-level / agent-level Path) AND were created within the 7-day
	 * window. Keeps boot snappy - non-maestro-p users don't pay a 30s
	 * `--status` spawn per account on every launch.
	 *
	 * 'manual': aggressive - sample every unique CLAUDE_CONFIG_DIR referenced
	 * by ANY Claude Code session, ignoring the maestro-p filter and the 7-day
	 * window. Falls back to the default ~/.claude account when no Claude Code
	 * sessions exist. Used by the Usage Dashboard Refresh button: the user
	 * just asked for fresh data, give it to them regardless of how their
	 * sessions are wired.
	 */
	mode?: 'startup' | 'manual';
}

interface SamplingTarget {
	configDir: string;
	configDirKey: string;
	cwd: string;
	customEnvVars: Record<string, string>;
}

const ACCOUNT_DIR_EXCLUDE_RE =
	/(^|[-_.])(backup|bak|old|archive|archived|stage|local|server)([-_.]|$)/i;

function isLikelyClaudeAccountDirName(name: string): boolean {
	return name === '.claude' || name.startsWith('.claude-');
}

/**
 * Discover local Claude Code account directories, mirroring the common
 * `/token-cockpit` setup where each account lives in a separate
 * `~/.claude-*` directory. Backups and local/server scratch dirs are skipped
 * so the dashboard lists active accounts, not migration leftovers.
 */
export async function discoverClaudeConfigDirs(homeDir = os.homedir()): Promise<string[]> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(homeDir, { withFileTypes: true });
	} catch (err) {
		logger.warn('Failed to discover Claude config dirs', LOG_CONTEXT, {
			homeDir,
			error: err instanceof Error ? err.message : String(err),
		});
		return [];
	}

	const dirs: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (!isLikelyClaudeAccountDirName(entry.name)) continue;
		if (ACCOUNT_DIR_EXCLUDE_RE.test(entry.name)) continue;

		const dir = path.join(homeDir, entry.name);
		try {
			await fs.promises.access(path.join(dir, '.claude.json'), fs.constants.R_OK);
		} catch {
			continue;
		}
		dirs.push(dir);
	}

	return dirs.sort((a, b) => a.localeCompare(b));
}

/**
 * Locate the bundled `maestro-p.js` script. Returns null when no candidate
 * exists - callers treat this the same as "claude agent missing" and skip
 * sampling cleanly.
 *
 * Candidate order matches the dev / packaged split:
 *   1. `process.resourcesPath/maestro-p.js` (packaged build extraResources).
 *   2. `dist/cli/maestro-p.js` as a sibling under the running JS path (dev
 *      mode runs from `dist/main/agents/claude-usage-startup.js`).
 *   3. `<cwd>/dist/cli/maestro-p.js` as a last resort for unusual setups
 *      (electron-forge dev shells, packaged tests).
 */
export function getMaestroPBinPath(): string | null {
	const candidates: string[] = [];

	// Packaged build: extraResources lands maestro-p.js at the app resources root.
	// `process.resourcesPath` is empty/undefined when run outside Electron (tests
	// invoking this module directly), so guard before using it.
	if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
		candidates.push(path.join(process.resourcesPath, 'maestro-p.js'));
	}

	// Dev: dist/main/agents/claude-usage-startup.js → ../cli/maestro-p.js
	candidates.push(path.resolve(__dirname, '..', 'cli', 'maestro-p.js'));

	// Fallback for unusual setups: cwd-relative.
	candidates.push(path.resolve(process.cwd(), 'dist', 'cli', 'maestro-p.js'));

	for (const candidate of candidates) {
		try {
			fs.accessSync(candidate, fs.constants.R_OK);
			logger.debug('Resolved bundled maestro-p.js', LOG_CONTEXT, { path: candidate });
			return candidate;
		} catch {
			continue;
		}
	}

	logger.warn('No bundled maestro-p.js candidate was readable', LOG_CONTEXT, { candidates });
	return null;
}

// Canonical `isMaestroPBinaryPath` now lives in the bundle-safe spawn core so
// the desktop and the CLI share one basename check. Re-exported here (it is
// imported at the top) so this module's existing importers keep resolving it
// from the same place.
export { isMaestroPBinaryPath };

/**
 * Read the agent-level customEnvVars for `claude-code` from the agent configs
 * store, defaulting to an empty record when nothing has been configured.
 */
function getAgentLevelEnvVars(agentConfigsStore: Store<AgentConfigsData>): Record<string, string> {
	const configs = agentConfigsStore.get('configs', {});
	const agentConfig = configs['claude-code'];
	const envVars = agentConfig?.customEnvVars;
	if (envVars && typeof envVars === 'object') {
		return envVars as Record<string, string>;
	}
	return {};
}

/**
 * Read the agent-level customPath for `claude-code` (the agent's `Path` field).
 * Returns null when nothing's been configured. Used to detect the "static
 * maestro-p Path" case where the spawner runs through the TUI wrapper even
 * though Adaptive Mode is off.
 */
function getAgentLevelCustomPath(agentConfigsStore: Store<AgentConfigsData>): string | null {
	const configs = agentConfigsStore.get('configs', {});
	const customPath = configs['claude-code']?.customPath;
	return typeof customPath === 'string' && customPath.length > 0 ? customPath : null;
}

/**
 * Build the per-session sampling target: merge agent-level + session-level
 * customEnvVars (session wins, matching the spawner's runtime precedence),
 * extract `CLAUDE_CONFIG_DIR`, canonicalize, and produce the call shape
 * `sampleUsage()` expects.
 *
 * Returns null when:
 *   - The session is SSH-remote (`sessionSshRemoteConfig.enabled`). Its
 *     `CLAUDE_CONFIG_DIR` points at the remote host; sampling it locally is
 *     meaningless and can pop an OAuth browser against a tokenless local dir.
 *   - The session has no `cwd` (malformed record).
 *   - Neither the session nor the agent explicitly sets `CLAUDE_CONFIG_DIR`
 *     in customEnvVars. We refuse to sample "default" accounts the user
 *     hasn't explicitly configured: the user may have multiple Anthropic
 *     accounts on this host, and the default `~/.claude` may not match
 *     wherever claude's tokens actually live in the Keychain - so a
 *     "guess the default" sample would trigger an OAuth browser prompt.
 *     Better to skip than to pop a browser the user didn't ask for.
 */
function buildTarget(
	session: Record<string, unknown>,
	agentLevelEnvVars: Record<string, string>
): SamplingTarget | null {
	const sessionEnvVars =
		session.customEnvVars && typeof session.customEnvVars === 'object'
			? (session.customEnvVars as Record<string, string>)
			: {};
	const customEnvVars: Record<string, string> = { ...agentLevelEnvVars, ...sessionEnvVars };

	// SSH-remote agents run claude on the remote host, so their CLAUDE_CONFIG_DIR
	// names a directory on THAT machine. Sampling it locally reads the wrong
	// host's account, and if the local path happens to exist but has no Keychain
	// token (a pristine ~/.claude-* dir), `maestro-p --status` pops an OAuth
	// browser the user never asked for. The remote agent's real turns authenticate
	// remotely; there is nothing useful to sample locally. Skip.
	const sshRemoteConfig = session.sessionSshRemoteConfig as { enabled?: boolean } | undefined;
	if (sshRemoteConfig?.enabled) {
		return null;
	}

	const cwd =
		typeof session.cwd === 'string' && session.cwd.length > 0
			? session.cwd
			: typeof session.projectRoot === 'string' && session.projectRoot.length > 0
				? session.projectRoot
				: null;
	if (!cwd) {
		return null;
	}

	// Hard requirement: sample only explicitly-configured accounts. If the
	// user didn't set CLAUDE_CONFIG_DIR anywhere, we don't guess - the
	// spawn would inherit the default `~/.claude`, which may have stale
	// `.claude.json` metadata pointing at an account whose Keychain tokens
	// no longer exist, and that combination triggers a browser OAuth flow.
	const explicitConfigDir = customEnvVars.CLAUDE_CONFIG_DIR;
	if (!explicitConfigDir) {
		return null;
	}
	const envForKey: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: explicitConfigDir };
	const configDirKey = resolveConfigDirKey(envForKey);

	return {
		configDir: explicitConfigDir,
		configDirKey,
		cwd,
		customEnvVars,
	};
}

/**
 * Sample `maestro-p --status` for every unique CLAUDE_CONFIG_DIR account
 * referenced by an eligible Claude Code session, and write each result to
 * `claudeUsageStore`. Resolves when every parallel sample has settled.
 *
 * Eligibility depends on `deps.mode`:
 *   - 'startup' (default): only sessions that will spawn through maestro-p
 *     AND were created within the 7-day window. Keeps boot fast.
 *   - 'manual': every Claude Code session, ignoring the maestro-p filter and
 *     7-day window. Still scoped to accounts a configured agent explicitly
 *     references (session- or agent-level CLAUDE_CONFIG_DIR) - we never
 *     discover unconfigured ~/.claude-* dirs on disk, since sampling a stale
 *     leftover account would pop an OAuth browser the user never asked for.
 *
 * Never throws - every failure surfaces as a warn log and a skipped entry.
 */
export async function runStartupUsageSampling(deps: StartupUsageSamplingDeps): Promise<void> {
	const now = (deps.now ?? Date.now)();
	const mode = deps.mode ?? 'startup';

	const claudeAgent = await deps.agentDetector.getAgent('claude-code');
	if (!claudeAgent) {
		logger.warn('Skipping Claude usage sampling: claude-code agent not detected', LOG_CONTEXT, {
			mode,
		});
		return;
	}

	const storedSessions = deps.sessionsStore.get('sessions', []) as Array<Record<string, unknown>>;
	const agentLevelCustomPath = getAgentLevelCustomPath(deps.agentConfigsStore);
	const agentLevelIsMaestroP = isMaestroPBinaryPath(agentLevelCustomPath);
	const eligibleClaudeSessions = storedSessions.filter((s) => {
		if (s?.toolType !== 'claude-code') return false;
		if (mode === 'manual') return true;
		// startup: sample only for sessions that will spawn through maestro-p
		// (Adaptive Mode toggle, or maestro-p as the session/agent-level Path),
		// and only when fresh enough to be worth a 30s `--status` spawn on boot.
		const sessionPath = typeof s?.customPath === 'string' ? s.customPath : null;
		const usesMaestroP =
			s?.enableMaestroP === true ||
			isMaestroPBinaryPath(sessionPath) ||
			(sessionPath === null && agentLevelIsMaestroP);
		if (!usesMaestroP) return false;
		const createdAt = typeof s.createdAt === 'number' ? s.createdAt : null;
		if (createdAt === null) return false;
		return createdAt >= now - STARTUP_SESSION_WINDOW_MS;
	});

	const binPath = getMaestroPBinPath();
	if (!binPath) {
		logger.warn('Skipping Claude usage sampling: bundled maestro-p.js not found', LOG_CONTEXT, {
			mode,
		});
		return;
	}

	const agentLevelEnvVars = getAgentLevelEnvVars(deps.agentConfigsStore);

	// Dedup by canonical configDirKey so two sessions pointing at the same
	// Anthropic account only sample once. First session wins on cwd / env
	// shape - the snapshot is a per-account quota, not per-session.
	const targetsByKey = new Map<string, SamplingTarget>();
	for (const session of eligibleClaudeSessions) {
		const target = buildTarget(session, agentLevelEnvVars);
		if (!target) continue;
		if (!targetsByKey.has(target.configDirKey)) {
			targetsByKey.set(target.configDirKey, target);
		}
	}

	// NB: manual mode does NOT sweep the filesystem for ~/.claude-* account
	// dirs. A blind sweep would spawn `maestro-p --status` against every
	// leftover/stale account on disk, and any whose Keychain tokens have
	// expired launch the Claude TUI's OAuth browser flow on each refresh tick.
	// We sample only what a configured agent explicitly references, exactly
	// like the startup path - see buildTarget()'s "don't guess the account"
	// guard. (discoverClaudeConfigDirs() still backs the account-key listing
	// IPC handler, which lists keys without spawning anything.)

	if (targetsByKey.size === 0) {
		logger.info('Skipping Claude usage sampling: no eligible accounts to sample', LOG_CONTEXT, {
			mode,
			totalSessions: storedSessions.length,
		});
		return;
	}

	logger.info(`Sampling Claude usage for ${targetsByKey.size} account(s)`, LOG_CONTEXT, {
		accounts: Array.from(targetsByKey.keys()),
	});

	// The real claude binary path: prefer the detector's resolved `path`
	// (matches the spawner's `agent.path || agent.command` convention), fall
	// back to the bare binary name when the detector didn't resolve a path
	// (in which case maestro-p will PATH-resolve internally).
	const claudeRealBinPath = claudeAgent.path || claudeAgent.command;

	const targets = Array.from(targetsByKey.values());
	await Promise.all(
		targets.map(async (target) => {
			// Compose the env passed to sampleUsage:
			//   - Inherit the target's effective customEnvVars so callers (e.g.
			//     `ANTHROPIC_API_KEY`) reach the claude TUI as configured.
			//   - Override MAESTRO_CLAUDE_BIN with the resolved real-claude path
			//     when available, so the agent doesn't depend on PATH inside
			//     the sampler's spawn (which inherits process.env via the
			//     sampler's own composition).
			const sampleEnv: Record<string, string> = { ...target.customEnvVars };
			if (claudeRealBinPath) {
				sampleEnv.MAESTRO_CLAUDE_BIN = claudeRealBinPath;
			}

			const snapshot = await sampleUsage({
				binPath,
				configDir: target.configDir,
				cwd: target.cwd,
				customEnvVars: sampleEnv,
			});

			if (!snapshot) {
				logger.warn('maestro-p --status sample failed; skipping account', LOG_CONTEXT, {
					configDirKey: target.configDirKey,
				});
				return;
			}

			try {
				setSnapshot(snapshot);
				logger.info('Stored Claude usage snapshot', LOG_CONTEXT, {
					configDirKey: snapshot.configDirKey,
					sessionPercent: snapshot.session.percent,
					weekAllPercent: snapshot.weekAllModels.percent,
				});
			} catch (err) {
				logger.warn('Failed to persist Claude usage snapshot', LOG_CONTEXT, {
					configDirKey: target.configDirKey,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		})
	);
}
