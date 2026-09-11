/**
 * Claude Interactive Replay Controller
 *
 * Reactive limit detection for the `maestro-p` interactive Claude spawn:
 * when the wrapper exits with code 2 mid-turn (Max-plan quota exhausted
 * during the run), the controller transparently transitions the session
 * to API mode and respawns the same prompt under `claude --print` so the
 * user sees one continuous response with a single mode-badge change.
 *
 * Flow on exit code 2:
 *   (a) refresh the `claudeUsageStore` snapshot for the relevant
 *       `configDirKey` (best-effort - failures don't block replay);
 *   (b) persist `session.claudeInteractive = { mode: 'api',
 *       modeReason: 'limit' }` via the injected write-through;
 *   (c) re-emit `process:claude-mode-resolved` so the renderer mirror
 *       flips its badge immediately, before the replay spawn lands;
 *   (d) call the caller's `buildApiSpawnConfig()` closure to produce a
 *       fresh `ProcessConfig` and hand it to `spawnReplay()`.
 *
 * Replay-once semantics: the exit listener removes itself before running
 * the flow, so a duplicate `exit` (process manager re-fires, hook errors,
 * etc.) cannot re-trigger the replay. The replay's own spawn is a
 * fresh, non-interactive turn - it does not re-register the controller.
 *
 * Pure-EventEmitter API: the controller takes an `EventEmitter` and a
 * handful of pure-function callbacks, with no electron / electron-store
 * imports. Unit tests can wire it up against `new EventEmitter()` and
 * Vitest spies without booting Electron.
 */

import { EventEmitter } from 'events';

/**
 * Per-session replay context, captured when an interactive turn is spawned.
 *
 * `prompt` is the user-message text the interactive turn was launched with -
 * the controller passes it back into the API-mode replay so the user's
 * intent is preserved through the mode swap.
 *
 * `buildApiSpawnConfig()` is invoked at replay time (not at registration
 * time) so the closure can pick up the latest `agentSessionId` that
 * `maestro-p`'s session-id watcher discovered mid-turn and inject it via
 * `--resume`. It must strip `MAESTRO_CLAUDE_BIN` from the env, since API
 * mode invokes the real `claude` binary directly without going through
 * the wrapper. Returning `null` skips the spawn step (e.g. when the
 * caller has since destroyed the session).
 */
export interface InteractiveReplayContext<TSpawnConfig> {
	/** Canonical `CLAUDE_CONFIG_DIR` key for the snapshot lookup. */
	configDirKey: string;
	/** The user's prompt that triggered the failed interactive turn. */
	prompt: string;
	/** Build the API-mode spawn config at replay time. */
	buildApiSpawnConfig(replay: { prompt: string }): TSpawnConfig | null;
}

/** State mutation written through to the persistent session record. */
export interface SessionInteractiveUpdate {
	mode: 'interactive' | 'api';
	modeReason: 'auto' | 'limit';
	lastUsageSnapshotKey: string;
}

/** Payload re-emitted on `process:claude-mode-resolved` after the fallback. */
export interface ResolvedResolution {
	mode: 'interactive' | 'api';
	reason: 'auto' | 'limit';
	configDirKey: string;
}

/** Minimal logger shape - passed in so we don't import the main-process logger. */
export interface ReplayLogger {
	debug?(message: string, ...args: unknown[]): void;
	info?(message: string, ...args: unknown[]): void;
	warn?(message: string, ...args: unknown[]): void;
}

export interface InteractiveReplayDeps<TSpawnConfig> {
	/** The `ProcessManager` (or any EventEmitter) emitting `exit` events. */
	emitter: EventEmitter;
	/**
	 * Trigger an immediate `sampleUsage()` refresh for the relevant config
	 * dir. Failures must not abort the replay flow - a stale snapshot is
	 * acceptable so long as the user's prompt still lands.
	 */
	sampleUsage(configDirKey: string): Promise<void>;
	/** Persist the post-fallback claudeInteractive state to the session record. */
	updateSessionInteractive(sessionId: string, update: SessionInteractiveUpdate): void;
	/**
	 * Re-emit `process:claude-mode-resolved` to the renderer so the badge
	 * flips immediately, before the replay spawn lands.
	 */
	emitModeResolved(sessionId: string, resolution: ResolvedResolution): void;
	/** Spawn the API-mode replay using the freshly-built spawn config. */
	spawnReplay(sessionId: string, config: TSpawnConfig): void;
	/** Optional diagnostics sink. */
	logger?: ReplayLogger;
}

export interface InteractiveReplayController<TSpawnConfig> {
	/**
	 * Register a replay context for the given session. If a prior context
	 * is already registered for the same session, it is replaced and its
	 * `exit` listener is detached (re-registration replacement).
	 */
	registerInteractiveReplay(
		sessionId: string,
		context: InteractiveReplayContext<TSpawnConfig>
	): void;
	/** Detach the listener and forget the context. Idempotent. */
	clearInteractiveReplay(sessionId: string): void;
	/** True when the given session currently has a replay context registered. */
	hasInteractiveReplay(sessionId: string): boolean;
}

/** Exit code emitted by `maestro-p` when the Max-plan quota is hit mid-turn. */
export const LIMIT_EXIT_CODE = 2;

/**
 * Create a stateful controller bound to the given EventEmitter. Multiple
 * controllers can coexist (e.g. tests can instantiate fresh ones per case);
 * each maintains its own listener registry and unregisters cleanly via
 * `clearInteractiveReplay`.
 */
export function createInteractiveReplayController<TSpawnConfig>(
	deps: InteractiveReplayDeps<TSpawnConfig>
): InteractiveReplayController<TSpawnConfig> {
	const contexts = new Map<string, InteractiveReplayContext<TSpawnConfig>>();
	const handlersBySessionId = new Map<string, (eventSessionId: string, code: number) => void>();

	function clearInteractiveReplay(sessionId: string): void {
		const handler = handlersBySessionId.get(sessionId);
		if (handler) {
			deps.emitter.removeListener('exit', handler);
			handlersBySessionId.delete(sessionId);
		}
		contexts.delete(sessionId);
	}

	function registerInteractiveReplay(
		sessionId: string,
		context: InteractiveReplayContext<TSpawnConfig>
	): void {
		// Re-registration replacement: drop any prior listener+context for
		// this session before attaching the new one.
		clearInteractiveReplay(sessionId);
		contexts.set(sessionId, context);

		const handler = (eventSessionId: string, code: number): void => {
			if (eventSessionId !== sessionId) return;

			// Pop the context AND detach the listener up front so duplicate
			// `exit` re-emits (or a `clearInteractiveReplay` call racing the
			// flow) cannot re-trigger the replay.
			const ctx = contexts.get(sessionId);
			clearInteractiveReplay(sessionId);
			if (!ctx) return;

			if (code !== LIMIT_EXIT_CODE) {
				deps.logger?.debug?.('[ClaudeInteractiveReplay] Non-limit exit; replay skipped', {
					sessionId,
					code,
				});
				return;
			}

			// Fire the replay flow without awaiting it on the exit emit. The
			// `exit` listener contract is synchronous; the replay's async
			// hops (sample, write, emit, spawn) shouldn't back up other
			// listeners. Errors are caught inside `runReplay`.
			void runReplay(sessionId, ctx);
		};

		handlersBySessionId.set(sessionId, handler);
		deps.emitter.on('exit', handler);
	}

	function hasInteractiveReplay(sessionId: string): boolean {
		return contexts.has(sessionId);
	}

	async function runReplay(
		sessionId: string,
		ctx: InteractiveReplayContext<TSpawnConfig>
	): Promise<void> {
		// (a) Refresh the usage snapshot in the BACKGROUND. It only feeds the usage
		// dashboard and the next turn's resolver - the replay spawn below does not
		// depend on it. Awaiting it here blocked re-sending the user's prompt on a
		// `maestro-p --status` spawn (which can take ~30s), so a limit-hit Dynamic
		// turn looked like it produced no response for half a minute after the
		// mode-switch banner. Fire-and-forget so the API replay spawns immediately.
		// Wrapped in Promise.resolve().then() so a SYNCHRONOUS throw from
		// sampleUsage funnels into the same .catch() as an async rejection - a bare
		// `sampleUsage().catch()` would let a sync throw escape as an unhandled error.
		void Promise.resolve()
			.then(() => deps.sampleUsage(ctx.configDirKey))
			.catch((err) => {
				deps.logger?.warn?.('[ClaudeInteractiveReplay] sampleUsage threw (background)', {
					sessionId,
					configDirKey: ctx.configDirKey,
					error: err instanceof Error ? err.message : String(err),
				});
			});

		const update: SessionInteractiveUpdate = {
			mode: 'api',
			modeReason: 'limit',
			lastUsageSnapshotKey: ctx.configDirKey,
		};

		// (b) Write-through the session state. Wrapped because a corrupt
		// sessionsStore shouldn't take down the replay flow either.
		try {
			deps.updateSessionInteractive(sessionId, update);
		} catch (err) {
			deps.logger?.warn?.('[ClaudeInteractiveReplay] updateSessionInteractive threw', {
				sessionId,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// (c) Re-emit mode-resolved so the renderer badge flips ahead of the
		// replay spawn landing.
		try {
			deps.emitModeResolved(sessionId, {
				mode: 'api',
				reason: 'limit',
				configDirKey: ctx.configDirKey,
			});
		} catch (err) {
			deps.logger?.warn?.('[ClaudeInteractiveReplay] emitModeResolved threw', {
				sessionId,
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// (d) Build the api-mode spawn config from the caller's closure and
		// hand it to spawnReplay. The closure picks up the latest
		// agentSessionId discovered mid-turn.
		let apiConfig: TSpawnConfig | null;
		try {
			apiConfig = ctx.buildApiSpawnConfig({ prompt: ctx.prompt });
		} catch (err) {
			deps.logger?.warn?.('[ClaudeInteractiveReplay] buildApiSpawnConfig threw; replay aborted', {
				sessionId,
				error: err instanceof Error ? err.message : String(err),
			});
			return;
		}
		if (!apiConfig) {
			deps.logger?.info?.(
				'[ClaudeInteractiveReplay] buildApiSpawnConfig returned null; replay skipped',
				{ sessionId }
			);
			return;
		}

		try {
			deps.spawnReplay(sessionId, apiConfig);
			deps.logger?.info?.('[ClaudeInteractiveReplay] Replay spawned under API mode', {
				sessionId,
				configDirKey: ctx.configDirKey,
			});
		} catch (err) {
			deps.logger?.warn?.('[ClaudeInteractiveReplay] spawnReplay threw', {
				sessionId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return {
		registerInteractiveReplay,
		clearInteractiveReplay,
		hasInteractiveReplay,
	};
}
