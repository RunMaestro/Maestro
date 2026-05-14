/**
 * Claude usage startup sampling.
 *
 * On app launch, walks the persisted session list, picks Claude Code sessions
 * used within the last 7 days, and pre-populates {@link claudeUsageStore} with
 * one `maestro-p --status` snapshot per unique `CLAUDE_CONFIG_DIR` they
 * effectively use. Phase 2 ships this so the mode selector under `auto` has
 * fresh limit data on the first spawn instead of falling back to `null` and
 * silently treating every account as below quota.
 *
 * Failure handling: the underlying {@link sampleUsage} call never throws — it
 * resolves to `null` on any error and reports the cause via Sentry. This
 * module only logs a one-liner per sampled key and a final summary; it never
 * blocks the rest of app startup.
 *
 * Phase 2 default for `claudeCode.headlessMode` is still `'api'`, so this
 * primarily benefits users who flip the setting (or the per-tab override) to
 * `interactive` / `auto`. Sampling on startup costs ~one `maestro-p --status`
 * roundtrip per Claude account in use (the wrapper's `STATUS_QUIESCENCE_MS`
 * is 1.5s; the outer 30s timeout caps the worst case).
 */

import { app } from 'electron';
import os from 'os';
import path from 'path';

import type { AgentDetector } from './detector';
import { sampleUsage } from './claude-usage-sampler';
import { resolveConfigDirKey, setSnapshot } from '../stores/claudeUsageStore';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[ClaudeUsageStartup]';

/** Window for "recently used" — sessions older than this are skipped. */
const RECENT_SESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Minimal session shape this module relies on. The full Session interface
 * lives in the renderer types — we only need a few fields, and importing it
 * would drag a chunk of UI typing into the main process. Marked partial
 * because old persisted sessions may pre-date some of these fields.
 */
interface RecentSessionSlice {
	id?: string;
	toolType?: string;
	createdAt?: number;
	customEnvVars?: Record<string, string>;
	cwd?: string;
	fullPath?: string;
}

interface AgentConfigSlice {
	customEnvVars?: Record<string, string>;
}

/**
 * Loose store accessor used by this module. The real `Store<SessionsData>`
 * declared in `stores/types.ts` carries a much wider `StoredSession` schema —
 * widening the schema for tests would mean duplicating renderer types in main,
 * and narrowing it via `Store<{ sessions: RecentSessionSlice[] }>` fails
 * because electron-store's `get` parameter types aren't assignable in the
 * direction TS structural typing needs. A `get`-only function-style accessor
 * sidesteps both problems and lets tests substitute a trivial in-memory stub.
 */
type StoreReader<TValue> = {
	get(key: string, defaultValue?: TValue): TValue;
};

export interface ClaudeUsageStartupDeps {
	sessionsStore: StoreReader<RecentSessionSlice[]>;
	agentConfigsStore: StoreReader<Record<string, AgentConfigSlice>>;
	getAgentDetector: () => AgentDetector | null;
}

/**
 * Resolve the absolute path to the bundled `maestro-p.js` script.
 *
 * Mirrors the dev/packaged split used by `speckit-manager` for prompts. In dev,
 * compiled main lives at `dist/main/*.js`, and the wrapper is its sibling at
 * `dist/cli/maestro-p.js`. In a packaged build, `dist/cli/maestro-p.js` is
 * copied into the app's resources directory by electron-builder's
 * `extraResources` entry, mirroring how `maestro-cli.js` is shipped.
 */
export function getMaestroPBinPath(): string {
	if (app.isPackaged) {
		return path.join(process.resourcesPath, 'maestro-p.js');
	}
	return path.join(__dirname, '..', 'cli', 'maestro-p.js');
}

/**
 * Build the "MAESTRO_CLAUDE_BIN + per-account CLAUDE_CONFIG_DIR" map for every
 * unique Claude config dir that recent Claude Code sessions point at.
 *
 * Precedence for `CLAUDE_CONFIG_DIR`: per-session `customEnvVars` overrides the
 * agent-level `customEnvVars`. This matches the precedence the spawner applies
 * at runtime (`config.sessionCustomEnvVars` wins inside `applyAgentConfigOverrides`).
 *
 * The returned `cwd` is the session's original `cwd` (or `fullPath`) when one
 * exists — the wrapper itself doesn't care about cwd for `--status`, but the
 * child process needs a valid one, and using a real project root keeps any
 * wrapper-side log lines consistent with normal spawns.
 */
function planSamplesForRecentSessions(
	sessions: RecentSessionSlice[],
	claudeAgentEnv: Record<string, string>,
	nowMs: number
): Map<
	string,
	{ configDir: string | undefined; envForChild: Record<string, string>; cwd: string }
> {
	const cutoff = nowMs - RECENT_SESSION_WINDOW_MS;
	const dedup = new Map<
		string,
		{ configDir: string | undefined; envForChild: Record<string, string>; cwd: string }
	>();

	for (const session of sessions) {
		if (session.toolType !== 'claude-code') continue;
		if (typeof session.createdAt !== 'number' || session.createdAt < cutoff) continue;

		const sessionEnv = session.customEnvVars ?? {};
		const merged: Record<string, string> = { ...claudeAgentEnv, ...sessionEnv };
		const configDir = merged.CLAUDE_CONFIG_DIR;

		const envForKey: NodeJS.ProcessEnv = configDir ? { CLAUDE_CONFIG_DIR: configDir } : {};
		const key = resolveConfigDirKey(envForKey);

		if (dedup.has(key)) continue;

		const cwd = session.cwd || session.fullPath || os.homedir();
		dedup.set(key, { configDir, envForChild: merged, cwd });
	}

	return dedup;
}

/**
 * Run the startup sampler. Fires off one `maestro-p --status` per unique config
 * dir in parallel, persists successes to `claudeUsageStore`, and resolves once
 * every spawn has settled (success, error, or timeout). Never throws.
 *
 * Returns the number of snapshots successfully persisted, primarily so tests
 * can assert behavior without poking at the store. Callers in production can
 * ignore the return value.
 */
export async function runStartupUsageSampling(
	deps: ClaudeUsageStartupDeps,
	nowMs: number = Date.now()
): Promise<number> {
	const sessions = (deps.sessionsStore.get('sessions', []) || []) as RecentSessionSlice[];
	const agentConfigs = (deps.agentConfigsStore.get('configs', {}) || {}) as Record<
		string,
		AgentConfigSlice
	>;
	const claudeAgentEnv = agentConfigs['claude-code']?.customEnvVars ?? {};

	const plan = planSamplesForRecentSessions(sessions, claudeAgentEnv, nowMs);
	if (plan.size === 0) {
		logger.info('No recent Claude Code sessions — skipping startup usage sampling', LOG_CONTEXT);
		return 0;
	}

	const detector = deps.getAgentDetector();
	const claudeAgent = detector ? await detector.getAgent('claude-code') : null;
	const claudeBinPath = claudeAgent?.path;
	if (!claudeAgent) {
		logger.warn('Claude Code agent not detected — skipping startup usage sampling', LOG_CONTEXT);
		return 0;
	}

	const maestroPBinPath = getMaestroPBinPath();

	logger.info(
		`Sampling Claude usage for ${plan.size} unique config dir(s) at startup`,
		LOG_CONTEXT,
		{
			maestroPBinPath,
			claudeBinPath,
			configDirCount: plan.size,
		}
	);

	let storedCount = 0;
	await Promise.all(
		Array.from(plan.entries()).map(async ([configDirKey, opts]) => {
			// `MAESTRO_CLAUDE_BIN` tells maestro-p which real `claude` binary to drive.
			// Without it, the wrapper falls back to a PATH lookup that's unreliable in a
			// packaged Electron context (PATH is often pruned). We pass the detected
			// agent path explicitly so the sample always uses the same binary the
			// spawner would.
			const envForChild: Record<string, string> = { ...opts.envForChild };
			if (claudeBinPath) {
				envForChild.MAESTRO_CLAUDE_BIN = claudeBinPath;
			}

			const snapshot = await sampleUsage({
				binPath: maestroPBinPath,
				configDir: opts.configDir,
				cwd: opts.cwd,
				customEnvVars: envForChild,
			});

			if (snapshot) {
				setSnapshot(snapshot);
				storedCount++;
				logger.info('Claude usage snapshot stored at startup', LOG_CONTEXT, {
					configDirKey,
					sessionPercent: snapshot.session.percent,
					weekAllModelsPercent: snapshot.weekAllModels.percent,
				});
			} else {
				logger.warn('Claude usage sample failed at startup', LOG_CONTEXT, { configDirKey });
			}
		})
	);

	logger.info('Startup usage sampling complete', LOG_CONTEXT, {
		attempted: plan.size,
		stored: storedCount,
	});
	return storedCount;
}
