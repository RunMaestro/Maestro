import { captureException } from '../utils/sentry';
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
	TtsrMatchedPayload,
	TtsrProjectSettings,
	TtsrRulesChangedPayload,
	TtsrTriggeredPayload,
} from '../../shared/ttsr-types';
import { DEFAULT_TTSR_PROJECT_SETTINGS } from '../../shared/ttsr-types';
import type { ParsedEvent } from '../parsers/agent-output-parser';
import { loadTtsrConfigDetailed, type LoadTtsrConfigResult } from './config/ttsr-config-loader';
import { renderTtsrInterrupt, renderTtsrReminder } from './ttsr-injection';
import { canonicalJson } from '../../shared/canonicalJson';
import { generateUUID } from '../../shared/uuid';
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
	 * Observability sink for `ttsr:matched`. Wired to `safeSend`; every renderer
	 * counts the push into its TTSR store and the Right Bar Rules panel shows it
	 * as the per-rule match line, which is the only trace a non-interrupting
	 * match leaves.
	 */
	onMatched?(payload: TtsrMatchedPayload): void;
	/** Offers guidance to the existing renderer queue/Steer owner; never stops a process. */
	onTriggered?(payload: TtsrTriggeredPayload): void;
	/**
	 * Sink for `ttsr:rulesChanged`, fired whenever a project's cached rules are
	 * dropped (watcher event or a write through the IPC handlers). The Rules panel
	 * lists on mount only, so without this it shows a stale list right after the
	 * agent finishes authoring a rule - the one moment the user is watching it.
	 */
	onRulesChanged?(payload: TtsrRulesChangedPayload): void;
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

/**
 * A non-destructive read of a conversation's deferred reminders: the rendered
 * block, and the commit that clears exactly what was rendered.
 */
export interface TtsrReminderDrain {
	/** Rendered `<system-reminder>` block, or `''` when nothing is queued. */
	text: string;
	/** Clear the queue. Safe to call more than once; a no-op when `text` is `''`. */
	commit(): void;
	/** Release this preparation on every failed/abandoned spawn. */
	rollback(): void;
}

/** Shared empty drain, so the common "nothing queued" path allocates nothing. */
const NO_REMINDERS: TtsrReminderDrain = { text: '', commit: () => {}, rollback: () => {} };

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
	/** Unclaimed guidance stays in the manager's deferred queue. One offer per live turn. */
	private readonly steeringOffers = new Map<
		string,
		{ requestId: string; meta: TtsrSpawnMeta; matches: TtsrMatch[] }
	>();

	private readonly preparing = new Set<TtsrMatch>();

	private readonly cache = new Map<string, RuleCacheEntry>();
	/** One rule-file watcher per project root, closed on {@link dispose}. */
	private readonly watchers = new Map<string, () => void>();
	private readonly loadConfig: (projectRoot: string) => LoadTtsrConfigResult;
	private detach: (() => void) | null = null;
	/** In-flight `astCondition` passes, awaited by {@link flushAst}. */
	private readonly pendingAst = new Set<Promise<TtsrMatch[]>>();

	constructor(private readonly deps: TtsrRuntimeDeps) {
		this.loadConfig = deps.loadConfig ?? loadTtsrConfigDetailed;
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
	 * the matches for tests;
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
			isCurrent: () => this.registry.get(sessionId) === meta && this.deps.isGloballyEnabled(),
			resolved: { enabled: entry.settings.enabled, rules: entry.rules },
		};
		const matches = this.manager.observe(sessionId, event, observeCtx);

		// Structural matching is parsed off the stream's synchronous path; hits
		// land in the manager's buckets, drained by `drive` once they settle.
		if (this.manager.needsAstCheck(event, observeCtx)) {
			const pending = this.manager
				.observeAst(sessionId, event, observeCtx)
				.catch((err: unknown) => {
					captureException(err, { operation: 'ttsr:ast', sessionId });
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
			// A reclaimed process ID may have no preceding exit. Revoke any old
			// authority even while disabled; this creates no new TTSR state.
			this.registry.clear(config.sessionId);
			this.manager.dispose(config.sessionId);
			this.steeringOffers.delete(config.sessionId);
			// The gate comes first: with TTSR off, registering the turn would create
			// conversation state and advance counters (and so schedule a write of
			// `ttsr-state.json`) for a feature that can never fire. A turn spawned
			// while off simply goes untracked, even if the flag flips mid-turn.
			if (!this.deps.isGloballyEnabled()) return;
			const meta = this.registry.noteSpawn(config);
			if (!meta) return;
			this.manager.beginTurn(meta.sessionId, meta.providerSessionId);
			this.steeringOffers.delete(meta.sessionId);
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
			this.steeringOffers.delete(sessionId);
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
	 * Settle every in-flight structural match.
	 *
	 * Test-support surface for asynchronous structural matching; correction
	 * handoff itself uses the existing renderer queue and native Steer lifecycle.
	 */
	async flushAst(): Promise<void> {
		while (this.pendingAst.size > 0) {
			await Promise.all([...this.pendingAst]);
		}
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
	 *
	 * One-shot: use it only where nothing can fail after the read. The spawn path
	 * cannot (context resolution, SSH wrapping and the spawn itself all throw), so
	 * it uses {@link TtsrRuntime.peekDeferredReminders} instead.
	 */
	takeDeferredReminders(sessionId: string): string {
		const { text, commit } = this.peekDeferredReminders(sessionId);
		commit();
		return text;
	}

	/**
	 * Transactional counterpart to {@link TtsrRuntime.takeDeferredReminders}: the
	 * rendered block plus the commit that clears exactly what it rendered.
	 *
	 * The spawn path builds its prompt from `text`, then calls `commit` only once
	 * the process has actually been spawned. Anything that throws in between -
	 * Claude context resolution, the fail-loud SSH resolver, the spawn itself -
	 * leaves the queue intact, so guidance from an `interruptMode: never` rule
	 * rides the next attempt instead of being silently destroyed.
	 *
	 * `commit` is idempotent: a spawn path that retries internally may call it
	 * more than once without eating a second batch of reminders.
	 */
	peekDeferredReminders(sessionId: string): TtsrReminderDrain {
		if (!this.deps.isGloballyEnabled()) return NO_REMINDERS;
		const queued = this.manager.peekDeferred(sessionId);
		const inactive = queued.filter((match) => !this.isActiveMatch(match));
		this.manager.discardDeferred(sessionId, inactive);
		const matches = queued.filter(
			(match) => !inactive.includes(match) && !this.preparing.has(match)
		);
		if (matches.length === 0) return NO_REMINDERS;
		for (const match of matches) this.preparing.add(match);
		this.manager.holdDeferred(matches);
		// Offers use raw turn IDs, reminders use the tab conversation. Revoke
		// every intersecting offer, including canonical/forced-parallel aliases.
		for (const [id, offer] of this.steeringOffers) {
			if (offer.matches.some((match) => this.preparing.has(match))) this.steeringOffers.delete(id);
		}
		let settled = false;
		const release = () => {
			for (const match of matches) this.preparing.delete(match);
			this.manager.releaseDeferred(matches);
		};
		return {
			text: renderTtsrReminder(matches),
			commit: () => {
				if (settled) return;
				settled = true;
				this.manager.commitDeferred(sessionId, matches);
				release();
				this.deps.persistence?.flush();
				logger.info('TTSR reminders folded into next prompt', LOG_CONTEXT, {
					sessionId,
					rules: matches.map((match) => match.rule.name),
				});
			},
			rollback: () => {
				if (settled) return;
				settled = true;
				release();
			},
		};
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
		this.steeringOffers.clear();
		for (const close of this.watchers.values()) close();
		this.watchers.clear();
		this.cache.clear();
		this.deps.persistence?.flush();
		this.deps.persistence?.dispose();
	}

	/**
	 * Drop cached rules so the next event re-reads them (rule file edited).
	 *
	 * Also the single place `ttsr:rulesChanged` is announced from: every path that
	 * changes a project's rules - the file watcher, a panel write, the agent
	 * writing a rule file itself - already funnels through here.
	 */
	invalidateRules(projectRoot?: string): void {
		if (projectRoot) this.cache.delete(projectRoot);
		else this.cache.clear();
		this.deps.onRulesChanged?.({ projectRoot });
	}

	// ── internals ──

	/**
	 * Transfer one offer to a HELD native queue item. Until this succeeds the
	 * original matches remain deferred, so a missing/reloading renderer loses no
	 * guidance. The renderer persists its held item before claiming, then hands it
	 * to steerQueuedItem(), which owns delivery, refusal, exits and reloads.
	 */
	claimSteeringRequest(sessionId: string, requestId: string): boolean {
		const offer = this.steeringOffers.get(sessionId);
		if (!offer || offer.requestId !== requestId) return false;
		if (!this.deps.isGloballyEnabled() || this.registry.get(sessionId) !== offer.meta) return false;
		const entry = this.entry(offer.meta.projectRoot);
		if (
			!entry.settings.enabled ||
			!offer.matches.every((match) => !this.preparing.has(match) && this.isActiveMatch(match)) ||
			!this.manager.canInterrupt(sessionId)
		)
			return false;
		this.steeringOffers.delete(sessionId);
		if (!this.manager.claimDeferred(sessionId, offer.matches)) return false;
		this.manager.noteInterrupt(sessionId);
		this.deps.persistence?.flush();
		return true;
	}

	/** Rule edits invalidate old guidance; a fresh match uses the new definition. */
	private isActiveMatch(match: TtsrMatch): boolean {
		if (!match.projectRoot) return true;
		const entry = this.entry(match.projectRoot);
		return (
			entry.settings.enabled &&
			entry.rules.some(
				(rule) =>
					rule === match.rule ||
					canonicalJson({ ...rule, compiledCondition: undefined }) ===
						canonicalJson({ ...match.rule, compiledCondition: undefined })
			)
		);
	}

	/** Offer matching guidance through native Steer, retaining it until claimed. */
	private drive(sessionId: string, meta: TtsrSpawnMeta): void {
		if (this.registry.get(sessionId) !== meta) return;
		const matches = this.manager
			.takeInterrupts(sessionId)
			.filter((match) => !this.preparing.has(match));
		if (matches.length === 0) return;
		this.manager.deferMatches(sessionId, matches);
		if (
			!this.deps.onTriggered ||
			this.steeringOffers.has(sessionId) ||
			!this.manager.canInterrupt(sessionId)
		)
			return;
		const requestId = generateUUID();
		this.steeringOffers.set(sessionId, { requestId, meta, matches });
		try {
			this.deps.onTriggered({
				sessionId,
				tabId: meta.tabId,
				agentId: meta.agentId,
				rules: matches.map(({ rule }) => ({ name: rule.name, path: rule.path })),
				injectionPrompt: renderTtsrInterrupt(matches),
				requestId,
			});
		} catch (error) {
			this.steeringOffers.delete(sessionId);
			captureException(error, { operation: 'ttsr:offerSteering', sessionId });
		}
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
			captureException(err, { operation: 'ttsr:load', projectRoot });
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
