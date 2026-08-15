/**
 * Provider Auth Startup Pass
 *
 * Fires one status probe per unique credential identity referenced by any
 * eligible stored session, and persists each result into `providerAuthStore`.
 * Invoked from `src/main/index.ts` alongside `runStartupUsageSampling` as
 * fire-and-forget: a failure here costs a badge, not a boot.
 *
 * **One probe per unique identity key, never one per session.** That is the
 * entire point of the phase. Fifteen agents on one Anthropic account resolve to
 * one `CredentialIdentity.key` and therefore produce exactly one
 * `claude auth status` spawn, in the same way `claude-usage-startup.ts` already
 * collapses fifteen sessions onto one `maestro-p --status` per
 * `CLAUDE_CONFIG_DIR`.
 *
 * Modes:
 *   - `'startup'` (default): skip identities whose stored snapshot is younger
 *     than `PROBE_STALE_MS`, skip sessions nobody has touched in a week, and
 *     skip SSH-remote sessions entirely (see below). Keeps boot cheap.
 *   - `'manual'`: ignore both filters and re-probe everything, including
 *     SSH-remote sessions. This is what a user-triggered refresh calls - they
 *     asked for fresh data and are present to wait for it.
 *
 * Why SSH is startup-excluded but manual-included:
 *   A remote probe opens an SSH connection, and an unreachable host burns the
 *   full probe timeout. A dozen of those at launch is a dozen connection
 *   attempts nobody asked for, so `'startup'` stays local-only. A manual refresh
 *   is an explicit request, so it pays that cost.
 *
 * Why the local install check does not gate remote sessions:
 *   `agentDetector` answers "is this binary on THIS machine". An SSH agent runs
 *   the provider on the remote host, and `wrapSpawnWithSsh` invokes it by bare
 *   binary name there, so a provider missing locally says nothing about whether
 *   the remote probe can run.
 *
 * Never throws. Every failure is a warn log and a skipped identity.
 */

import * as os from 'os';
import Store from 'electron-store';

import type { CredentialIdentity } from '../../../shared/providerAuth';
import { mergeEffectiveEnv, resolveCredentialIdentity } from '../../../shared/providerAuth';
import type { AgentSshRemoteConfig } from '../../../shared/types';
import type { AgentConfigsData, MaestroSettings, SessionsData } from '../../stores/types';
import { getSnapshot, isSnapshotFresh, setSnapshot } from '../../stores/providerAuthStore';
import { mapWithConcurrency } from '../../utils/concurrency';
import { logger } from '../../utils/logger';
import { createSshRemoteStoreAdapter } from '../../utils/ssh-remote-resolver';
import { getAgentDefinition } from '../definitions';
import type { AgentDetector } from '../detector';
import { probeCredential } from './auth-probe';

const LOG_CONTEXT = '[AuthStartup]';

/**
 * Only sessions touched within the last week are probed in `'startup'` mode.
 * Same window and same reasoning as `STARTUP_SESSION_WINDOW_MS` in
 * `claude-usage-startup.ts`: an agent nobody has opened in a week should not
 * cost a spawn on every launch.
 */
export const AUTH_STARTUP_SESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many probes may be in flight at once. Deliberately small: a user with a
 * dozen accounts should not fork a dozen processes (or open a dozen SSH
 * connections) at launch. Well under the concurrency cap
 * `REMOTE_SESSION_READ_CONCURRENCY` uses for the same SSH reason.
 */
export const PROBE_CONCURRENCY = 4;

export interface StartupAuthProbeDeps {
	/**
	 * Read-only slice of the sessions store. Typed as a `Pick` (rather than a
	 * looser shape) so the real store assigns without a cast at the call site,
	 * matching `StartupUsageSamplingDeps`.
	 */
	sessionsStore: Pick<Store<SessionsData>, 'get'>;
	agentConfigsStore: Pick<Store<AgentConfigsData>, 'get'>;
	settingsStore: Pick<Store<MaestroSettings>, 'get'>;
	agentDetector: AgentDetector;
	/** Override for tests; defaults to `Date.now()`. */
	now?: () => number;
	/** See the mode notes in the module docblock. Defaults to `'startup'`. */
	mode?: 'startup' | 'manual';
	/**
	 * Restrict the pass to these identity keys. Omit to probe every identity.
	 *
	 * This is how "re-probe just this one credential" is expressed: env
	 * resolution and dedup stay here rather than being re-derived by the caller,
	 * which is the only place they are known to be correct. A key no session
	 * references any more matches nothing and simply probes nothing.
	 */
	onlyKeys?: string[];
}

/** Counts emitted in the single summary log line. */
export interface StartupAuthProbeResult {
	/** Unique identities considered after dedup. */
	identities: number;
	/** Identities actually probed (i.e. `probeCredential` was called). */
	probed: number;
	/** Identities skipped because a fresh snapshot already answered. */
	skippedFresh: number;
	/** Identities skipped because the provider is not installed on this host. */
	skippedNotInstalled: number;
	/** Resulting snapshot count by status. */
	byStatus: Record<string, number>;
}

/** One unique credential identity plus everything needed to probe it. */
interface ProbeTarget {
	identity: CredentialIdentity;
	env: Record<string, string>;
	cwd: string;
	sshRemoteConfig?: AgentSshRemoteConfig;
}

/**
 * Agent-level `customEnvVars` for one provider, which session-level vars merge
 * over. Same lookup as `getAgentLevelEnvVars` in `claude-usage-startup.ts`,
 * generalized off the hardcoded `claude-code` key since this pass spans every
 * provider.
 */
function getAgentLevelEnvVars(
	agentConfigsStore: Pick<Store<AgentConfigsData>, 'get'>,
	provider: string
): Record<string, string> {
	const envVars = agentConfigsStore.get('configs', {})[provider]?.customEnvVars;
	if (envVars && typeof envVars === 'object') {
		return envVars as Record<string, string>;
	}
	return {};
}

/**
 * When a session was last touched, for the `'startup'` recency window.
 *
 * `createdAt` alone (what the usage sampler uses) reads a daily-driver agent
 * created three months ago as stale forever. Opening an AI tab is the closest
 * activity signal a stored session carries, so the newest of the two wins.
 */
function sessionTouchedAt(session: Record<string, unknown>): number | null {
	let latest = typeof session.createdAt === 'number' ? session.createdAt : null;
	const tabs = Array.isArray(session.aiTabs) ? session.aiTabs : [];
	for (const tab of tabs) {
		const createdAt = (tab as Record<string, unknown> | null)?.createdAt;
		if (typeof createdAt === 'number' && (latest === null || createdAt > latest)) {
			latest = createdAt;
		}
	}
	return latest;
}

/**
 * Build the probe target for one stored session, or null when the session
 * cannot contribute one (no tool type, or an SSH agent in `'startup'` mode).
 */
function buildTarget(
	session: Record<string, unknown>,
	agentLevelEnvVars: Record<string, string>,
	mode: 'startup' | 'manual',
	homeDir: string
): ProbeTarget | null {
	const toolType = typeof session.toolType === 'string' ? session.toolType : '';
	if (toolType === '') {
		return null;
	}

	const sshRemoteConfig = session.sessionSshRemoteConfig as AgentSshRemoteConfig | undefined;
	const sshEnabled = sshRemoteConfig?.enabled === true;
	const sshRemoteId =
		typeof sshRemoteConfig?.remoteId === 'string' && sshRemoteConfig.remoteId !== ''
			? sshRemoteConfig.remoteId
			: null;
	// Enabled but naming no remote is unresolvable. It must NOT quietly become a
	// local identity: the user opted this agent into SSH, so a local probe would
	// read a different machine's credentials and file them under this session.
	// Same rule as `sshUnresolvedFailure()` in the CLI spawner - fail closed.
	if (sshEnabled && sshRemoteId === null) {
		return null;
	}
	const usesSsh = sshEnabled && sshRemoteId !== null;
	if (usesSsh && mode === 'startup') {
		return null;
	}

	const sessionEnvVars =
		session.customEnvVars && typeof session.customEnvVars === 'object'
			? (session.customEnvVars as Record<string, string>)
			: undefined;
	const env = mergeEffectiveEnv(agentLevelEnvVars, sessionEnvVars);

	// The remote host's home directory is not something Maestro knows, so a
	// remote identity that falls back to a DEFAULT config dir is scoped by the
	// local default path. That is cosmetic: the probe passes no config-dir
	// override, so the remote CLI reads its own real default, and the key stays
	// stable and unique per host because `host` is `ssh:${remoteId}`. An
	// explicitly configured remote config dir is an absolute path and needs no
	// home at all.
	const identity = resolveCredentialIdentity({
		toolType,
		env,
		homeDir,
		...(usesSsh && sshRemoteId !== null ? { sshRemoteId } : {}),
	});

	const cwd =
		typeof session.cwd === 'string' && session.cwd !== ''
			? session.cwd
			: typeof session.projectRoot === 'string' && session.projectRoot !== ''
				? session.projectRoot
				: homeDir;

	return {
		identity,
		env,
		// A remote cwd is a path on the remote host and a local one is local;
		// either way the status commands do not care where they run, so this only
		// has to be a directory that exists on the machine running the probe.
		cwd: usesSsh ? cwd : homeDir,
		...(usesSsh ? { sshRemoteConfig } : {}),
	};
}

/**
 * Resolve the provider binary path once per provider, memoized. Returns null
 * when the agent is not installed on this host, which is the caller's cue to
 * skip every LOCAL identity for that provider.
 */
function createBinaryPathResolver(
	agentDetector: AgentDetector
): (provider: string) => Promise<string | null> {
	const cache = new Map<string, Promise<string | null>>();
	return (provider: string) => {
		const cached = cache.get(provider);
		if (cached) {
			return cached;
		}
		const pending = agentDetector
			.getAgent(provider)
			.then((agent) => {
				if (!agent) {
					return null;
				}
				// Same `path || command` convention the spawner uses: prefer the
				// resolved absolute path, fall back to the bare binary name so PATH
				// resolution can still find it.
				return agent.path || agent.command || null;
			})
			.catch((error) => {
				logger.warn('Agent detection failed while resolving a probe binary', LOG_CONTEXT, {
					provider,
					error: error instanceof Error ? error.message : String(error),
				});
				return null;
			});
		cache.set(provider, pending);
		return pending;
	};
}

/**
 * Probe every unique credential identity referenced by an eligible session and
 * store the results.
 *
 * Never throws - the caller treats this as fire-and-forget.
 */
export async function runStartupAuthProbe(
	deps: StartupAuthProbeDeps
): Promise<StartupAuthProbeResult> {
	const result: StartupAuthProbeResult = {
		identities: 0,
		probed: 0,
		skippedFresh: 0,
		skippedNotInstalled: 0,
		byStatus: {},
	};

	try {
		const now = (deps.now ?? Date.now)();
		const mode = deps.mode ?? 'startup';
		const homeDir = os.homedir();

		const storedSessions = deps.sessionsStore.get('sessions', []) as Array<Record<string, unknown>>;

		// Dedup by identity key. First session wins on env / cwd shape: the
		// snapshot describes a credential, not a session, so any session that
		// presents this credential produces the same probe.
		const targetsByKey = new Map<string, ProbeTarget>();
		const agentEnvCache = new Map<string, Record<string, string>>();
		for (const session of storedSessions) {
			if (mode === 'startup') {
				const touchedAt = sessionTouchedAt(session);
				if (touchedAt === null || touchedAt < now - AUTH_STARTUP_SESSION_WINDOW_MS) {
					continue;
				}
			}
			const toolType = typeof session.toolType === 'string' ? session.toolType : '';
			if (toolType === '') continue;
			let agentLevelEnvVars = agentEnvCache.get(toolType);
			if (!agentLevelEnvVars) {
				agentLevelEnvVars = getAgentLevelEnvVars(deps.agentConfigsStore, toolType);
				agentEnvCache.set(toolType, agentLevelEnvVars);
			}
			const target = buildTarget(session, agentLevelEnvVars, mode, homeDir);
			if (!target) continue;
			if (!targetsByKey.has(target.identity.key)) {
				targetsByKey.set(target.identity.key, target);
			}
		}

		// Single-identity refresh: keep the dedup above intact and narrow after,
		// so a filtered pass and a full pass resolve the same target for a key.
		if (deps.onlyKeys) {
			const wanted = new Set(deps.onlyKeys);
			for (const key of Array.from(targetsByKey.keys())) {
				if (!wanted.has(key)) {
					targetsByKey.delete(key);
				}
			}
		}

		// In `'startup'` mode a snapshot younger than PROBE_STALE_MS already
		// answers the question, so the spawn is pure waste. A manual refresh is an
		// explicit "check again", so it ignores this.
		const targets = Array.from(targetsByKey.values()).filter((target) => {
			if (mode !== 'startup') return true;
			if (isSnapshotFresh(getSnapshot(target.identity.key), now)) {
				result.skippedFresh++;
				return false;
			}
			return true;
		});
		result.identities = targetsByKey.size;

		if (targets.length === 0) {
			logger.info('Provider auth probe pass had nothing to probe', LOG_CONTEXT, {
				mode,
				totalSessions: storedSessions.length,
				identities: result.identities,
				skippedFresh: result.skippedFresh,
			});
			return result;
		}

		const resolveBinaryPath = createBinaryPathResolver(deps.agentDetector);
		const sshStore = createSshRemoteStoreAdapter(deps.settingsStore);

		await mapWithConcurrency(targets, PROBE_CONCURRENCY, async (target) => {
			const { identity } = target;
			try {
				// A remote probe runs the provider on the remote host by bare binary
				// name (`wrapSpawnWithSsh` substitutes `agentBinaryName` for the local
				// path), so only a LOCAL identity is gated on local detection.
				const binaryPath = target.sshRemoteConfig
					? (getAgentDefinition(identity.provider)?.binaryName ?? null)
					: await resolveBinaryPath(identity.provider);
				if (binaryPath === null) {
					result.skippedNotInstalled++;
					logger.debug('Skipping auth probe: no binary resolved for this provider', LOG_CONTEXT, {
						key: identity.key,
						provider: identity.provider,
						remote: !!target.sshRemoteConfig,
					});
					return;
				}

				const snapshot = await probeCredential(identity, {
					binaryPath,
					env: target.env,
					cwd: target.cwd,
					now: deps.now ?? Date.now,
					...(target.sshRemoteConfig ? { sshRemoteConfig: target.sshRemoteConfig, sshStore } : {}),
				});

				result.probed++;
				result.byStatus[snapshot.status] = (result.byStatus[snapshot.status] ?? 0) + 1;
				setSnapshot(identity.key, snapshot);
			} catch (error) {
				// A thrown probe is a bug, not a verdict: record nothing rather than
				// letting a crash read as a login state.
				logger.warn('Auth probe threw; leaving the stored snapshot untouched', LOG_CONTEXT, {
					key: identity.key,
					provider: identity.provider,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});

		logger.info(`Probed provider auth for ${result.probed} identity(ies)`, LOG_CONTEXT, {
			mode,
			...result,
		});
		return result;
	} catch (error) {
		logger.warn('Provider auth probe pass failed', LOG_CONTEXT, {
			error: error instanceof Error ? error.message : String(error),
		});
		return result;
	}
}
