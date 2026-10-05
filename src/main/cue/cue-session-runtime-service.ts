import type { MainLogLevel } from '../../shared/logger-types';
import type { SessionInfo } from '../../shared/types';
import { loadCueConfigDetailed, watchCueYaml } from './cue-yaml-loader';
import { resolveCueConfigPath, type readCueConfigFile } from './config/cue-config-repository';
import { createCueEvent, type CueEvent, type CueSubscription } from './cue-types';
import { clearGitHubSeenForSubscription } from './cue-db';
import {
	computeOwnershipWarning,
	countActiveSubscriptions,
	type SessionState,
} from './cue-session-state';
import type { CueSessionRegistry } from './cue-session-registry';
import { createTriggerSource } from './triggers/cue-trigger-source-registry';
import { passesFilter } from './triggers/cue-trigger-filter';
import type { CueTriggerSource } from './triggers/cue-trigger-source';
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
	initSession(session: SessionInfo, opts: InitSessionOptions): Promise<InitSessionOutcome>;
	refreshSession(
		sessionId: string,
		projectRoot: string,
		reason?: SessionInitReason
	): Promise<{
		reloaded: boolean;
		configRemoved: boolean;
		sessionName?: string;
		activeCount?: number;
	}>;
	removeSession(sessionId: string): void;
	teardownSession(sessionId: string): void;
	clearAll(): void;
	/** Drop ALL app.startup dedup keys. Delegated from engine.stop(). */
	clearAllStartupKeys(): void;
}

/**
 * Re-check a config path that just read as missing. Network roots (UNC, 9P) can
 * drop a stat under load; a couple of short retries separate that from a delete.
 */
async function configReappeared(projectRoot: string): Promise<boolean> {
	for (let attempt = 0; attempt < 3; attempt++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 150));
		if (resolveCueConfigPath(projectRoot)) return true;
	}
	return false;
}

export function createCueSessionRuntimeService(
	deps: CueSessionRuntimeServiceDeps
): CueSessionRuntimeService {
	const { registry } = deps;
	const yamlWatchers = new Map<string, { projectRoot: string; cleanup: () => void }>();
	const loadedYamlFiles = new Map<string, ReturnType<typeof readCueConfigFile>>();

	function getSession(sessionId: string): SessionInfo | undefined {
		return deps.getSessions().find((session) => session.id === sessionId);
	}

	async function initSession(
		session: SessionInfo,
		opts: InitSessionOptions
	): Promise<InitSessionOutcome> {
		if (!deps.enabled()) return { kind: 'disabled' };

		// Confirm a missing read while the previous triggers and subscriptions remain live.
		// Observe before reading, retaining the watcher across YAML replacement and refresh.
		const existingWatcher = yamlWatchers.get(session.id);
		if (existingWatcher && existingWatcher.projectRoot !== session.projectRoot) {
			existingWatcher.cleanup();
			yamlWatchers.delete(session.id);
			loadedYamlFiles.delete(session.id);
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
		const previousState = registry.get(session.id);
		const loadResult = loadCueConfigDetailed(session.projectRoot);
		if (!loadResult.ok && loadResult.reason === 'missing' && previousState) {
			const reappeared = await configReappeared(session.projectRoot);
			if (!deps.enabled()) return { kind: 'disabled' };
			if (!getSession(session.id)) {
				removeSessionInternal(session.id);
				return { kind: 'disabled' };
			}
			// A stop, removal, or newer refresh may have settled this session during the wait.
			if (registry.get(session.id) !== previousState) {
				return { kind: registry.has(session.id) ? 'loaded' : 'disabled' };
			}
			if (reappeared) return { kind: 'loaded' };
		}

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
		if (loadResult.file !== undefined) loadedYamlFiles.set(session.id, loadResult.file);
		if (!loadResult.ok) {
			// Distinguish missing (silent) from parse / validation failures (loud).
			if (loadResult.reason === 'parse-error') {
				deps.onLog(
					'error',
					`[CUE] Failed to parse cue.yaml for "${session.name}": ${loadResult.message}`
				);
			} else if (loadResult.reason === 'invalid') {
				deps.onLog(
					'error',
					`[CUE] cue.yaml for "${session.name}" is invalid:\n  - ${loadResult.errors.join('\n  - ')}`
				);
			}

			return { kind: loadResult.reason };
		}

		const config = loadResult.config;

		// Surface non-fatal materialization warnings (e.g. unresolved prompt_file)
		for (const warning of loadResult.warnings) {
			deps.onLog('warn', `[CUE] ${warning}`);
		}

		// Ownership gate for UNOWNED subscriptions (no agent_id). When multiple
		// agents share a projectRoot, each would otherwise fire every unowned
		// subscription once. See {@link computeOwnershipWarning} for the full
		// resolution matrix. A non-empty warning string is the single source
		// of truth: this session is NOT the config owner and the dashboard
		// will surface the string as a red-triangle tooltip. Subscriptions
		// with an explicit `agent_id` continue to fan out regardless.
		// Filter candidates to sessions that could actually own a Cue config -
		// a cue.yaml at their projectRoot AND a tool type that participates
		// in Cue. A terminal (or any non-AI-agent) session could otherwise
		// win the implicit first-in-list race at a shared projectRoot,
		// become the "owner", have nothing to dispatch, and silently suppress
		// automation on the real Cue-configured agent.
		const candidates = deps
			.getSessions()
			.filter((s) => s.toolType !== 'terminal' && resolveCueConfigPath(s.projectRoot) !== null);
		const ownershipWarning = computeOwnershipWarning({
			session,
			candidates,
			config,
			// Per-agent-cwd model: configs never come from an ancestor anymore.
			configFromAncestor: false,
		});
		const isConfigOwner = !ownershipWarning;
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

		// Wire each subscription up to its trigger source. Each source owns its
		// own timer/watcher/poller and emits events through the `emit` callback,
		// which centralizes the dispatch path: passesFilter → state.lastTriggered
		// → dispatchSubscription. Sources never touch session state directly.
		for (const sub of runnableSubscriptions) {
			if (sub.enabled === false) continue;
			if (sub.agent_id && sub.agent_id !== session.id) continue;

			const source: CueTriggerSource | null = createTriggerSource(sub.event, {
				session,
				subscription: sub,
				registry,
				enabled: deps.enabled,
				onLog: deps.onLog,
				emit: (event) => {
					state.lastTriggered = event.timestamp;
					deps.dispatchSubscription(session.id, sub, event, session.name);
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

	function teardownSession(sessionId: string, preserveRuntime = false): void {
		if (!preserveRuntime) {
			yamlWatchers.get(sessionId)?.cleanup();
			yamlWatchers.delete(sessionId);
		}
		// Stopped triggers no longer represent a loaded runtime, even if bytes are unchanged.
		loadedYamlFiles.delete(sessionId);
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
		deps.clearQueue(sessionId, true);

		// A refresh in the same minute must not re-fire a scheduled trigger.
		// Only a full teardown drops its keys; startup keys likewise survive refresh.
		if (!preserveRuntime) registry.clearScheduledForSession(sessionId);
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

	async function refreshSession(
		sessionId: string,
		projectRoot: string,
		reason: SessionInitReason = 'refresh'
	): Promise<{
		reloaded: boolean;
		configRemoved: boolean;
		sessionName?: string;
		activeCount?: number;
	}> {
		const session = getSession(sessionId);
		if (!session) return { reloaded: false, configRemoved: false };
		const hadSession = registry.has(sessionId);
		// Snapshot GitHub-seen IDs BEFORE teardown so we can diff against the
		// post-reload set and clear seen rows for removed GitHub subscriptions.
		const oldGitHubIds = collectGitHubSubIds(sessionId);


		const outcome = await initSession({ ...session, projectRoot }, { reason });
		if (outcome.kind === 'disabled') return { reloaded: false, configRemoved: false };
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
		// A network-mounted root (a WSL distro via \\wsl.localhost, an SMB share) can answer
		// "not there" for an instant while the file is fine; confirm before tearing a
		// previously-good config down. A real deletion is still seen on the re-check.
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

	function removeSessionInternal(sessionId: string): void {
		// Capture GitHub-seen IDs before teardown since teardown unregisters
		// the session and we won't be able to read its subscriptions anymore.
		const oldGitHubIds = collectGitHubSubIds(sessionId);
		teardownSession(sessionId);
		registry.unregister(sessionId);
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

		clearAll(): void {
			for (const [sessionId] of registry.snapshot()) {
				teardownSession(sessionId);
			}
			registry.clear();

			for (const { cleanup } of yamlWatchers.values()) cleanup();
			yamlWatchers.clear();
			loadedYamlFiles.clear();
		},

		clearAllStartupKeys(): void {
			registry.clearAllStartupKeys();
		},
	};
}
