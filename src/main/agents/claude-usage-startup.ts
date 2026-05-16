/**
 * Claude Usage Startup Sampler
 *
 * Fires a one-shot `maestro-p --status` per unique CLAUDE_CONFIG_DIR account
 * referenced by any recent Claude Code session, and persists each result into
 * `claudeUsageStore`. Invoked from `src/main/index.ts` after settings/CLI
 * watchers come up, as fire-and-forget — the spawner can still fall through
 * with a null snapshot if sampling never completed, and the 5-min stale
 * refresh inside the spawner's mode-selection block tops the store back up
 * lazily when an `auto`-mode tab actually needs the data.
 *
 * Why "per CLAUDE_CONFIG_DIR account":
 *   The Max-plan quota is bucketed per Anthropic account, and Maestro users
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
 *   time — sampling those would waste a 30s spawn budget per account that
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

import fs from 'fs';
import path from 'path';
import Store from 'electron-store';

import type { AgentDetector } from './detector';
import type { AgentConfigsData } from '../stores/types';
import type { MaestroSettings } from '../ipc/handlers/persistence';
import { logger } from '../utils/logger';
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
	sessionsStore: Store<{ sessions: any[] }>;
	agentConfigsStore: Store<AgentConfigsData>;
	settingsStore: Store<MaestroSettings>;
	agentDetector: AgentDetector;
	/** Override for tests; defaults to `Date.now()`. */
	now?: () => number;
}

interface SamplingTarget {
	configDir: string;
	configDirKey: string;
	cwd: string;
	customEnvVars: Record<string, string>;
}

/**
 * Locate the bundled `maestro-p.js` script. Returns null when no candidate
 * exists — callers treat this the same as "claude agent missing" and skip
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
 * Build the per-session sampling target: merge agent-level + session-level
 * customEnvVars (session wins, matching the spawner's runtime precedence),
 * extract `CLAUDE_CONFIG_DIR`, canonicalize, and produce the call shape
 * `sampleUsage()` expects.
 *
 * Returns null when the session has no `cwd` (truly malformed record we
 * should skip rather than fall back to something risky like the user's
 * home directory).
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

	const cwd =
		typeof session.cwd === 'string' && session.cwd.length > 0
			? session.cwd
			: typeof session.projectRoot === 'string' && session.projectRoot.length > 0
				? session.projectRoot
				: null;
	if (!cwd) {
		return null;
	}

	// `resolveConfigDirKey()` takes a full env block. Build a minimal env
	// carrying just `CLAUDE_CONFIG_DIR` so the resolver applies its
	// `~/.claude` fallback when neither agent- nor session-level vars set it.
	const envForKey: NodeJS.ProcessEnv = {};
	if (customEnvVars.CLAUDE_CONFIG_DIR !== undefined) {
		envForKey.CLAUDE_CONFIG_DIR = customEnvVars.CLAUDE_CONFIG_DIR;
	} else if (process.env.CLAUDE_CONFIG_DIR !== undefined) {
		// Fall back to the host's env if no session/agent override exists, so
		// the snapshot key matches the spawner's resolution at runtime.
		envForKey.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
	}
	const configDirKey = resolveConfigDirKey(envForKey);

	return {
		configDir: envForKey.CLAUDE_CONFIG_DIR ?? configDirKey,
		configDirKey,
		cwd,
		customEnvVars,
	};
}

/**
 * Sample `maestro-p --status` for every unique CLAUDE_CONFIG_DIR account
 * referenced by a recent Claude Code session, and write each result to
 * `claudeUsageStore`. Resolves when every parallel sample has settled.
 *
 * Never throws — every failure surfaces as a warn log and a skipped entry.
 */
export async function runStartupUsageSampling(deps: StartupUsageSamplingDeps): Promise<void> {
	const now = (deps.now ?? Date.now)();

	const claudeAgent = await deps.agentDetector.getAgent('claude-code');
	if (!claudeAgent) {
		logger.warn('Skipping startup usage sampling: claude-code agent not detected', LOG_CONTEXT);
		return;
	}

	const storedSessions = deps.sessionsStore.get('sessions', []) as Array<Record<string, unknown>>;
	const recentClaudeSessions = storedSessions.filter((s) => {
		if (s?.toolType !== 'claude-code') return false;
		// Only sample for sessions that have opted into Batch Mode — sampling
		// `maestro-p --status` for an agent that will never spawn through it
		// just burns latency on startup.
		if (s?.enableMaestroP !== true) return false;
		const createdAt = typeof s.createdAt === 'number' ? s.createdAt : null;
		if (createdAt === null) return false;
		return createdAt >= now - STARTUP_SESSION_WINDOW_MS;
	});

	if (recentClaudeSessions.length === 0) {
		logger.info(
			'Skipping startup usage sampling: no recent Batch Mode-enabled Claude sessions',
			LOG_CONTEXT,
			{ totalSessions: storedSessions.length }
		);
		return;
	}

	const binPath = getMaestroPBinPath();
	if (!binPath) {
		logger.warn('Skipping startup usage sampling: bundled maestro-p.js not found', LOG_CONTEXT);
		return;
	}

	const agentLevelEnvVars = getAgentLevelEnvVars(deps.agentConfigsStore);

	// Dedup by canonical configDirKey so two sessions pointing at the same
	// Anthropic account only sample once. First session wins on cwd / env
	// shape — the snapshot is a per-account quota, not per-session.
	const targetsByKey = new Map<string, SamplingTarget>();
	for (const session of recentClaudeSessions) {
		const target = buildTarget(session, agentLevelEnvVars);
		if (!target) continue;
		if (!targetsByKey.has(target.configDirKey)) {
			targetsByKey.set(target.configDirKey, target);
		}
	}

	if (targetsByKey.size === 0) {
		logger.info(
			'Skipping startup usage sampling: no usable sessions after env resolution',
			LOG_CONTEXT
		);
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
