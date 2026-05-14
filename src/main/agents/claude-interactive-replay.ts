/**
 * Claude interactive-mode reactive limit detection (phase 3, task 1).
 *
 * When the spawner launches Claude under interactive mode (i.e. `maestro-p`
 * driving the real Claude TUI), the wrapper process exits with code 2 if the
 * Max-plan quota window is hit mid-turn (see `src/maestro-p/index.ts` —
 * `finalize({ ..., exitCode: limitHit ? 2 : 0 })`).
 *
 * This module captures everything we need at spawn time to transparently
 * respawn the same turn under api mode + `--resume <sessionId>` and replay the
 * user's last prompt — without involving the renderer. The user sees one
 * continuous response with a mode-badge transition mid-stream.
 *
 * State is held in a module-level Map keyed by sessionId. Entries are pruned
 * on every exit (cleanly or otherwise) so a single tab can never accumulate
 * stale replay context.
 */

import type { BrowserWindow } from 'electron';
import type Store from 'electron-store';
import type { EventEmitter } from 'events';

import { sampleUsage, type SampleUsageOptions } from './claude-usage-sampler';
import { setSnapshot as setUsageSnapshot } from '../stores/claudeUsageStore';
import type { UsageSnapshot } from './claude-mode-selector';
import { logger } from '../utils/logger';
import { isWebContentsAvailable } from '../utils/safe-send';
import type { ProcessConfig, SpawnResult } from '../process-manager/types';
import type { SessionsData, StoredSession } from '../stores/types';

const LOG_CONTEXT = '[ClaudeInteractiveReplay]';

/** Exit code emitted by `maestro-p` when it detects the limit-hit during a turn. */
export const MAESTRO_P_LIMIT_EXIT_CODE = 2;

/**
 * Everything required to (a) refresh the usage snapshot and (b) respawn the
 * turn under api mode. Built once at interactive-spawn time and consumed once
 * on the matching exit event.
 */
export interface ClaudeReplayContext {
	/**
	 * Builder for the api-mode `ProcessConfig`. Called at replay time so the
	 * closure can pick up any state updated between spawn and exit (e.g. the
	 * `agentSessionId` discovered mid-turn by maestro-p's session-id watcher,
	 * which the `--resume` flag needs to keep Claude on the same conversation).
	 */
	buildApiSpawnConfig: () => ProcessConfig;
	/** Effective `CLAUDE_CONFIG_DIR` for the turn (or undefined to inherit). */
	configDir: string | undefined;
	/** Canonical config-dir key — same one the usage store uses. */
	configDirKey: string;
	/** Working directory for the `maestro-p --status` refresh subprocess. */
	cwd: string;
	/** Env to merge into the refresh subprocess (must include `MAESTRO_CLAUDE_BIN`). */
	envForSample: Record<string, string>;
	/** Path to the bundled maestro-p binary used by the refresh. */
	maestroPBinPath: string;
	/**
	 * Optional teardown callback. Invoked exactly once after the watcher detaches
	 * (any exit code, including replay). Used by the spawn-site to unhook auxiliary
	 * listeners — e.g. the `session-id` listener that updates the captured
	 * `agentSessionId` so `--resume` stays current.
	 */
	onCleanup?: () => void;
}

/**
 * Dependencies injected at registration time. Kept narrow so the unit test
 * can supply fakes without dragging in electron/electron-store/ProcessManager.
 */
export interface ClaudeReplayDeps {
	/** ProcessManager (or any EventEmitter) emitting `exit(sessionId, code)`. */
	processManager: EventEmitter;
	/** Spawn callback — receives the api-mode `ProcessConfig` on replay. */
	spawn: (config: ProcessConfig) => SpawnResult;
	/** Sessions store — written-through with the new `claudeInteractive` state. */
	sessionsStore: Store<SessionsData>;
	/** Main window getter — used to emit `process:claude-mode-resolved` so the renderer mirrors the flip. */
	getMainWindow: () => BrowserWindow | null;
	/** Test seam: swap in a fake usage sampler. */
	sampleUsageFn?: (opts: SampleUsageOptions) => Promise<UsageSnapshot | null>;
	/** Test seam: swap in a fake snapshot setter. */
	setSnapshotFn?: (snapshot: UsageSnapshot) => void;
}

const replayContexts = new Map<string, ClaudeReplayContext>();
const exitListeners = new Map<string, (sessionId: string, code: number) => void>();

/**
 * Register a one-shot replay watcher for an interactive Claude spawn. The
 * watcher fires on the next `exit` event for `sessionId` from the supplied
 * `processManager` emitter:
 *   - If exit code === {@link MAESTRO_P_LIMIT_EXIT_CODE}: refresh usage, flip
 *     the per-tab state to `{ mode: 'api', modeReason: 'limit' }`, and respawn
 *     the same turn via `deps.spawn(apiSpawnConfig)`.
 *   - For any other exit code: clear the captured state with no respawn.
 */
export function registerInteractiveReplay(
	sessionId: string,
	ctx: ClaudeReplayContext,
	deps: ClaudeReplayDeps
): void {
	// If a prior registration is still hanging (e.g. a previous spawn never
	// emitted exit), unbind it before installing the new one so we don't
	// double-fire.
	const prior = exitListeners.get(sessionId);
	if (prior) {
		deps.processManager.off('exit', prior);
		exitListeners.delete(sessionId);
	}

	replayContexts.set(sessionId, ctx);

	const onExit = (exitedSessionId: string, code: number): void => {
		if (exitedSessionId !== sessionId) return;
		deps.processManager.off('exit', onExit);
		exitListeners.delete(sessionId);

		const captured = replayContexts.get(sessionId);
		if (!captured) return;
		replayContexts.delete(sessionId);

		const runCleanup = (): void => {
			if (!captured.onCleanup) return;
			try {
				captured.onCleanup();
			} catch (err) {
				logger.warn(
					`Claude replay onCleanup threw for ${sessionId}: ${(err as Error).message}`,
					LOG_CONTEXT
				);
			}
		};

		if (code !== MAESTRO_P_LIMIT_EXIT_CODE) {
			logger.debug(
				`Claude interactive exit ${code} for ${sessionId} — no replay (not limit-hit)`,
				LOG_CONTEXT
			);
			runCleanup();
			return;
		}

		void executeReplay(sessionId, captured, deps)
			.catch((err) => {
				logger.error(
					`Claude interactive replay failed for ${sessionId}: ${(err as Error).message}`,
					LOG_CONTEXT,
					{ err: String(err) }
				);
			})
			.finally(runCleanup);
	};

	deps.processManager.on('exit', onExit);
	exitListeners.set(sessionId, onExit);
}

/**
 * Drop any stored replay context (and matching listener) for `sessionId`.
 * Called when an interactive turn was never going to need replay — e.g. the
 * tab is killed or the mode is force-pinned mid-flight.
 */
export function clearInteractiveReplay(
	sessionId: string,
	deps?: Pick<ClaudeReplayDeps, 'processManager'>
): void {
	const listener = exitListeners.get(sessionId);
	if (listener && deps) {
		deps.processManager.off('exit', listener);
	}
	exitListeners.delete(sessionId);
	const captured = replayContexts.get(sessionId);
	replayContexts.delete(sessionId);
	if (captured?.onCleanup) {
		try {
			captured.onCleanup();
		} catch (err) {
			logger.warn(
				`Claude replay onCleanup threw during clear for ${sessionId}: ${(err as Error).message}`,
				LOG_CONTEXT
			);
		}
	}
}

/**
 * Execute the limit-hit replay flow. Steps mirror MAESTRO-P-03 task 1:
 *   (a) Immediate `sampleUsage()` refresh so the next selection sees fresh data.
 *   (b) Write-through `session.claudeInteractive = { mode: 'api', modeReason: 'limit' }`.
 *   (c) Emit `process:claude-mode-resolved` so the renderer mirrors the flip.
 *   (d) Spawn the api-mode config (already carries `--resume <id>` + prompt).
 */
async function executeReplay(
	sessionId: string,
	ctx: ClaudeReplayContext,
	deps: ClaudeReplayDeps
): Promise<void> {
	logger.info(
		`Claude interactive turn hit limit (exit 2) — respawning under api for ${sessionId}`,
		LOG_CONTEXT,
		{ configDirKey: ctx.configDirKey }
	);

	// (a) Refresh the usage snapshot. Best-effort: failure here doesn't stop the replay.
	try {
		const fn = deps.sampleUsageFn ?? sampleUsage;
		const snapshot = await fn({
			binPath: ctx.maestroPBinPath,
			configDir: ctx.configDir,
			cwd: ctx.cwd,
			customEnvVars: ctx.envForSample,
		});
		if (snapshot) {
			const setter = deps.setSnapshotFn ?? setUsageSnapshot;
			setter(snapshot);
			logger.debug(`Claude usage snapshot refreshed post-limit for ${sessionId}`, LOG_CONTEXT, {
				configDirKey: ctx.configDirKey,
				sessionPercent: snapshot.session.percent,
				weekAllPercent: snapshot.weekAllModels.percent,
			});
		} else {
			logger.warn(`Claude usage refresh returned null post-limit for ${sessionId}`, LOG_CONTEXT);
		}
	} catch (err) {
		logger.warn(
			`Claude usage refresh threw post-limit for ${sessionId}: ${(err as Error).message}`,
			LOG_CONTEXT
		);
	}

	// (b) Persist the new per-tab pin via direct sessionsStore write-through so
	// the next user turn (and any other spawn-time reader) sees `limit` even
	// before the renderer mirrors the event.
	try {
		updateSessionLimitState(deps.sessionsStore, sessionId);
	} catch (err) {
		logger.warn(
			`Failed to write claudeInteractive=limit for ${sessionId}: ${(err as Error).message}`,
			LOG_CONTEXT
		);
	}

	// (c) Tell the renderer about the flip so the badge updates mid-stream.
	const mainWindow = deps.getMainWindow();
	if (isWebContentsAvailable(mainWindow)) {
		mainWindow.webContents.send('process:claude-mode-resolved', sessionId, {
			mode: 'api',
			reason: 'limit',
			configDirKey: ctx.configDirKey,
		});
	}

	// (d) Respawn under api mode. The captured builder constructs a fresh
	// `ProcessConfig` so any state observed after the initial spawn (notably
	// the `agentSessionId` mid-turn) lands in the `--resume <id>` flag and the
	// original prompt is replayed without needing the renderer to resend.
	try {
		const apiSpawnConfig = ctx.buildApiSpawnConfig();
		deps.spawn(apiSpawnConfig);
	} catch (err) {
		logger.error(
			`Failed to respawn Claude under api for ${sessionId}: ${(err as Error).message}`,
			LOG_CONTEXT
		);
	}
}

function updateSessionLimitState(sessionsStore: Store<SessionsData>, sessionId: string): void {
	const sessions = (sessionsStore.get('sessions', []) || []) as StoredSession[];
	const idx = sessions.findIndex((s) => s.id === sessionId);
	if (idx === -1) {
		logger.warn(`No session found for ${sessionId} when persisting limit state`, LOG_CONTEXT);
		return;
	}

	const current = sessions[idx].claudeInteractive as
		| { mode: 'interactive' | 'api'; modeReason: 'user' | 'auto' | 'limit' }
		| undefined;
	if (current && current.mode === 'api' && current.modeReason === 'limit') {
		// Already in the target state — no need to rewrite to disk.
		return;
	}

	const updated = sessions.map((s, i) =>
		i === idx
			? {
					...s,
					claudeInteractive: {
						...(current ?? {}),
						mode: 'api' as const,
						modeReason: 'limit' as const,
					},
				}
			: s
	);
	sessionsStore.set('sessions', updated);
	logger.info(
		`Persisted claudeInteractive=api/limit for ${sessionId} after limit-hit replay`,
		LOG_CONTEXT
	);
}

/**
 * Test-only: drop all registered replay contexts and any installed listeners.
 * The unit test calls this between cases to guarantee a clean slate without
 * having to reach into the module's private state.
 */
export function __resetReplayStateForTests(deps?: Pick<ClaudeReplayDeps, 'processManager'>): void {
	if (deps) {
		for (const [, listener] of exitListeners) {
			deps.processManager.off('exit', listener);
		}
	}
	exitListeners.clear();
	replayContexts.clear();
}

/**
 * Test-only: inspect a captured replay context. Lets the test assert the
 * apiSpawnConfig the spawner registered without needing to reach into the
 * module's private map.
 */
export function __peekReplayContextForTests(sessionId: string): ClaudeReplayContext | undefined {
	return replayContexts.get(sessionId);
}
