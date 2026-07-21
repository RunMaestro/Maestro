/**
 * TTSR runtime facade - what main actually installs.
 *
 * Composes the pieces built in Phase 2 into one object with a lifecycle:
 * - the {@link TtsrSpawnRegistry}, fed from ProcessManager's public
 *   `spawn` / `session-id` / `exit` events,
 * - a per-project rule cache over `loadTtsrConfigDetailed`, so the matcher
 *   never touches the filesystem on the hot path,
 * - the {@link TtsrManager}, which owns buffers, matching, and repeat policy.
 *
 * The only thing the process manager sees is {@link TtsrRuntime.observe},
 * handed to it as an injected callback (`ProcessManager.setParsedEventObserver`).
 * Nothing under `src/main/process-manager/` imports TTSR.
 */

import { logger } from '../utils/logger';
import type {
	LoadedTtsrRule,
	TtsrAbortClearedPayload,
	TtsrAbortPendingPayload,
	TtsrContextMode,
	TtsrMatchedPayload,
	TtsrProjectSettings,
	TtsrTriggeredPayload,
} from '../../shared/ttsr-types';
import { DEFAULT_TTSR_CONTEXT_MODE, DEFAULT_TTSR_PROJECT_SETTINGS } from '../../shared/ttsr-types';
import type { ParsedEvent } from '../parsers/agent-output-parser';
import { loadTtsrConfigDetailed, type LoadTtsrConfigResult } from './config/ttsr-config-loader';
import { renderTtsrReminder } from './ttsr-injection';
import { TtsrInterruptDriver, type TtsrInterruptTarget } from './ttsr-interrupt-driver';
import { TtsrManager, type TtsrMatch, type TtsrObserveContext } from './ttsr-manager';
import type { TtsrStatePersistence } from './ttsr-state-persistence';
import { TtsrStateStore } from './ttsr-state-store';
import {
	TtsrSpawnRegistry,
	type TtsrProcessEventSource,
	type TtsrSpawnConfigLike,
	type TtsrSpawnMeta,
} from './ttsr-spawn-registry';

const LOG_CONTEXT = 'TTSR';

export interface TtsrRuntimeDeps {
	/**
	 * The global gate: `settings.ttsrEnabled && encoreFeatures.ttsr`. Read live
	 * on every event so toggling the Encore feature takes effect without a
	 * restart, exactly like the OpenCode-server plugin gate.
	 */
	isGloballyEnabled(): boolean;
	/** Rule names the user disabled globally (`ttsrDisabledRules` setting). */
	getDisabledRules?(): string[];
	/**
	 * The global `ttsrContextMode` setting, used as the teardown mode for any
	 * project whose `.maestro/ttsr.yaml` does not name one of its own. A project
	 * that does name one still wins - it is the more specific statement.
	 */
	getContextMode?(): TtsrContextMode;
	/** Observability sink for `ttsr:matched`. Wired to `safeSend` in Phase 4. */
	onMatched?(payload: TtsrMatchedPayload): void;
	/**
	 * The process manager's abort surface. Omit it and the runtime stays
	 * detection-only (Phase 2 behaviour) - matches are reported but no turn is
	 * ever interrupted.
	 */
	interruptTarget?: TtsrInterruptTarget;
	/**
	 * Sink for `ttsr:triggered`. Required alongside `interruptTarget`: aborting a
	 * turn without telling the renderer to respawn it would strand the agent.
	 */
	onTriggered?(payload: TtsrTriggeredPayload): void;
	/**
	 * Sink for `ttsr:abortPending`, fired the moment a turn is signalled so the
	 * renderer stops treating the imminent exit as a failed turn.
	 */
	onAbortPending?(payload: TtsrAbortPendingPayload): void;
	/**
	 * Sink for `ttsr:abortCleared`, fired when an announced abort will not
	 * produce a corrective turn after all, so the renderer stops suppressing
	 * that turn's exit handling.
	 */
	onAbortCleared?(payload: TtsrAbortClearedPayload): void;
	/** Test override for how long an abort waits on the turn's `exit`. */
	exitTimeoutMs?: number;
	/** Swappable for tests; defaults to the real disk loader. */
	loadConfig?(projectRoot: string): LoadTtsrConfigResult;
	/**
	 * Watch a project's rule files, invalidating its cache entry on change.
	 * Injected rather than defaulted: the cache is otherwise held for the life of
	 * the runtime, so production MUST pass `watchTtsrConfig` (installTtsrRuntime
	 * does), while tests with a synthetic loader want no filesystem watcher at
	 * all.
	 */
	watchConfig?(projectRoot: string, onChange: () => void): () => void;
	/**
	 * Disk persistence for repeat/injection bookkeeping. Omit it and the runtime
	 * keeps that state in memory only, so `once` and `after-gap` reset with the
	 * process (fine for tests, wrong for production).
	 */
	persistence?: TtsrStatePersistence;
}

interface RuleCacheEntry {
	rules: LoadedTtsrRule[];
	settings: TtsrProjectSettings;
	/**
	 * The `ttsrDisabledRules` setting this entry was filtered with. Disk changes
	 * are picked up by the watcher, but a settings change has no file event, so
	 * the entry is rebuilt when this no longer matches. Held as the list itself
	 * rather than a joined key: this is compared on the hot path, and building a
	 * string there would allocate per event.
	 */
	disabled: readonly string[];
}

/** Cheap equality for the disabled-rule list: same reference, else same names. */
function sameDisabledList(a: readonly string[], b: readonly string[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

export class TtsrRuntime {
	readonly registry = new TtsrSpawnRegistry();
	readonly manager: TtsrManager;
	/** Main-authoritative repeat/injection state (Gate B), persisted when wired. */
	readonly stateStore: TtsrStateStore;
	/** Null while no abort surface was injected (detection-only runtime). */
	readonly driver: TtsrInterruptDriver | null;

	private readonly cache = new Map<string, RuleCacheEntry>();
	/** One rule-file watcher per project root, closed on {@link dispose}. */
	private readonly watchers = new Map<string, () => void>();
	private readonly loadConfig: (projectRoot: string) => LoadTtsrConfigResult;
	private detach: (() => void) | null = null;
	/** In-flight `astCondition` passes, awaited by {@link flushAst}. */
	private readonly pendingAst = new Set<Promise<TtsrMatch[]>>();
	/** In-flight aborts, awaited by {@link flushInterrupts}. */
	private readonly pendingInterrupts = new Set<Promise<unknown>>();

	constructor(private readonly deps: TtsrRuntimeDeps) {
		this.loadConfig = deps.loadConfig ?? loadTtsrConfigDetailed;
		const onTriggered = deps.onTriggered;
		this.driver =
			deps.interruptTarget && onTriggered
				? new TtsrInterruptDriver({
						target: deps.interruptTarget,
						onTriggered: (payload) => onTriggered(payload),
						onAbortPending: deps.onAbortPending
							? (payload) => deps.onAbortPending?.(payload)
							: undefined,
						onAbortCleared: deps.onAbortCleared
							? (payload) => deps.onAbortCleared?.(payload)
							: undefined,
						exitTimeoutMs: deps.exitTimeoutMs,
					})
				: null;
		// Repeat bookkeeping is loaded from disk before the first event is observed,
		// so a rule that already fired in a previous run stays fired (plan 3d).
		const persistence = deps.persistence;
		const stateStore = new TtsrStateStore({
			onChange: persistence ? () => persistence.scheduleSave(stateStore) : undefined,
		});
		persistence?.hydrate(stateStore);
		this.stateStore = stateStore;
		this.manager = new TtsrManager({
			store: stateStore,
			// Fallbacks only: `observe` resolves both once per event and threads the
			// pair through the context, so nothing on the hot path reaches these.
			getRules: (projectRoot) => this.entry(projectRoot).rules,
			isEnabled: (projectRoot) =>
				this.deps.isGloballyEnabled() && this.entry(projectRoot).settings.enabled,
			onMatched: deps.onMatched ? (payload) => deps.onMatched?.(payload) : undefined,
		});
	}

	/**
	 * The callback handed to `ProcessManager.setParsedEventObserver`. Returns
	 * the matches so tests (and Phase 3's interrupt driver) can act on them;
	 * the process manager ignores the return value.
	 *
	 * Short-circuits before any work when TTSR is off or when the turn was not
	 * registered (terminal spawns, unknown agents).
	 */
	observe(sessionId: string, event: ParsedEvent): TtsrMatch[] {
		if (!this.deps.isGloballyEnabled()) return [];
		const meta = this.registry.get(sessionId);
		if (!meta) return [];

		// Resolved once for the whole pass and threaded into every manager call:
		// each resolution costs a rule-cache lookup plus a disabled-list read, and
		// the manager callbacks would otherwise re-ask 6-9 times per event.
		const entry = this.entry(meta.projectRoot);
		const observeCtx: TtsrObserveContext = {
			agentId: meta.agentId,
			cwd: meta.projectRoot,
			providerSessionId: meta.providerSessionId,
			resolved: { enabled: entry.settings.enabled, rules: entry.rules },
		};
		const matches = this.manager.observe(sessionId, event, observeCtx);

		// Structural matching is parsed off the stream's synchronous path; hits
		// land in the manager's buckets, drained by `drive` once they settle.
		if (this.manager.needsAstCheck(event, observeCtx)) {
			const pending = this.manager
				.observeAst(sessionId, event, observeCtx)
				.catch((err: unknown) => {
					logger.warn('TTSR AST pass failed', LOG_CONTEXT, {
						sessionId,
						error: err instanceof Error ? err.message : String(err),
					});
					return [] as TtsrMatch[];
				})
				.finally(() => {
					this.pendingAst.delete(pending);
					this.drive(sessionId, meta);
				});
			this.pendingAst.add(pending);
		}

		// The manager learns the provider id from the stream's `init` event; mirror
		// it onto the registry so the reinject payload reads one source.
		if (event.type === 'init' && event.sessionId) {
			this.registry.noteProviderSessionId(sessionId, event.sessionId);
		}

		this.drive(sessionId, meta);
		return matches;
	}

	/**
	 * Subscribe to a ProcessManager's turn lifecycle. Returns a detach function;
	 * calling `attach` twice detaches the previous subscription first.
	 */
	attach(source: TtsrProcessEventSource): () => void {
		this.detach?.();

		const onSpawn = (config: TtsrSpawnConfigLike) => {
			// The gate comes first: with TTSR off, registering the turn would create
			// conversation state and advance counters (and so schedule a write of
			// `ttsr-state.json`) for a feature that can never fire. A turn spawned
			// while off simply goes untracked, even if the flag flips mid-turn.
			if (!this.deps.isGloballyEnabled()) return;
			const meta = this.registry.noteSpawn(config);
			if (!meta) return;
			this.manager.beginTurn(meta.sessionId, meta.providerSessionId);
			// Warm the rule cache here, off the stdout hot path: loading is
			// synchronous disk I/O (readdir + read + YAML parse + regex compile per
			// rule file), and doing it lazily would put that first read inside
			// `StdoutHandler.handleParsedEvent`.
			this.entry(meta.projectRoot);
		};
		const onSessionId = (sessionId: string, providerSessionId: string) => {
			if (!this.registry.get(sessionId)) return;
			this.registry.noteProviderSessionId(sessionId, providerSessionId);
			this.manager.setProviderSessionId(sessionId, providerSessionId);
		};
		const onExit = (sessionId: string) => {
			const meta = this.registry.get(sessionId);
			if (!meta) return;
			// Unblocks a driver waiting on this abort. Runs before the gate check so
			// an abort announced while TTSR was on still completes rather than
			// leaving the renderer with an orphaned `ttsr:abortPending`, and before
			// the registry entry is dropped so the corrective payload keeps its meta.
			this.driver?.noteExit(sessionId);
			// Turned off mid-turn: release the turn without advancing the counter or
			// otherwise touching persisted state.
			if (!this.deps.isGloballyEnabled()) {
				this.manager.dispose(sessionId);
				this.registry.clear(sessionId);
				return;
			}
			// Advances the turn counter `after-gap` eligibility is measured in and
			// drops this turn's buffers. Deferred reminders deliberately survive:
			// they are consumed by the next prompt, not by the turn that queued them.
			this.manager.endTurn(sessionId);
			// Nothing left to say to this conversation: drop its state rather than
			// retain an entry per turn (Auto Run mints a fresh session id per task).
			if (!this.manager.hasDeferred(sessionId)) this.manager.dispose(sessionId);
			this.registry.clear(sessionId);
		};

		source.on('spawn', onSpawn);
		source.on('session-id', onSessionId);
		source.on('exit', onExit);

		this.detach = () => {
			source.off('spawn', onSpawn as (...args: unknown[]) => void);
			source.off('session-id', onSessionId as (...args: unknown[]) => void);
			source.off('exit', onExit as (...args: unknown[]) => void);
			this.detach = null;
		};
		return this.detach;
	}

	/**
	 * Settle every in-flight structural match. Phase 3 awaits this before acting
	 * on a turn's interrupts so an AST hit is not missed by a race with `exit`;
	 * tests use it to make the async pass deterministic.
	 */
	async flushAst(): Promise<void> {
		while (this.pendingAst.size > 0) {
			await Promise.all([...this.pendingAst]);
		}
	}

	/**
	 * Settle every in-flight abort. Tests await it to observe the corrective
	 * payload; production never needs it (the driver resolves on `exit`).
	 */
	async flushInterrupts(): Promise<void> {
		while (this.pendingInterrupts.size > 0) {
			await Promise.all([...this.pendingInterrupts]);
		}
	}

	/** True while a TTSR abort is in flight for this turn (`ttsrAbortPending`). */
	isAbortPending(sessionId: string): boolean {
		return this.driver?.isAbortPending(sessionId) ?? false;
	}

	/**
	 * Drain this conversation's deferred reminders as one rendered block, ready
	 * to be prepended to the next prompt (plan Phase 3c).
	 *
	 * Non-interrupting matches never abort a turn: Maestro has no tool-result
	 * hook to fold guidance into in-band, so the guidance waits here until the
	 * conversation's next prompt is spawned. The read clears the bucket, so a
	 * reminder is delivered exactly once even though the spawn path may call
	 * this for turns that never had a match.
	 *
	 * Returns `''` when nothing is queued (the overwhelmingly common case) so
	 * callers can skip the prepend without a null check.
	 */
	takeDeferredReminders(sessionId: string): string {
		if (!this.deps.isGloballyEnabled()) return '';
		const matches = this.manager.takeDeferred(sessionId);
		if (matches.length === 0) return '';

		logger.info('TTSR reminders folded into next prompt', LOG_CONTEXT, {
			sessionId,
			rules: matches.map((match) => match.rule.name),
		});
		return renderTtsrReminder(matches);
	}

	/**
	 * Write any debounced state change to disk immediately. Called on app quit so
	 * a rule that fired in the last second before shutdown is not forgotten.
	 */
	flushState(): void {
		this.deps.persistence?.flush();
	}

	/** Detach from the process manager and persist whatever is still pending. */
	dispose(): void {
		this.detach?.();
		for (const close of this.watchers.values()) close();
		this.watchers.clear();
		this.cache.clear();
		this.deps.persistence?.flush();
		this.deps.persistence?.dispose();
	}

	/** Drop cached rules so the next event re-reads them (rule file edited). */
	invalidateRules(projectRoot?: string): void {
		if (projectRoot) this.cache.delete(projectRoot);
		else this.cache.clear();
	}

	// ── internals ──

	/**
	 * Drain the manager's interrupt bucket into the driver. Called after every
	 * synchronous observation and after each structural pass settles, so a rule
	 * that fires mid-stream aborts the turn without waiting for it to end.
	 */
	private drive(sessionId: string, meta: TtsrSpawnMeta): void {
		if (!this.driver) return;
		const matches = this.manager.takeInterrupts(sessionId);
		if (matches.length === 0) return;

		// Every abort costs a whole turn, and the agent may simply keep tripping
		// the rule. Past the budget the guidance still lands - as a reminder on the
		// next prompt - but the conversation is left to run to completion.
		if (!this.manager.canInterrupt(sessionId)) {
			logger.warn('TTSR interrupt budget spent, deferring instead', LOG_CONTEXT, {
				sessionId,
				rules: matches.map((match) => match.rule.name),
			});
			this.manager.deferMatches(sessionId, matches);
			return;
		}
		this.manager.noteInterrupt(sessionId);

		const pending = this.driver
			.trigger({
				sessionId,
				meta,
				matches,
				contextMode: this.contextModeFor(meta.projectRoot),
			})
			.then((payload) => {
				// The corrective turn respawns through the normal spawn path, so tell
				// the registry which prompt to expect and what goal it really serves.
				if (payload) {
					this.registry.noteCorrectiveTurn(sessionId, {
						originalPrompt: payload.originalGoal,
						injectionPrompt: payload.injectionPrompt,
					});
				}
				return payload;
			})
			.catch((err: unknown) => {
				logger.error('TTSR interrupt failed', LOG_CONTEXT, {
					sessionId,
					error: err instanceof Error ? err.message : String(err),
				});
				return null;
			})
			.finally(() => this.pendingInterrupts.delete(pending));
		this.pendingInterrupts.add(pending);
	}

	/**
	 * Teardown mode for a project: its own `.maestro/ttsr.yaml` first, then the
	 * global `ttsrContextMode` setting, then the conservative default.
	 */
	private contextModeFor(projectRoot: string): TtsrContextMode {
		return (
			this.entry(projectRoot).settings.contextMode ??
			this.deps.getContextMode?.() ??
			DEFAULT_TTSR_CONTEXT_MODE
		);
	}

	/**
	 * Cached rules + settings for a project root.
	 *
	 * Held until something says otherwise, because this is reached from the
	 * stdout hot path and loading means synchronous disk I/O. Invalidation is
	 * event-driven instead of timed: the rule-file watcher covers disk edits, and
	 * `disabledKey` covers the one input with no file event behind it.
	 */
	private entry(projectRoot: string): RuleCacheEntry {
		const disabled = this.deps.getDisabledRules?.() ?? [];
		const cached = this.cache.get(projectRoot);
		if (cached && sameDisabledList(cached.disabled, disabled)) return cached;

		this.watch(projectRoot);

		let entry: RuleCacheEntry;
		try {
			const result = this.loadConfig(projectRoot);
			const globallyDisabled = new Set(disabled);
			entry = {
				rules: result.rules.filter((rule) => !globallyDisabled.has(rule.name)),
				settings: result.settings,
				disabled,
			};
			// `missing` is the overwhelmingly common case (no rules in the project);
			// only a real config problem is worth a log line.
			if (result.warnings.length > 0 || (!result.ok && result.reason !== 'missing')) {
				logger.warn('TTSR rules loaded with problems', LOG_CONTEXT, {
					projectRoot,
					reason: result.reason,
					errors: result.errors,
					warnings: result.warnings,
				});
			}
		} catch (err) {
			// A broken rule directory must never break the agent's output stream:
			// fall back to "no rules" and keep going. The throw is still reported.
			logger.error('TTSR rule load failed', LOG_CONTEXT, {
				projectRoot,
				error: err instanceof Error ? err.message : String(err),
			});
			entry = {
				rules: [],
				settings: { ...DEFAULT_TTSR_PROJECT_SETTINGS },
				disabled,
			};
		}

		this.cache.set(projectRoot, entry);
		return entry;
	}

	/** Install this project's rule-file watcher once, if one was injected. */
	private watch(projectRoot: string): void {
		if (!this.deps.watchConfig || this.watchers.has(projectRoot)) return;
		try {
			this.watchers.set(
				projectRoot,
				this.deps.watchConfig(projectRoot, () => this.invalidateRules(projectRoot))
			);
		} catch (err) {
			// An unwatchable project (permissions, network path) still gets its
			// rules - they just stop reloading until the app restarts.
			logger.warn('TTSR rule watcher failed to start', LOG_CONTEXT, {
				projectRoot,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}
