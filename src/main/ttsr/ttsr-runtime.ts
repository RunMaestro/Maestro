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
	TtsrAbortPendingPayload,
	TtsrMatchedPayload,
	TtsrProjectSettings,
	TtsrTriggeredPayload,
} from '../../shared/ttsr-types';
import { DEFAULT_TTSR_PROJECT_SETTINGS } from '../../shared/ttsr-types';
import type { ParsedEvent } from '../parsers/agent-output-parser';
import { loadTtsrConfigDetailed, type LoadTtsrConfigResult } from './config/ttsr-config-loader';
import { renderTtsrReminder } from './ttsr-injection';
import { TtsrInterruptDriver, type TtsrInterruptTarget } from './ttsr-interrupt-driver';
import { TtsrManager, type TtsrMatch } from './ttsr-manager';
import type { TtsrStatePersistence } from './ttsr-state-persistence';
import { TtsrStateStore } from './ttsr-state-store';
import {
	TtsrSpawnRegistry,
	type TtsrProcessEventSource,
	type TtsrSpawnConfigLike,
	type TtsrSpawnMeta,
} from './ttsr-spawn-registry';

const LOG_CONTEXT = 'TTSR';

/**
 * How long a project's rule set is reused before it is re-read from disk. Long
 * enough that a chatty turn never re-reads, short enough that editing a rule
 * takes effect within a turn or two without a config watcher per project.
 */
const RULE_CACHE_TTL_MS = 5_000;

export interface TtsrRuntimeDeps {
	/**
	 * The global gate: `settings.ttsrEnabled && encoreFeatures.ttsr`. Read live
	 * on every event so toggling the Encore feature takes effect without a
	 * restart, exactly like the OpenCode-server plugin gate.
	 */
	isGloballyEnabled(): boolean;
	/** Rule names the user disabled globally (`ttsrDisabledRules` setting). */
	getDisabledRules?(): string[];
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
	/** Test override for how long an abort waits on the turn's `exit`. */
	exitTimeoutMs?: number;
	/** Swappable for tests; defaults to the real disk loader. */
	loadConfig?(projectRoot: string): LoadTtsrConfigResult;
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
	loadedAt: number;
}

export class TtsrRuntime {
	readonly registry = new TtsrSpawnRegistry();
	readonly manager: TtsrManager;
	/** Main-authoritative repeat/injection state (Gate B), persisted when wired. */
	readonly stateStore: TtsrStateStore;
	/** Null while no abort surface was injected (detection-only runtime). */
	readonly driver: TtsrInterruptDriver | null;

	private readonly cache = new Map<string, RuleCacheEntry>();
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

		const observeCtx = {
			agentId: meta.agentId,
			cwd: meta.projectRoot,
			providerSessionId: meta.providerSessionId,
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
			const meta = this.registry.noteSpawn(config);
			if (meta) this.manager.beginTurn(meta.sessionId, meta.providerSessionId);
		};
		const onSessionId = (sessionId: string, providerSessionId: string) => {
			if (!this.registry.get(sessionId)) return;
			this.registry.noteProviderSessionId(sessionId, providerSessionId);
			this.manager.setProviderSessionId(sessionId, providerSessionId);
		};
		const onExit = (sessionId: string) => {
			const meta = this.registry.get(sessionId);
			if (!meta) return;
			// Unblocks a driver waiting on this abort. Must run before the registry
			// entry is dropped so the corrective payload still has its spawn meta.
			this.driver?.noteExit(sessionId);
			// Advances the turn counter `after-gap` eligibility is measured in and
			// drops this turn's buffers. Deferred reminders deliberately survive:
			// they are consumed by the next prompt, not by the turn that queued them.
			this.manager.endTurn(sessionId, { agentId: meta.agentId, cwd: meta.projectRoot });
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

		const pending = this.driver
			.trigger({
				sessionId,
				meta,
				matches,
				contextMode: this.entry(meta.projectRoot).settings.contextMode,
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

	/** Cached rules + settings for a project root, reloaded past the TTL. */
	private entry(projectRoot: string): RuleCacheEntry {
		const cached = this.cache.get(projectRoot);
		if (cached && Date.now() - cached.loadedAt < RULE_CACHE_TTL_MS) return cached;

		let entry: RuleCacheEntry;
		try {
			const result = this.loadConfig(projectRoot);
			const globallyDisabled = new Set(this.deps.getDisabledRules?.() ?? []);
			entry = {
				rules: result.rules.filter((rule) => !globallyDisabled.has(rule.name)),
				settings: result.settings,
				loadedAt: Date.now(),
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
				loadedAt: Date.now(),
			};
		}

		this.cache.set(projectRoot, entry);
		return entry;
	}
}
