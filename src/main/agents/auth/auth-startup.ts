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
 *   - `'startup'` (default): skip the whole pass when the user turned
 *     `providerAuthProbeOnStartup` off, skip identities whose stored snapshot is
 *     younger than `PROBE_STALE_MS`, skip sessions nobody has touched in a week,
 *     and skip SSH-remote sessions entirely (see below). Keeps boot cheap.
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

import type { CredentialIdentity, ProviderAuthSource } from '../../../shared/providerAuth';
import { mergeEffectiveEnv, resolveCredentialIdentity } from '../../../shared/providerAuth';
import { failoverUnsetEnvKeys, resolveFailoverEnv } from '../../../shared/providerFailover';
import { getFailoverOverlay } from '../../process-manager/failover-overlay';
import type { AgentSshRemoteConfig } from '../../../shared/types';
import type { AgentConfigsData, MaestroSettings, SessionsData } from '../../stores/types';
import { getSnapshot, isSnapshotFresh, setSnapshot } from '../../stores/providerAuthStore';
import { mapWithConcurrency } from '../../utils/concurrency';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
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
	/**
	 * Attribution for whatever this pass writes. Defaults to the probe's own
	 * `'probe'`.
	 *
	 * The recovery modal passes `'login-flow'`, so a snapshot that says
	 * "authenticated" carries WHY it says so: the user just finished a login here,
	 * not a background sweep that happened to find a live token. The attribution
	 * applies to whatever the probe finds, including a still-`logged-out` result -
	 * that check came from the login flow too, and pretending otherwise would put
	 * a wrong provenance on disk.
	 */
	source?: ProviderAuthSource;
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

/**
 * One unique credential identity plus everything needed to run a provider
 * command as it: the effective env, a working directory, and the SSH config when
 * the credential lives on another machine.
 *
 * Exported because the login flow (`auth-login.ts`) needs exactly this and must
 * NOT re-derive it. Resolving the env twice is how a login ends up repairing
 * `.claude-smash` while the blocked account is `.claude-gmail`.
 */
export interface AuthTarget {
	identity: CredentialIdentity;
	env: Record<string, string>;
	cwd: string;
	sshRemoteConfig?: AgentSshRemoteConfig;
	/**
	 * The agent's own binary override (`Session.customPath`), when it has one.
	 *
	 * The spawner prefers it over the detected binary on BOTH paths - locally,
	 * and as the remote command over SSH (`process:spawn` resolves
	 * `sessionCustomPath || agent.binaryName`). A probe that ignored it would
	 * report on whichever installation Maestro happened to detect while the agent
	 * runs a different one, which is the same class of bug as probing the wrong
	 * credential.
	 *
	 * Not part of {@link CredentialIdentity.key}: two installations of one CLI
	 * reading the same config dir present the SAME account, so this describes how
	 * to ask, not who is being asked about. Deduped first-session-wins with the
	 * env and cwd below.
	 */
	binaryPath?: string;
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
	globalEnvVars: Record<string, string>,
	agentLevelEnvVars: Record<string, string>,
	mode: 'startup' | 'manual',
	homeDir: string
): AuthTarget | null {
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
	// Provider Failover: when the renderer has pinned this agent to a backup
	// endpoint, that endpoint's env is what the agent SPAWNS with, so it is also
	// the credential to report on. Probing the primary here would show a healthy
	// account for an agent that is failing on the backup, and offer a recovery
	// that repairs a login the agent is not using.
	//
	// Overlays live in memory and are not persisted, so this is always empty at
	// launch - it changes manual re-probes and recovery logins, which is exactly
	// when an agent can be mid-failover.
	//
	// Keyed by the BARE agent id, which is what a stored session's id already is.
	const failoverEnv = typeof session.id === 'string' ? getFailoverOverlay(session.id) : undefined;

	// All three layers, in the order the spawner applies them. Settings ->
	// Environment is where a user puts a key they want every agent to inherit, so
	// omitting it would resolve such an agent to its default OAuth identity and
	// probe an account it never uses.
	const env = mergeEffectiveEnv(
		globalEnvVars,
		agentLevelEnvVars,
		resolveFailoverEnv(sessionEnvVars, failoverEnv)
	);

	// Auth is all-or-nothing per endpoint: a backup that redirects the base URL
	// must not inherit the primary's credential. `resolveFailoverEnv` drops it
	// from the agent's own vars, but the same key also reaches the child from the
	// global and agent layers above, so the removal is applied to the MERGED env -
	// the same order `process:spawn` uses. Without it a URL-only backup row still
	// resolves to the primary api-key identity.
	for (const key of failoverUnsetEnvKeys(failoverEnv)) {
		delete env[key];
	}

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

	const customPath =
		typeof session.customPath === 'string' && session.customPath !== ''
			? session.customPath
			: undefined;

	return {
		identity,
		env,
		...(customPath ? { binaryPath: customPath } : {}),
		// A remote cwd is a path on the remote host and a local one is local;
		// either way the status commands do not care where they run, so this only
		// has to be a directory that exists on the machine running the probe.
		cwd: usesSsh ? cwd : homeDir,
		...(usesSsh ? { sshRemoteConfig } : {}),
	};
}

/**
 * Absolute path to a provider binary on THIS host, or null when the agent is not
 * installed here - the caller's cue to skip every LOCAL identity for it. A
 * REMOTE identity is never gated on this: `wrapSpawnWithSsh` invokes the
 * provider by bare binary name on the far side.
 *
 * Exported so the login flow resolves its binary the same way the probe does.
 */
export async function resolveProviderBinaryPath(
	agentDetector: AgentDetector,
	provider: string
): Promise<string | null> {
	try {
		const agent = await agentDetector.getAgent(provider);
		if (!agent) return null;
		// Same `path || command` convention the spawner uses: prefer the resolved
		// absolute path, fall back to the bare binary name so PATH resolution can
		// still find it.
		return agent.path || agent.command || null;
	} catch (error) {
		logger.warn('Agent detection failed while resolving a provider binary', LOG_CONTEXT, {
			provider,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/** Memoized {@link resolveProviderBinaryPath}, one entry per provider per pass. */
function createBinaryPathResolver(
	agentDetector: AgentDetector
): (provider: string) => Promise<string | null> {
	const cache = new Map<string, Promise<string | null>>();
	return (provider: string) => {
		const cached = cache.get(provider);
		if (cached) {
			return cached;
		}
		const pending = resolveProviderBinaryPath(agentDetector, provider);
		cache.set(provider, pending);
		return pending;
	};
}

/** Inputs to {@link collectAuthTargets}. */
export interface CollectAuthTargetsDeps {
	sessionsStore: Pick<Store<SessionsData>, 'get'>;
	agentConfigsStore: Pick<Store<AgentConfigsData>, 'get'>;
	/** Settings -> Environment, the global env layer every agent inherits. */
	settingsStore: Pick<Store<MaestroSettings>, 'get'>;
	/** See the mode notes in the module docblock. */
	mode: 'startup' | 'manual';
	/** Epoch ms the pass runs at, for the `'startup'` recency window. */
	now: number;
	/** Home directory on this host, used to expand default config dirs. */
	homeDir: string;
}

/**
 * Every unique credential identity referenced by an eligible stored session,
 * keyed by {@link CredentialIdentity.key}.
 *
 * This is the one place a session's tool type, agent-level env, session-level
 * env, and SSH config are folded into a credential. Both the probe pass and the
 * login flow go through it, so "which account is this" cannot answer differently
 * depending on who is asking.
 *
 * Dedup keeps the FIRST session that resolves a key: the target describes a
 * credential, not a session, so any session presenting it produces the same run.
 */
export function collectAuthTargets(deps: CollectAuthTargetsDeps): Map<string, AuthTarget> {
	const { sessionsStore, agentConfigsStore, settingsStore, mode, now, homeDir } = deps;
	const globalEnvVars = settingsStore.get('shellEnvVars', {}) as Record<string, string>;
	const storedSessions = sessionsStore.get('sessions', []) as Array<Record<string, unknown>>;

	const targetsByKey = new Map<string, AuthTarget>();
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
			agentLevelEnvVars = getAgentLevelEnvVars(agentConfigsStore, toolType);
			agentEnvCache.set(toolType, agentLevelEnvVars);
		}
		const target = buildTarget(session, globalEnvVars, agentLevelEnvVars, mode, homeDir);
		if (!target) continue;
		if (!targetsByKey.has(target.identity.key)) {
			targetsByKey.set(target.identity.key, target);
		}
	}

	return targetsByKey;
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

		// The user's opt-out (Settings -> Environment -> Provider Accounts) applies
		// to the SCHEDULED pass only. A manual re-probe is an explicit request, and
		// refusing to run it would leave the panel with no way to check anything.
		// Enforced here rather than at the boot call site so a second scheduled
		// caller cannot forget it.
		if (mode === 'startup' && deps.settingsStore.get('providerAuthProbeOnStartup') === false) {
			logger.info('Startup provider auth probe disabled by setting', LOG_CONTEXT);
			return result;
		}

		const homeDir = os.homedir();

		const storedSessions = deps.sessionsStore.get('sessions', []) as Array<Record<string, unknown>>;

		// Dedup by identity key. First session wins on env / cwd shape: the
		// snapshot describes a credential, not a session, so any session that
		// presents this credential produces the same probe.
		const targetsByKey = collectAuthTargets({
			sessionsStore: deps.sessionsStore,
			agentConfigsStore: deps.agentConfigsStore,
			settingsStore: deps.settingsStore,
			mode,
			now,
			homeDir,
		});

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
				// Resolve the binary exactly as `process:spawn` does, so the probe
				// reports on the installation the agent actually runs:
				//   remote -> sessionCustomPath || agent.binaryName
				//   local  -> customPath || detected path
				// An agent's own `customPath` wins on BOTH paths. Over SSH it names a
				// path on the REMOTE host (that is what the user configured it for),
				// which is also why a remote identity is never gated on local
				// detection - the far side resolves it, not this machine.
				const binaryPath = target.sshRemoteConfig
					? (target.binaryPath ?? getAgentDefinition(identity.provider)?.binaryName ?? null)
					: (target.binaryPath ?? (await resolveBinaryPath(identity.provider)));
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
				// `deps.source` re-attributes the write without touching what the
				// probe decided the status IS - see the field's docblock.
				setSnapshot(identity.key, deps.source ? { ...snapshot, source: deps.source } : snapshot);
			} catch (error) {
				// A thrown probe is a bug, not a verdict: record nothing rather than
				// letting a crash read as a login state. `probeCredential` documents
				// that it never throws, so reaching here means it broke its own
				// contract - report it rather than leaving a warn line in a log file
				// nobody reads.
				logger.warn('Auth probe threw; leaving the stored snapshot untouched', LOG_CONTEXT, {
					key: identity.key,
					provider: identity.provider,
					error: error instanceof Error ? error.message : String(error),
				});
				void captureException(error, {
					context: LOG_CONTEXT,
					operation: 'probeCredential',
					provider: identity.provider,
					// The key, never the env: it carries CLAUDE_CONFIG_DIR and friends,
					// and for an api-key identity the key's scope is a fingerprint.
					identityKey: identity.key,
				});
			}
		});

		logger.info(`Probed provider auth for ${result.probed} identity(ies)`, LOG_CONTEXT, {
			mode,
			...result,
		});
		return result;
	} catch (error) {
		// The pass is fire-and-forget, so this is the only thing standing between a
		// broken store read and a crash on boot. It stays caught for that reason,
		// and reported because nothing above it will ever see the exception.
		logger.warn('Provider auth probe pass failed', LOG_CONTEXT, {
			error: error instanceof Error ? error.message : String(error),
		});
		void captureException(error, { context: LOG_CONTEXT, operation: 'runStartupAuthProbe' });
		return result;
	}
}
