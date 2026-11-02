import type { MainLogLevel } from '../../shared/logger-types';
import type { CueQueueDropReason } from '../../shared/cue-log-types';
import type { SessionInfo } from '../../shared/types';
import type { QueuedEvent } from './cue-run-manager';
import { loadCueConfigDetailed, watchCueYaml } from './cue-yaml-loader';
import type { readCueConfigFile } from './config/cue-config-repository';
import {
	createCueEvent,
	DEFAULT_CUE_SETTINGS,
	type CueConfig,
	type CueEvent,
	type CueSubscription,
} from './cue-types';
import { clearGitHubSeenForSubscription } from './cue-db';
import {
	computeOwnershipWarning,
	countActiveSubscriptions,
	selectOwnershipCandidates,
	type SessionState,
} from './cue-session-state';
import type { CueSessionRegistry } from './cue-session-registry';
import { createTriggerSource } from './triggers/cue-trigger-source-registry';
import { passesFilter } from './triggers/cue-trigger-filter';
import { isDurableCueEvent } from './triggers/cue-plugin-trigger-source';
import type { CueScheduleCarry, CueTriggerSource } from './triggers/cue-trigger-source';
import { triggerGroupKey } from '../../shared/cue/trigger-group-key';
import { removeSubscriptionFromYaml, type SelfDestructResult } from './cue-self-destruct';
import { captureException } from '../utils/sentry';

/**
 * Why a session is being initialized. Used to gate `app.startup` triggers,
 * which must fire exactly once per Electron process lifecycle and only when
 * the engine is starting because of a real system boot.
 *
 * - `system-boot`: Electron just launched. app.startup subscriptions fire.
 * - `user-toggle`: User flipped the Cue toggle off and back on. Do NOT fire
 *   app.startup again - that would surprise users who expect toggling to be
 *   idempotent.
 * - `refresh`: A YAML hot-reload re-initialized the session. app.startup
 *   already fired (or didn't) on this process; do not re-fire.
 * - `discovery`: Auto-discovery added a new session after boot. The startup
 *   moment for that session has already passed, so do not fire.
 */
export type SessionInitReason = 'system-boot' | 'user-toggle' | 'refresh' | 'discovery';

export interface InitSessionOptions {
	reason: SessionInitReason;
	/**
	 * Set only by a reload of a loaded session (`refreshSession`), which also
	 * means the reload held the session's queue for this init to settle: the
	 * schedules of the session's running heartbeats, keyed by
	 * {@link scheduleCarryKey} (empty when it had none). A subscription whose
	 * key is still present in the new config resumes its schedule instead of
	 * firing on load, and its queued `time.heartbeat` runs are kept. See
	 * {@link reloadQueueDecision} for every other queued event.
	 */
	carry?: ReadonlyMap<string, CueScheduleCarry>;
}

/**
 * What a reload compares to decide a heartbeat "did not change": its name plus
 * its trigger config. The prompt and targets are not part of it, so editing a
 * prompt keeps the schedule rather than running the heartbeat on every save.
 */
function scheduleCarryKey(sub: CueSubscription): string {
	return `${sub.name}\u0000${triggerGroupKey(sub)}`;
}

/**
 * What a cue.yaml reload does with one queued event: null keeps it, otherwise
 * the reason it is dropped (the run manager records the drop).
 *
 * A queued event was accepted work (a webhook delivery is already answered
 * 2xx) and carries the prompt and settings it was fired with, so it stays
 * while its subscription is in a loaded config and switched on, in this
 * agent's config or another's (a fan-out target queues the source's
 * subscription). `app.startup` entries always stay. A heartbeat's waiting tick
 * stays only when the reload carried that heartbeat's schedule: a changed one
 * fires on load instead, so its old tick is superseded.
 */
function reloadQueueDecision(
	entry: Pick<QueuedEvent, 'event' | 'subscriptionName'>,
	carriedHeartbeats: ReadonlySet<string>,
	liveSubscriptions: ReadonlySet<string>
): CueQueueDropReason | null {
	if (entry.event.type === 'app.startup') return null;
	if (!liveSubscriptions.has(entry.subscriptionName)) return 'subscription-missing';
	if (entry.event.type === 'time.heartbeat' && !carriedHeartbeats.has(entry.subscriptionName)) {
		return 'superseded';
	}
	return null;
}

export interface CueSessionRuntimeServiceDeps {
	enabled: () => boolean;
	getSessions: () => SessionInfo[];
	onRefreshRequested: (sessionId: string, projectRoot: string) => void;
	onLog: (level: MainLogLevel, message: string, data?: unknown) => void;
	onPreventSleep?: (reason: string) => void;
	onAllowSleep?: (reason: string) => void;
	registry: CueSessionRegistry;
	/**
	 * Dispatch a fired event for a subscription. This is the single dispatch
	 * entry point - it handles fan-out vs single-target routing internally.
	 * Trigger sources never call run-manager directly.
	 */
	dispatchSubscription: (
		ownerSessionId: string,
		sub: CueSubscription,
		event: CueEvent,
		sourceSessionName: string,
		chainDepth?: number
	) => number;
	clearQueue: (sessionId: string, preserveStartup?: boolean) => void;
	/** Settle a reloaded session's queue: see `CueRunManager.retainQueue`. */
	retainQueue: (
		sessionId: string,
		classify: (entry: QueuedEvent) => CueQueueDropReason | null
	) => number;
	clearFanInState: (sessionId: string) => void;
	/**
	 * Remove a subscription from cue.yaml on behalf of a trigger source's
	 * `requestSelfDestruct` (missed-grace / filtered `time.once`). The engine
	 * injects a version serialised against its per-root YAML write chain so the
	 * rewrite can't race a toggle or another self-destruct on the same file.
	 * When omitted (standalone use / tests), the service writes directly.
	 */
	selfDestruct?: (projectRoot: string, subscriptionName: string) => Promise<SelfDestructResult>;
}

/**
 * Structured outcome of {@link CueSessionRuntimeService.initSession}. Lets
 * callers (primarily `refreshSession`) distinguish a cleanly-loaded config
 * from one that is missing on disk vs one that failed parse / validation -
 * a distinction that matters for cleanup decisions (e.g. we only clear
 * cue_github_seen rows when the config is truly gone, not when it's merely
 * malformed and will likely be fixed on the next edit).
 */
export type InitSessionOutcome =
	| { kind: 'disabled' }
	| { kind: 'loaded' }
	| { kind: 'missing' }
	| { kind: 'parse-error' }
	| { kind: 'invalid' };

export interface CueSessionRuntimeService {
	initSession(session: SessionInfo, opts: InitSessionOptions): InitSessionOutcome;
	refreshSession(
		sessionId: string,
		projectRoot: string,
		reason?: SessionInitReason
	): {
		reloaded: boolean;
		configRemoved: boolean;
		sessionName?: string;
		activeCount?: number;
	};
	removeSession(sessionId: string): void;
	teardownSession(sessionId: string): void;
	clearAll(): void;
	/**
	 * The drain's first step (`CueEngine.drain`): stop every trigger source and
	 * yaml watcher so no new work arrives, but keep the registry. Unlike
	 * `teardownSession` it leaves fan-in state and the queue alone (teardown
	 * clears both, deleting persisted rows), and settings and `agent.completed`
	 * configs stay readable for the successors of runs still finishing.
	 * Returns how many sources were stopped.
	 */
	disarmAll(): number;
	/**
	 * Resolves once every stopped source has settled the emits it already
	 * acknowledged (see `CueTriggerSource.settle`). Call after `disarmAll`.
	 */
	settleAll(): Promise<void>;
	/** Drop ALL app.startup dedup keys. Delegated from engine.stop(). */
	clearAllStartupKeys(): void;
}

/**
 * Creates the per-session lifecycle service for Cue YAML and trigger sources.
 * Preserves config watchers across refreshes and releases session resources on
 * removal or shutdown.
 */
export function createCueSessionRuntimeService(
	deps: CueSessionRuntimeServiceDeps
): CueSessionRuntimeService {
	const { registry } = deps;
	const yamlWatchers = new Map<string, { projectRoot: string; cleanup: () => void }>();
	const loadedYamlFiles = new Map<string, ReturnType<typeof readCueConfigFile>>();
	// Keep ownership through malformed saves, independently of registry teardown.
	const lastConfigSettings = new Map<string, CueConfig['settings']>();

	/** Per session: the running sources that can hand their schedule to a
	 *  reload (`scheduleCarry`), keyed by {@link scheduleCarryKey}. */
	const carryableSources = new Map<string, Map<string, CueTriggerSource>>();

	/** Sources `disarmAll` stopped, kept only so `settleAll` can wait on them. */
	let disarmedSources: CueTriggerSource[] = [];

	/** Sessions whose reload held the queue but whose config then failed to
	 *  load: the next good load settles it (see refreshSession). */
	const heldQueues = new Set<string>();

	/** Drops remembered ownership once no session watches this root anymore. */
	function forgetUnusedRoot(projectRoot: string): void {
		if (![...yamlWatchers.values()].some((watcher) => watcher.projectRoot === projectRoot)) {
			lastConfigSettings.delete(projectRoot);
		}
	}

	/** Looks up current session records so refresh observes removals and ownership changes. */
	function getSession(sessionId: string): SessionInfo | undefined {
		return deps.getSessions().find((session) => session.id === sessionId);
	}

	/** Names of the switched-on subscriptions in every loaded config. */
	function enabledSubscriptionNames(): Set<string> {
		const names = new Set<string>();
		for (const state of registry.snapshot().values()) {
			for (const sub of state.config.subscriptions) {
				if (sub.enabled !== false) names.add(sub.name);
			}
		}
		return names;
	}

	/**
	 * Loads a session's config, logs warnings and surfaces eligible health notices.
	 * Registers trigger sources according to enablement, ownership and agent targets;
	 * startup events also honor the supplied initialization reason.
	 */
	function initSession(session: SessionInfo, opts: InitSessionOptions): InitSessionOutcome {
		if (!deps.enabled()) return { kind: 'disabled' };

		// Idempotency guard: tear down any pre-existing registration to prevent
		// duplicate trigger sources if initSession is called twice for the same
		// session (race between auto-discovery and manual refresh).
		if (registry.has(session.id)) {
			deps.onLog(
				'warn',
				`[CUE] initSession called for already-initialized session "${session.name}" - tearing down first`
			);
			teardownSession(session.id, true);
			registry.unregister(session.id);
		}

		// Per-agent-cwd model: each session reads ONLY its own
		// `<cwd>/.maestro/cue.yaml`. There is no ancestor walk and no
		// cross-cwd merge - every subscription that targets this agent
		// lives in this agent's own yaml file (writer enforces this via
		// `pipelinesToYamlByOwnerCwd`). Worktrees, sub-agents, and any
		// other shared-parent topology each get their own cue.yaml; they
		// do not inherit from a parent dir.
		// Observe before reading: another process can atomically replace YAML
		// between the engine's read and chokidar's initial scan. Keep this same
		// watcher for both pending and loaded configs, so ready reconciliation
		// covers that entire window.
		const existingWatcher = yamlWatchers.get(session.id);
		if (existingWatcher && existingWatcher.projectRoot !== session.projectRoot) {
			existingWatcher.cleanup();
			yamlWatchers.delete(session.id);
			loadedYamlFiles.delete(session.id);
			forgetUnusedRoot(existingWatcher.projectRoot);
		}
		if (!yamlWatchers.has(session.id)) {
			const cleanup = watchCueYaml(
				session.projectRoot,
				() => deps.onRefreshRequested(session.id, session.projectRoot),
				{
					getLoadedConfigFile: () => loadedYamlFiles.get(session.id),
					onWarning: (message) =>
						deps.onLog('warn', message, {
							type: 'triggerHealthWarning',
							sessionId: session.id,
							message,
						}),
				}
			);
			yamlWatchers.set(session.id, { projectRoot: session.projectRoot, cleanup });
		}
		const loadResult = loadCueConfigDetailed(session.projectRoot);
		if (loadResult.file !== undefined) loadedYamlFiles.set(session.id, loadResult.file);
		const settings = loadResult.ok ? loadResult.config.settings : loadResult.settings;
		if (settings) lastConfigSettings.set(session.projectRoot, settings);
		if (!loadResult.ok && loadResult.reason === 'missing') {
			lastConfigSettings.delete(session.projectRoot);
		}

		// Use the execution ownership rules even when this save cannot be loaded.
		// A malformed save retains the last readable settings; a cold malformed
		// file falls back to the usual first eligible session. An unresolvable
		// explicit owner must not silence the whole-file error on every agent.
		// This load already identifies the shared config. Do not recheck its
		// path per candidate: a concurrent replacement must not erase the owner.
		const candidates = selectOwnershipCandidates(
			deps.getSessions().filter((s) => s.projectRoot === session.projectRoot),
			() => true
		);
		const ownershipConfig = {
			settings: lastConfigSettings.get(session.projectRoot) ?? DEFAULT_CUE_SETTINGS,
		};
		const ownershipWarning = computeOwnershipWarning({
			session,
			candidates,
			config: ownershipConfig,
			configFromAncestor: false,
		});
		const isConfigOwner = !ownershipWarning;
		const sameRoot = candidates.filter((s) => s.projectRoot === session.projectRoot);
		const errorOwner =
			sameRoot.find(
				(candidate) =>
					!computeOwnershipWarning({
						session: candidate,
						candidates,
						config: ownershipConfig,
						configFromAncestor: false,
					})
			) ?? sameRoot[0];

		if (!loadResult.ok) {
			// Distinguish missing (silent) from parse / validation failures (loud).
			if (loadResult.reason === 'parse-error') {
				const message = `[CUE] Failed to parse cue.yaml for "${session.name}": ${loadResult.message}`;
				if (errorOwner?.id === session.id) {
					deps.onLog('error', message, {
						type: 'triggerHealthWarning',
						sessionId: session.id,
						message,
					});
				} else {
					deps.onLog('error', message);
				}
			} else if (loadResult.reason === 'invalid') {
				const message = `[CUE] cue.yaml for "${session.name}" is invalid:\n  - ${loadResult.errors.join('\n  - ')}`;
				if (errorOwner?.id === session.id) {
					deps.onLog('error', message, {
						type: 'triggerHealthWarning',
						sessionId: session.id,
						message,
					});
				} else {
					deps.onLog('error', message);
				}
			}

			return { kind: loadResult.reason };
		}

		const config = loadResult.config;

		// Surface non-fatal materialization warnings (e.g. unresolved prompt_file)
		const healthWarnings = new Map(
			(loadResult.healthWarnings ?? []).map((warning) => [warning.warningIndex, warning])
		);
		for (const [index, warning] of loadResult.warnings.entries()) {
			const message = `[CUE] ${warning}`;
			const healthWarning = healthWarnings.get(index);
			if (
				!healthWarning ||
				(healthWarning.agentId ? healthWarning.agentId !== session.id : !isConfigOwner)
			) {
				deps.onLog('warn', message);
				continue;
			}
			deps.onLog('warn', message, {
				type: 'triggerHealthWarning',
				sessionId: session.id,
				message,
			});
		}

		// Ownership gate for UNOWNED subscriptions (no agent_id). When multiple
		// agents share a projectRoot, each would otherwise fire every unowned
		// subscription once. See {@link computeOwnershipWarning} for the full
		// resolution matrix. A non-empty warning string is the single source
		// of truth: this session is NOT the config owner and the dashboard
		// will surface the string as a red-triangle tooltip. Subscriptions
		// with an explicit `agent_id` continue to fan out regardless.
		// Candidates share this config's root and participate in Cue. A terminal
		// (or any non-AI-agent) session could otherwise
		// win the implicit first-in-list race at a shared projectRoot,
		// become the "owner", have nothing to dispatch, and silently suppress
		// automation on the real Cue-configured agent.
		if (ownershipWarning && config.subscriptions.some((s) => !s.agent_id)) {
			deps.onLog(
				'cue',
				`[CUE] "${session.name}" will not fire unowned subscriptions from cue.yaml at "${session.projectRoot}" - ${ownershipWarning}`
			);
		}

		// Subscriptions this session will actually instantiate / run. For non-
		// owners, drop unowned subs (no agent_id) up front so every downstream
		// consumer - trigger wiring, app.startup, sleep prevention, the
		// initialized-with-N-subs log, refresh activeCount - sees a single
		// consistent view. Without this filter, a non-owner with only unowned
		// time-based subs would still hit `onPreventSleep` and report active
		// counts for work it never executes.
		const runnableSubscriptions = isConfigOwner
			? config.subscriptions
			: config.subscriptions.filter((sub) => Boolean(sub.agent_id));

		const state: SessionState = {
			config,
			configRoot: undefined,
			triggerSources: [],
			ownershipWarning,
		};

		// Register the session before starting any trigger sources or firing
		// app.startup so that other components (e.g. CueRunManager via registry.get)
		// see a fully-initialised session from the moment execution begins.
		registry.register(session.id, state);

		// The subscriptions this session will run, and which of them a reload
		// carries over with their schedule.
		const activeSubscriptions = runnableSubscriptions.filter(
			(sub) => sub.enabled !== false && !(sub.agent_id && sub.agent_id !== session.id)
		);
		const carried = new Map<CueSubscription, CueScheduleCarry>();
		if (opts.carry) {
			for (const sub of activeSubscriptions) {
				const carry = opts.carry.get(scheduleCarryKey(sub));
				if (carry) carried.set(sub, carry);
			}
			// The reload held this session's queue back (see refreshSession).
			// Settle it now, before any source can enqueue, so a fire on load
			// is never mistaken for a waiting run. The new config is already
			// registered above, so it counts as live.
			const carriedHeartbeats = new Set([...carried.keys()].map((sub) => sub.name));
			const liveSubscriptions = enabledSubscriptionNames();
			deps.retainQueue(session.id, (entry) =>
				reloadQueueDecision(entry, carriedHeartbeats, liveSubscriptions)
			);
		}
		const sessionCarryable = new Map<string, CueTriggerSource>();
		carryableSources.set(session.id, sessionCarryable);

		// Wire each subscription up to its trigger source. Each source owns its
		// own timer/watcher/poller and emits events through the `emit` callback,
		// which centralizes the dispatch path: passesFilter → state.lastTriggered
		// → dispatchSubscription. Sources never touch session state directly.
		for (const sub of activeSubscriptions) {
			const source: CueTriggerSource | null = createTriggerSource(sub.event, {
				session,
				subscription: sub,
				registry,
				carry: carried.get(sub),
				enabled: deps.enabled,
				onLog: deps.onLog,
				emit: (event) => {
					state.lastTriggered = event.timestamp;
					return deps.dispatchSubscription(session.id, sub, event, session.name);
				},
				// The trigger source asks for the sub to be consumed (missed-grace,
				// or - in theory - any other reason it decides not to fire). The
				// runtime is the sole writer of cue.yaml on this path; the engine's
				// YAML watcher reloads the config naturally after the rewrite, so
				// there's no need to refresh the session manually.
				requestSelfDestruct: (subscriptionName, reason) => {
					// Prefer the engine-injected serialised writer so this rewrite
					// can't race a toggle / run-completion self-destruct on the same
					// cue.yaml; fall back to a direct write when running standalone.
					const selfDestruct = deps.selfDestruct ?? removeSubscriptionFromYaml;
					void selfDestruct(session.projectRoot, subscriptionName)
						.then((result) => {
							if (result.removed) {
								deps.onLog(
									'cue',
									`[CUE] self-destruct removed "${subscriptionName}" from cue.yaml (${reason})`
								);
							} else {
								deps.onLog(
									'warn',
									`[CUE] self-destruct could not remove "${subscriptionName}" (${reason}): ${result.reason ?? 'unknown'}`
								);
							}
						})
						.catch((err) => {
							const message = err instanceof Error ? err.message : String(err);
							deps.onLog(
								'warn',
								`[CUE] self-destruct threw for "${subscriptionName}" (${reason}): ${message}`
							);
							// Expected file errors come back as a structured
							// { removed: false } result, so a throw here is unexpected -
							// report it to Sentry rather than only logging.
							void captureException(err, {
								operation: 'cueRequestSelfDestruct',
								sessionId: session.id,
								subscriptionName,
								reason,
							});
						});
				},
			});

			if (source) {
				source.start();
				state.triggerSources.push(source);
				if (source.scheduleCarry) sessionCarryable.set(scheduleCarryKey(sub), source);
			}
		}

		// app.startup subscriptions fire exactly once per process lifecycle, and
		// only when the engine is starting because of a real system boot. Toggling
		// Cue off/on or hot-reloading a YAML must NOT re-fire startup events.
		if (opts.reason === 'system-boot') {
			for (const sub of runnableSubscriptions) {
				if (sub.enabled === false) continue;
				if (sub.agent_id && sub.agent_id !== session.id) continue;
				if (sub.event !== 'app.startup') continue;

				if (!registry.markStartupFired(session.id, sub.name)) continue;

				const event = createCueEvent('app.startup', sub.name, {
					reason: 'system_startup',
				});

				if (!passesFilter(sub, event, deps.onLog)) continue;

				deps.onLog('cue', `[CUE] "${sub.name}" triggered (app.startup)`);
				state.lastTriggered = event.timestamp;
				deps.dispatchSubscription(session.id, sub, event, session.name);
			}
		}

		// NOTE: we deliberately do NOT take a sleep blocker just because this
		// session has time-based subscriptions registered.
		//
		// That used to happen here, keyed `cue:schedule:{sessionId}`, and it was
		// held from session init all the way to teardown. Having a subscription is
		// a static property of the YAML, not a runtime state, so a single job that
		// fires once a day at 03:00 kept a blocker up for all 24 hours. On macOS
		// that suppressed the OS's entire discretionary maintenance tier for as
		// long as the app was open.
		//
		// Actually running a subscription is what needs the machine awake, and
		// CueRunManager already covers exactly that window via `cue:run:{runId}`.
		deps.onLog(
			'cue',
			`[CUE] Initialized session "${session.name}" with ${countActiveSubscriptions(runnableSubscriptions, session.id, session.name)} active subscription(s)`
		);
		return { kind: 'loaded' };
	}

	/**
	 * Stops registered triggers, queued work, fan-in state and scheduled dedup keys.
	 * Can retain the YAML watcher for refresh, and hold the queue for a reload to
	 * settle (`holdQueue`); startup dedup keys remain intact.
	 */
	function teardownSession(
		sessionId: string,
		preserveYamlWatcher = false,
		holdQueue = false
	): void {
		if (!preserveYamlWatcher) {
			const projectRoot = yamlWatchers.get(sessionId)?.projectRoot;
			yamlWatchers.get(sessionId)?.cleanup();
			yamlWatchers.delete(sessionId);
			if (projectRoot) forgetUnusedRoot(projectRoot);
		}
		// Stopped triggers no longer represent a loaded runtime, even if bytes are unchanged.
		loadedYamlFiles.delete(sessionId);
		carryableSources.delete(sessionId);
		const state = registry.get(sessionId);
		if (!state) return;

		// Each trigger source owns its own underlying mechanism (timer, watcher,
		// poller). Calling stop() releases all of them in one place - no more
		// parallel timers[] / watchers[] arrays.
		for (const source of state.triggerSources) {
			source.stop();
		}
		state.triggerSources = [];

		deps.clearFanInState(sessionId);
		// A reload settles the queue itself once it knows what survived
		// (initSession / refreshSession).
		if (!holdQueue) deps.clearQueue(sessionId, true);

		// Drop time.scheduled dedup keys for this session - they only matter while
		// the session is initialized. Startup keys are NOT cleared here so that a
		// refresh inside the same process lifecycle does not re-fire app.startup.
		registry.clearScheduledForSession(sessionId);
	}

	/**
	 * Collects the stable GitHub-seen subscription IDs (`${sessionId}:${name}`)
	 * for every `github.*` subscription in a session's current config. Used
	 * on refresh/remove to diff against the post-reload set and clear seen
	 * rows for subscriptions the user has deleted, so `cue_github_seen`
	 * doesn't grow indefinitely.
	 */
	function collectGitHubSubIds(sessionId: string): Set<string> {
		const ids = new Set<string>();
		const state = registry.get(sessionId);
		if (!state) return ids;
		for (const sub of state.config.subscriptions) {
			if (sub.event === 'github.pull_request' || sub.event === 'github.issue') {
				ids.add(`${sessionId}:${sub.name}`);
			}
		}
		return ids;
	}

	/**
	 * Replaces a session's runtime from YAML while retaining its config watcher.
	 * Distinguishes removal from invalid saves and clears seen IDs only for removed work.
	 */
	function refreshSession(
		sessionId: string,
		projectRoot: string,
		reason: SessionInitReason = 'refresh'
	): { reloaded: boolean; configRemoved: boolean; sessionName?: string; activeCount?: number } {
		const hadSession = registry.has(sessionId);
		// Snapshot GitHub-seen IDs BEFORE teardown so we can diff against the
		// post-reload set and clear seen rows for removed GitHub subscriptions.
		const oldGitHubIds = collectGitHubSubIds(sessionId);
		// Snapshot every running heartbeat's schedule BEFORE teardown stops it,
		// so an unchanged one keeps its next run instead of firing again.
		const carry = new Map<string, CueScheduleCarry>();
		for (const [key, source] of carryableSources.get(sessionId) ?? []) {
			const schedule = source.scheduleCarry?.();
			if (schedule) carry.set(key, schedule);
		}
		// A reload of a loaded session holds its queue and settles it once the
		// new config is known (initSession, below), and so does the first good
		// load after a config that failed to load held it. Any other first load
		// leaves the queue alone: what waits there was restored at start and
		// checked then.
		const holdQueue = hadSession || heldQueues.delete(sessionId);
		teardownSession(sessionId, true, holdQueue);
		registry.unregister(sessionId);

		const session = getSession(sessionId);
		if (!session) {
			teardownSession(sessionId);
			if (holdQueue) {
				heldQueues.add(sessionId);
				deps.retainQueue(sessionId, (entry) =>
					entry.event.type === 'app.startup' || isDurableCueEvent(entry.event)
						? null
						: 'session-missing'
				);
			}
			return { reloaded: false, configRemoved: false };
		}

		const outcome = initSession(
			{ ...session, projectRoot },
			holdQueue ? { reason, carry } : { reason }
		);
		// The config did not load. A parse or validation error is usually a
		// save in the middle of an edit, so the queue stays held for the next
		// good load to settle rather than losing accepted work to a typo. A
		// config that is gone (or an engine that is off) has nothing to run it.
		if (holdQueue && !registry.has(sessionId)) {
			if (outcome.kind === 'parse-error' || outcome.kind === 'invalid') {
				heldQueues.add(sessionId);
			} else {
				deps.retainQueue(sessionId, (entry) =>
					entry.event.type === 'app.startup' ? null : 'subscription-missing'
				);
			}
		}
		const newState = registry.get(sessionId);
		if (newState) {
			// Diff old vs. new GitHub subscription IDs and clear `cue_github_seen`
			// rows for any that are gone. Without this, deleted GitHub polls
			// leave DB rows behind until their `seen_at` ages past the retention
			// window. Not functionally harmful (rows are keyed by subscription
			// ID so they don't collide with new subs) but they accumulate.
			const newGitHubIds = collectGitHubSubIds(sessionId);
			for (const id of oldGitHubIds) {
				if (!newGitHubIds.has(id)) {
					clearGitHubSeenForSubscription(id);
				}
			}
			// Mirror init's ownership-filtered view so the dashboard count
			// doesn't include unowned subscriptions a non-owner won't run.
			const visibleSubscriptions = newState.ownershipWarning
				? newState.config.subscriptions.filter((sub) => Boolean(sub.agent_id))
				: newState.config.subscriptions;
			const activeCount = countActiveSubscriptions(visibleSubscriptions, sessionId, session.name);
			return {
				reloaded: true,
				configRemoved: false,
				sessionName: session.name,
				activeCount,
			};
		}

		// Config is gone OR it failed to load. Only clear GitHub-seen rows when
		// the config is TRULY gone (file missing). Parse / validation errors
		// usually mean "user is mid-edit and will fix shortly" - keeping seen
		// rows lets the GitHub poller skip already-seen items once the config
		// comes back, instead of re-spamming the user on reload.
		const configTrulyMissing = outcome.kind === 'missing';
		if (configTrulyMissing) {
			for (const id of oldGitHubIds) {
				clearGitHubSeenForSubscription(id);
			}
		}

		if (hadSession) {
			// Only surface "Config removed" when the session previously had a
			// config AND the file is truly gone. A parse/validation error on
			// a previously-valid config is a SEPARATE state ("invalid config")
			// - the yaml watcher remains armed so the next save reloads.
			return {
				reloaded: false,
				configRemoved: configTrulyMissing,
				sessionName: session.name,
			};
		}

		// Session never had a valid config - nothing to mark as removed, and no
		// GitHub-seen rows to clear that weren't already absent. The refresh
		// outcome is simply "still no config", not "config removed".
		return { reloaded: false, configRemoved: false, sessionName: session.name };
	}

	/** Removes runtime resources, queued work, startup keys and persisted GitHub seen IDs. */
	function removeSessionInternal(sessionId: string): void {
		// Capture GitHub-seen IDs before teardown since teardown unregisters
		// the session and we won't be able to read its subscriptions anymore.
		const oldGitHubIds = collectGitHubSubIds(sessionId);
		teardownSession(sessionId);
		registry.unregister(sessionId);
		heldQueues.delete(sessionId);
		deps.clearQueue(sessionId);
		// Removing a session means its app.startup history is no longer relevant -
		// if the same session id is re-added later (rare), we want startup to fire.
		registry.clearStartupForSession(sessionId);

		// Clear every GitHub-seen row for this session's subscriptions. The
		// session is going away entirely, so none of them should remain.
		for (const id of oldGitHubIds) {
			clearGitHubSeenForSubscription(id);
		}
	}

	return {
		initSession,
		refreshSession,

		removeSession(sessionId: string): void {
			removeSessionInternal(sessionId);
			deps.onLog('cue', `[CUE] Session removed: ${sessionId}`);
		},

		teardownSession,

		/** Tears down sessions and clears remaining YAML watchers and cached config ownership. */
		clearAll(): void {
			for (const [sessionId] of registry.snapshot()) {
				teardownSession(sessionId);
			}
			registry.clear();
			carryableSources.clear();
			heldQueues.clear();

			for (const { cleanup } of yamlWatchers.values()) cleanup();
			yamlWatchers.clear();
			loadedYamlFiles.clear();
			lastConfigSettings.clear();
		},

		disarmAll(): number {
			let stopped = 0;
			disarmedSources = [];
			for (const [, state] of registry.snapshot()) {
				for (const source of state.triggerSources) {
					source.stop();
					disarmedSources.push(source);
					stopped++;
				}
				state.triggerSources = [];
			}
			carryableSources.clear();
			// Every cue.yaml watcher, loaded or pending, lives in one map; a
			// drained engine reloads nothing, and its baselines go with it.
			for (const { cleanup } of yamlWatchers.values()) cleanup();
			yamlWatchers.clear();
			loadedYamlFiles.clear();
			return stopped;
		},

		async settleAll(): Promise<void> {
			const sources = disarmedSources;
			disarmedSources = [];
			await Promise.all(sources.map((source) => source.settle?.()));
		},

		clearAllStartupKeys(): void {
			registry.clearAllStartupKeys();
		},
	};
}
