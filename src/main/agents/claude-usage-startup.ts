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
 *   pointing at the same directory only sample once. A session with no env
 *   var targets the implicit `~/.claude`, since that is the account it will
 *   really run against.
 *
 *   Directory is not identity, though: `/login` inside an existing dir
 *   repoints it, so several dirs can be ONE account. A second pass
 *   (`dedupeTargetsByAccount`) reads each dir's `.claude.json` and collapses
 *   those groups before spawning, recording the dropped keys as
 *   `aliasConfigDirKeys` on the surviving snapshot. One account, one spawn,
 *   one dashboard row.
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
import { readClaudeAccountIdentity } from './claude-account-identity';
import { accountIdentityFingerprint } from '../../shared/claudeAccountIdentity';
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
 * A session with no `CLAUDE_CONFIG_DIR` anywhere targets the implicit
 * `~/.claude`, because that is the account it will actually run against. This
 * used to return null instead, which is why the default account could never
 * produce a snapshot.
 *
 * Returns null when:
 *   - The session is SSH-remote (`sessionSshRemoteConfig.enabled`). Its
 *     `CLAUDE_CONFIG_DIR` points at the remote host; sampling it locally reads
 *     the wrong machine's account.
 *   - The session has no `cwd` (malformed record).
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

	// An agent with no CLAUDE_CONFIG_DIR still runs claude - against the
	// implicit `~/.claude`. Skipping it left the default account permanently
	// unsampled while `discoverClaudeConfigDirs()` still listed it, so the
	// dashboard showed a row stuck forever on "hit Refresh" with nothing that
	// could ever fill it. The original reason for the skip (a stale account
	// launching claude's OAuth browser on an unattended tick) no longer holds:
	// the sampler pins `BROWSER` to a no-op, so the consent flow opens nothing
	// and the spawn just times out. See `claude-usage-sampler.ts`.
	const configDir = customEnvVars.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
	const envForKey: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: configDir };
	const configDirKey = resolveConfigDirKey(envForKey);

	return {
		configDir,
		configDirKey,
		cwd,
		customEnvVars,
	};
}

/**
 * Collapse targets that turn out to be ONE Anthropic account.
 *
 * `CLAUDE_CONFIG_DIR` names a directory, but the plan quota is metered per
 * account, and re-running `/login` inside an existing dir silently repoints it
 * at a different account. Two dirs can therefore be the same account - the
 * common case being `~/.claude` and whichever named dir the user logged into
 * with the same email. Sampling both costs a second ~30s `maestro-p --status`
 * spawn per refresh tick to learn a number we already have.
 *
 * The identity comes from each dir's `.claude.json` (a cheap read next to a
 * multi-second spawn), so grouping happens BEFORE any sampling. Dirs whose
 * account can't be determined are never grouped - two unknowns are not
 * evidence of a match - so the failure mode is an extra sample, not a wrong
 * one. Group order follows the caller's target order, and the first target in
 * each group is the one sampled.
 */
async function dedupeTargetsByAccount(
	targets: SamplingTarget[]
): Promise<{ sampled: SamplingTarget[]; aliasesByKey: Record<string, string[]> }> {
	const identities = await Promise.all(
		targets.map((target) => readClaudeAccountIdentity(target.configDirKey))
	);

	const sampled: SamplingTarget[] = [];
	const aliasesByKey: Record<string, string[]> = {};
	const firstKeyByFingerprint = new Map<string, string>();

	targets.forEach((target, index) => {
		const fingerprint = accountIdentityFingerprint(identities[index]);
		const owner = fingerprint ? firstKeyByFingerprint.get(fingerprint) : undefined;
		if (owner) {
			aliasesByKey[owner].push(target.configDirKey);
			return;
		}
		if (fingerprint) {
			firstKeyByFingerprint.set(fingerprint, target.configDirKey);
		}
		aliasesByKey[target.configDirKey] = [];
		sampled.push(target);
	});

	return { sampled, aliasesByKey };
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

	// NB: neither mode sweeps the filesystem for ~/.claude-* account dirs. A
	// blind sweep would spawn `maestro-p --status` against every leftover /
	// stale account on disk and burn a 30s timeout on each, every refresh
	// tick. We sample what a configured agent references plus the implicit
	// default account an env-var-less agent actually runs on - see
	// buildTarget(). (discoverClaudeConfigDirs() still backs the account-key
	// listing IPC handler, which lists keys without spawning anything.)

	if (targetsByKey.size === 0) {
		logger.info('Skipping Claude usage sampling: no eligible accounts to sample', LOG_CONTEXT, {
			mode,
			totalSessions: storedSessions.length,
		});
		return;
	}

	// Collapse config dirs that are one Anthropic account before spawning
	// anything - adding the implicit `~/.claude` target above makes a
	// duplicate likely (it is commonly the same login as a named dir), and a
	// duplicate costs a full `--status` spawn to re-learn a number we already
	// have. The dropped keys ride along on the surviving snapshot as aliases
	// so the dashboard can still show every dir that maps to the account.
	const { sampled: targets, aliasesByKey } = await dedupeTargetsByAccount(
		Array.from(targetsByKey.values())
	);

	logger.info(`Sampling Claude usage for ${targets.length} account(s)`, LOG_CONTEXT, {
		accounts: targets.map((t) => t.configDirKey),
		collapsed: targetsByKey.size - targets.length,
	});

	// The real claude binary path: prefer the detector's resolved `path`
	// (matches the spawner's `agent.path || agent.command` convention), fall
	// back to the bare binary name when the detector didn't resolve a path
	// (in which case maestro-p will PATH-resolve internally).
	const claudeRealBinPath = claudeAgent.path || claudeAgent.command;

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

			// Config dirs collapsed into this one ride along on the snapshot,
			// so the dashboard can render a single row that names every dir
			// pointing at the account rather than a row per dir with no data
			// behind the ones we skipped.
			const aliases = aliasesByKey[target.configDirKey] ?? [];

			try {
				setSnapshot(aliases.length > 0 ? { ...snapshot, aliasConfigDirKeys: aliases } : snapshot);
				logger.info('Stored Claude usage snapshot', LOG_CONTEXT, {
					configDirKey: snapshot.configDirKey,
					aliasConfigDirKeys: aliases,
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
