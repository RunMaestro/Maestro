/**
 * Plugin background-service supervisor (main process).
 *
 * `background:service` means: "this plugin's sandbox child holds long-lived
 * work the host must keep alive". The plugin child (utilityProcess) IS the
 * service runtime — there is no separate worker to spawn. What the supervisor
 * adds on top of the plain sandbox lifecycle is:
 *
 * - a registry of which plugin holds which registered services;
 * - crash-restart: when a sandbox child dies while holding registered
 *   services, the supervisor restarts it with bounded exponential backoff
 *   (mirroring pianola-supervisor discipline). The restart re-runs the
 *   plugin's own activate path, which re-registers its services — the
 *   supervisor never re-plays registrations itself;
 * - a restart cap: after MAX_RESTARTS consecutive rapid failures the plugin
 *   is marked `failed-permanent` and abandoned until a manual re-enable;
 * - health: per-plugin state (running | restarting | failed-permanent |
 *   stopped) + restart count + registered services, exposed to the plugin
 *   itself via the `background.list` host method and to the host UI;
 * - teardown: plugin disable/uninstall/reload and app quit clear the
 *   registrations FIRST, so the child's subsequent exit is never mistaken
 *   for a crash and nothing is restarted.
 *
 * Supervised children die with the app: the sandbox host owns the actual
 * utilityProcess; this class only holds bookkeeping and timers (all unref'd).
 */

import { logger } from '../utils/logger';

const LOG_CONTEXT = '[PluginBackgroundSupervisor]';

/** Consecutive crash-restarts before a plugin is marked failed-permanent. */
const MAX_RESTARTS = 5;
/** Backoff base: 1s, doubling per consecutive failure. */
const BACKOFF_BASE_MS = 1000;
/** Backoff ceiling so a flapping plugin restarts at most every 30s. */
const BACKOFF_CAP_MS = 30_000;
/** A child that ran at least this long is recovered (restart count resets). */
const STABLE_RUN_MS = 60_000;
/** Hard cap on registered services per plugin (matches the handler's cap). */
const MAX_SERVICES_PER_PLUGIN = 16;
/** Bound a service's declared name so a hostile child cannot balloon health payloads. */
const MAX_SERVICE_NAME_LENGTH = 200;

/** Supervision state of one plugin's background services. */
export type PluginBackgroundState = 'running' | 'restarting' | 'failed-permanent' | 'stopped';

/** One registered background service (host-side bookkeeping, plain data). */
export interface RegisteredBackgroundService {
	id: string;
	name?: string;
	registeredAt: number;
}

/** Read-only health snapshot for one supervised plugin. */
export interface PluginBackgroundHealth {
	pluginId: string;
	state: PluginBackgroundState;
	/** Consecutive crash-restart attempts in the current failure streak. */
	restarts: number;
	services: RegisteredBackgroundService[];
	lastError?: string;
}

export interface PluginBackgroundSupervisorDeps {
	/**
	 * Restart the owning sandbox child. Wired to the plugin manager's
	 * refresh/reconcile path, which re-reads disk and starts every runnable
	 * plugin that is not running — including the crashed one. The restarted
	 * child re-runs activate(), which re-registers its services.
	 */
	restartPlugin: (pluginId: string) => void;
	/**
	 * Whether the plugin is still installed + enabled. Re-checked when a
	 * backoff timer fires so a plugin disabled mid-backoff is never restarted.
	 */
	isPluginEnabled: (pluginId: string) => boolean;
	/** Injectable clock for tests; defaults to Date.now. */
	now?: () => number;
}

interface SupervisedPlugin {
	state: PluginBackgroundState;
	services: Map<string, RegisteredBackgroundService>;
	restarts: number;
	/** When the current child (or restart attempt) began, for stable-run reset. */
	lastStartAt: number;
	backoffTimer?: NodeJS.Timeout;
	lastError?: string;
}

/**
 * Owns registration bookkeeping + crash-restart policy for plugin background
 * services. One instance lives in the main process; the sandbox host's
 * onCrash/onStop hooks and the background.* host handlers feed it.
 */
export class PluginBackgroundSupervisor {
	private readonly plugins = new Map<string, SupervisedPlugin>();
	private readonly now: () => number;

	constructor(private readonly deps: PluginBackgroundSupervisorDeps) {
		this.now = deps.now ?? Date.now;
	}

	/**
	 * Register (or re-register) a service for a plugin. Re-registering an
	 * existing id is idempotent — that is exactly what a restarted child's
	 * activate path does — and clears a pending restart cycle: the child is
	 * demonstrably alive again, so the plugin returns to `running`.
	 */
	register(pluginId: string, service: { id?: unknown; name?: unknown }): { serviceId: string } {
		const entry = this.entryFor(pluginId);

		const serviceId =
			typeof service.id === 'string' && service.id.length > 0
				? service.id
				: `bg_${this.now()}_${Math.random().toString(36).slice(2)}`;
		if (!entry.services.has(serviceId) && entry.services.size >= MAX_SERVICES_PER_PLUGIN) {
			throw new Error('background service limit reached');
		}

		const registered: RegisteredBackgroundService = {
			id: serviceId,
			registeredAt: this.now(),
		};
		if (typeof service.name === 'string' && service.name.length > 0) {
			registered.name = service.name.slice(0, MAX_SERVICE_NAME_LENGTH);
		}
		entry.services.set(serviceId, registered);

		// The registering child is alive: end any restart cycle and reset the
		// failure streak bookkeeping start so stable-run detection is accurate.
		clearTimeout(entry.backoffTimer);
		entry.backoffTimer = undefined;
		entry.state = 'running';
		entry.lastStartAt = this.now();
		delete entry.lastError;
		return { serviceId };
	}

	/**
	 * Unregister one service. Returns false for an unknown id (the handler
	 * surfaces that as an error). When the last service goes, the plugin
	 * leaves supervision entirely — a later crash restarts nothing.
	 */
	unregister(pluginId: string, serviceId: string): boolean {
		const entry = this.plugins.get(pluginId);
		if (!entry?.services.delete(serviceId)) return false;
		if (entry.services.size === 0) this.teardown(pluginId);
		return true;
	}

	/** Health for one plugin (fresh objects, safe to serialize). */
	health(pluginId: string): PluginBackgroundHealth {
		const entry = this.plugins.get(pluginId);
		if (!entry) {
			return { pluginId, state: 'stopped', restarts: 0, services: [] };
		}
		const health: PluginBackgroundHealth = {
			pluginId,
			state: entry.state,
			restarts: entry.restarts,
			services: [...entry.services.values()].map((s) => ({ ...s })),
		};
		if (entry.lastError) health.lastError = entry.lastError;
		return health;
	}

	/** Health for every plugin under supervision (including failed/restarting). */
	healthAll(): PluginBackgroundHealth[] {
		return [...this.plugins.keys()].map((id) => this.health(id));
	}

	/**
	 * The owning sandbox child died unexpectedly (sandbox host onCrash). If the
	 * plugin holds registered services, clear them (they died with the child)
	 * and schedule a bounded-backoff restart; otherwise ignore. A crash while
	 * already `restarting` (child came back but died before re-registering)
	 * also lands here and burns another restart attempt.
	 */
	onPluginCrash(pluginId: string, code: number): void {
		const entry = this.plugins.get(pluginId);
		if (!entry) return;
		if (entry.state !== 'running' && entry.state !== 'restarting') return;
		if (entry.state === 'running' && entry.services.size === 0) return;

		// A child that ran long enough before dying is a fresh failure, not a
		// continuation of a rapid-flap streak.
		if (this.now() - entry.lastStartAt >= STABLE_RUN_MS) {
			entry.restarts = 0;
		}
		// Registrations died with the child; the restarted activate() re-creates them.
		entry.services.clear();
		entry.lastError = `sandbox exited with code ${code}`;
		this.scheduleRestart(pluginId, entry);
	}

	/**
	 * The plugin was stopped ON PURPOSE (disable, uninstall, hot-reload swap,
	 * app quit). Clear registrations and cancel any pending restart BEFORE the
	 * child's exit event can fire, so the stop is never treated as a crash.
	 * The entry stays (state `stopped`) so health remains queryable; a reload's
	 * restart re-registers and flips it back to `running`.
	 */
	onPluginStopped(pluginId: string): void {
		const entry = this.plugins.get(pluginId);
		if (!entry) return;
		clearTimeout(entry.backoffTimer);
		entry.backoffTimer = undefined;
		entry.services.clear();
		entry.state = 'stopped';
		entry.restarts = 0;
	}

	/** Forget a plugin entirely: cancel its timer, drop all state (uninstall
	 * purge; also the per-plugin step of stopAll). Idempotent. */
	teardown(pluginId: string): void {
		clearTimeout(this.plugins.get(pluginId)?.backoffTimer);
		this.plugins.delete(pluginId);
	}

	/** Cancel every timer and clear all state (app quit). Idempotent. */
	stopAll(): void {
		for (const id of [...this.plugins.keys()]) this.teardown(id);
	}

	private entryFor(pluginId: string): SupervisedPlugin {
		let entry = this.plugins.get(pluginId);
		if (!entry) {
			entry = { state: 'running', services: new Map(), restarts: 0, lastStartAt: this.now() };
			this.plugins.set(pluginId, entry);
		}
		return entry;
	}

	private scheduleRestart(pluginId: string, entry: SupervisedPlugin): void {
		entry.restarts += 1;
		if (entry.restarts > MAX_RESTARTS) {
			entry.state = 'failed-permanent';
			logger.warn(
				`background services of "${pluginId}" failed after ${MAX_RESTARTS} restarts; giving up`,
				LOG_CONTEXT
			);
			return;
		}
		entry.state = 'restarting';
		const delay = Math.min(BACKOFF_BASE_MS * 2 ** (entry.restarts - 1), BACKOFF_CAP_MS);
		if (entry.backoffTimer) clearTimeout(entry.backoffTimer);
		const timer = setTimeout(() => {
			entry.backoffTimer = undefined;
			// Re-check at fire time: a plugin disabled/uninstalled mid-backoff
			// must never be restarted.
			if (!this.deps.isPluginEnabled(pluginId)) {
				entry.state = 'stopped';
				entry.services.clear();
				return;
			}
			entry.lastStartAt = this.now();
			try {
				this.deps.restartPlugin(pluginId);
			} catch (error) {
				entry.lastError = error instanceof Error ? error.message : String(error);
				this.scheduleRestart(pluginId, entry);
			}
		}, delay);
		// Never keep the process alive for a pending plugin restart.
		timer.unref?.();
		entry.backoffTimer = timer;
	}
}
