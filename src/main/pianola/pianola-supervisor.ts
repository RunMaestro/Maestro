/**
 * Pianola supervised daemon.
 *
 * Replaces the unmanaged `nohup ... &` model for Pianola's background processes
 * (tab watchers and plan orchestrations) with a desktop-owned supervisor:
 *
 * - Persists active targets in a shared store file (maestro-pianola-supervisor.json)
 *   so both the CLI and the renderer can control what runs by editing one file.
 * - Spawns each enabled target as a supervised child process (NOT detached, so
 *   the children die with the app) with exponential-backoff restart + health.
 * - Watches the store file and reconciles on change (the CLI writes the same
 *   file, so `maestro-cli pianola supervise ...` takes effect within ~1s).
 * - Relaunches enabled targets on app start and stops everything on quit.
 *
 * The whole subsystem is gated on `encoreFeatures.pianola`: when the flag is off
 * reconcile() tears all children down and spawns nothing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFile, execFileSync, type ChildProcess, type SpawnOptions } from 'child_process';
import { resolveMaestroCliScriptPath } from '../cue/cue-cli-executor';
import { captureException } from '../utils/sentry';
import { logger } from '../utils/logger';
import { isWindows } from '../../shared/platformDetection';
import { readSupervisorTargets, supervisorFilePath } from './pianola-store-main';
import type { PianolaSupervisedTarget, PianolaSupervisedKind } from '../../shared/pianola/storage';

const LOG_CONTEXT = '[PianolaSupervisor]';

/** Bounded per-target ring buffer of stdout/stderr lines. */
const MAX_LOG_LINES = 200;
/** Bounded slice of a child's ring buffer exposed in the health snapshot. */
const MAX_HEALTH_LOG_LINES = 50;
/** Consecutive unexpected exits before a target is marked failed and abandoned. */
const MAX_RESTARTS = 5;
/** Backoff base: 1s, then doubles each consecutive failure. */
const BACKOFF_BASE_MS = 1000;
/** Backoff ceiling so a flapping target retries at most every 30s. */
const BACKOFF_CAP_MS = 30_000;
/** Debounce for coalescing rapid store-file change events into one reconcile. */
const WATCH_DEBOUNCE_MS = 250;
/** A child that ran at least this long is treated as recovered (restart count resets). */
const STABLE_RUN_MS = 60_000;
/** Grace period before escalating SIGTERM to SIGKILL on POSIX (non-shutdown path). */
const SIGKILL_DELAY_MS = 5000;

/** Health state of one supervised target. */
export type PianolaSupervisedState = 'running' | 'backing-off' | 'stopped' | 'failed';

/** Per-target health snapshot returned to the renderer dashboard. */
export interface PianolaSupervisorHealth {
	id: string;
	kind: PianolaSupervisedKind;
	state: PianolaSupervisedState;
	pid?: number;
	restarts: number;
	lastError?: string;
	startedAt?: number;
	/** Bounded tail of the child's stdout/stderr ring buffer (most recent last). */
	recentLogs: string[];
}

/** Internal, mutable per-target bookkeeping. */
interface SupervisedChild {
	target: PianolaSupervisedTarget;
	child: ChildProcess | null;
	state: PianolaSupervisedState;
	restarts: number;
	lastError?: string;
	startedAt?: number;
	logs: string[];
	backoffTimer?: ReturnType<typeof setTimeout>;
	// Set true when we kill the child on purpose (disable/remove/quit) so the
	// exit handler treats it as stopped instead of crashing and restarting.
	stopping: boolean;
}

/**
 * Spawns a supervised child process. Injectable so the spawn/exit/backoff/
 * reconcile logic is unit-testable with a fake ChildProcess; defaults to
 * node:child_process spawn in production.
 */
export type PianolaChildSpawner = (
	command: string,
	args: readonly string[],
	opts: SpawnOptions
) => ChildProcess;

export interface PianolaSupervisorDeps {
	/** Reads `encoreFeatures.pianola`; checked on every reconcile and restart. */
	isEnabled: () => boolean;
	/** Resolves the isPianola session id, injected as MAESTRO_AGENT_ID for handoffs. */
	getPianolaAgentId: () => string | undefined;
	/** Spawns a supervised child; defaults to node:child_process spawn. Injectable for tests. */
	spawnChild?: PianolaChildSpawner;
}

/**
 * Pure stale-detection: of the persisted targets, which enabled ones have no
 * live supervised child? `isAlive(id)` reports whether the supervisor currently
 * has a healthy/managed child for that target. Exported and pure so the relaunch
 * decision is unit-testable without spawning a real process.
 */
export function staleTargets(
	targets: readonly PianolaSupervisedTarget[],
	isAlive: (id: string) => boolean
): PianolaSupervisedTarget[] {
	return targets.filter((t) => t.enabled && !isAlive(t.id));
}

/**
 * Owns the lifecycle of Pianola's supervised background processes. One instance
 * is constructed in the main process and wired into app start/quit.
 */
export class PianolaSupervisor {
	private readonly deps: PianolaSupervisorDeps;
	private readonly children = new Map<string, SupervisedChild>();
	private watcher: fs.FSWatcher | null = null;
	private reconcileTimer: ReturnType<typeof setTimeout> | undefined;
	private started = false;
	private readonly spawnChild: PianolaChildSpawner;

	constructor(deps: PianolaSupervisorDeps) {
		this.deps = deps;
		this.spawnChild = deps.spawnChild ?? ((command, args, opts) => spawn(command, args, opts));
	}

	/** Begin watching the store file and reconcile immediately. Idempotent. */
	start(): void {
		if (this.started) return;
		this.started = true;
		this.startWatching();
		this.reconcile();
	}

	/**
	 * Bring running children in line with the persisted, enabled targets. Spawns
	 * enabled targets that have no live child; stops children whose target was
	 * removed or disabled. When the Encore flag is off, kills everything and
	 * spawns nothing.
	 */
	reconcile(): void {
		if (!this.deps.isEnabled()) {
			this.killAll();
			return;
		}

		const targets = readSupervisorTargets();
		const byId = new Map(targets.map((t) => [t.id, t] as const));

		// Stop and forget children whose target was removed or disabled.
		for (const id of [...this.children.keys()]) {
			const target = byId.get(id);
			if (!target || !target.enabled) {
				this.stopChild(id);
				this.children.delete(id);
			}
		}

		// Spawn enabled targets with no live child; refresh config on the rest so a
		// later restart uses the latest args. A target already in backing-off keeps
		// its scheduled restart; a stopped/failed target is not auto-restarted here.
		for (const target of targets) {
			if (!target.enabled) continue;
			const existing = this.children.get(target.id);
			if (!existing) {
				this.spawn(target);
			} else {
				existing.target = target;
			}
		}
	}

	/**
	 * Re-read the persisted targets and (re)start any enabled target that should
	 * be running but whose supervised child is not alive - one that crashed and
	 * gave up after the restart cap, or was never spawned. Returns the count
	 * relaunched. No-op when the Encore flag is off. The rapid-flap protection is
	 * preserved: a target mid-backoff (a restart already scheduled) and a target
	 * that finished cleanly are both treated as alive and left alone. Because a
	 * cadenced relaunch is not rapid flapping, a relaunched target's failure
	 * streak is reset so it gets a full restart budget again.
	 */
	relaunchStale(): number {
		if (!this.deps.isEnabled()) return 0;
		const targets = readSupervisorTargets();
		const stale = staleTargets(targets, (id) => this.isAlive(id));
		for (const target of stale) {
			const existing = this.children.get(target.id);
			if (existing) {
				existing.restarts = 0;
				if (existing.backoffTimer) {
					clearTimeout(existing.backoffTimer);
					existing.backoffTimer = undefined;
				}
			}
			this.spawn(target);
		}
		if (stale.length > 0) {
			logger.info(`Relaunched ${stale.length} stale supervised target(s)`, LOG_CONTEXT);
		}
		return stale.length;
	}

	/**
	 * Whether a supervised child for `id` is currently alive or in a managed state
	 * that must not be disturbed. A live process is alive; a target mid-backoff
	 * (restart pending) is alive regardless of kind. A cleanly/intentionally
	 * stopped target is kind-aware: a 'watch' should keep running, so a stopped
	 * watch is NOT alive (stale -> relaunch); an 'orchestrate' clean exit is
	 * terminal, so a stopped orchestrate stays alive. A failed or never-spawned
	 * target is not alive and therefore stale.
	 */
	private isAlive(id: string): boolean {
		const entry = this.children.get(id);
		if (!entry) return false;
		const child = entry.child;
		const hasLiveChild = !!child && child.exitCode === null && child.signalCode === null;
		if (hasLiveChild) return true;
		if (entry.state === 'backing-off') return true;
		if (entry.state === 'stopped') return entry.target.kind === 'orchestrate';
		return false;
	}

	/** Per-target health for the dashboard. Returns fresh objects (no internal refs). */
	getHealth(): PianolaSupervisorHealth[] {
		const out: PianolaSupervisorHealth[] = [];
		for (const entry of this.children.values()) {
			const health: PianolaSupervisorHealth = {
				id: entry.target.id,
				kind: entry.target.kind,
				state: entry.state,
				restarts: entry.restarts,
				recentLogs: entry.logs.slice(-MAX_HEALTH_LOG_LINES),
			};
			const pid = entry.child?.pid;
			if (typeof pid === 'number') health.pid = pid;
			if (entry.lastError) health.lastError = entry.lastError;
			if (entry.startedAt) health.startedAt = entry.startedAt;
			out.push(health);
		}
		return out;
	}

	/** Kill all children and tear down the watcher (app quit). Idempotent. */
	stopAll(): void {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		if (this.reconcileTimer) {
			clearTimeout(this.reconcileTimer);
			this.reconcileTimer = undefined;
		}
		for (const entry of this.children.values()) {
			if (entry.backoffTimer) {
				clearTimeout(entry.backoffTimer);
				entry.backoffTimer = undefined;
			}
			entry.stopping = true;
			entry.state = 'stopped';
			const child = entry.child;
			if (child && child.exitCode === null && child.signalCode === null) {
				this.killProcess(child, true);
			}
			entry.child = null;
		}
		this.children.clear();
		this.started = false;
	}

	/** Watch the store file's directory and reconcile (debounced) on change. */
	private startWatching(): void {
		const filePath = supervisorFilePath();
		const dir = path.dirname(filePath);
		const filename = path.basename(filePath);
		try {
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			// Watch the directory rather than the file: fs.watch on a not-yet-created
			// file throws, and atomic temp+rename writes replace the inode anyway.
			this.watcher = fs.watch(dir, (_event, changed) => {
				// Some platforms report a null filename; reconcile to be safe.
				if (changed && changed !== filename) return;
				this.scheduleReconcile();
			});
			this.watcher.on('error', (error) => {
				logger.error(`Supervisor watcher error: ${error.message}`, LOG_CONTEXT);
			});
		} catch (error) {
			// A watch failure is unexpected (permissions etc.). Report it but do not
			// crash startup; reconcile still runs on app start, IPC, and quit.
			void captureException(error, { operation: 'pianola:supervisor:watch', dir });
		}
	}

	private scheduleReconcile(): void {
		if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
		this.reconcileTimer = setTimeout(() => {
			this.reconcileTimer = undefined;
			this.reconcile();
		}, WATCH_DEBOUNCE_MS);
	}

	/** Build the maestro-cli argv for a target, or null if it cannot spawn. */
	private buildArgs(target: PianolaSupervisedTarget): string[] | null {
		if (target.kind === 'watch') {
			if (!target.tabId || !target.agentId) return null;
			return [
				'pianola',
				'watch',
				target.tabId,
				'--agent',
				target.agentId,
				'--interval',
				String(target.intervalSeconds ?? 5),
			];
		}
		if (!target.planId) return null;
		return [
			'pianola',
			'orchestrate',
			target.planId,
			'--concurrency',
			String(target.concurrency ?? 3),
			'--interval',
			String(target.intervalSeconds ?? 5),
		];
	}

	/** Spawn (or respawn) one target's supervised child process. */
	private spawn(target: PianolaSupervisedTarget): void {
		const cliScriptPath = resolveMaestroCliScriptPath();
		const args = this.buildArgs(target);
		if (!args) {
			// The validator should have dropped these, but never spawn a bad command.
			logger.warn(`Skipping supervised target ${target.id}: incomplete config`, LOG_CONTEXT);
			return;
		}

		let entry = this.children.get(target.id);
		if (!entry) {
			entry = {
				target,
				child: null,
				state: 'running',
				restarts: 0,
				logs: [],
				stopping: false,
			};
			this.children.set(target.id, entry);
		}
		entry.target = target;
		entry.stopping = false;

		let child: ChildProcess;
		try {
			child = this.spawnChild(process.execPath, [cliScriptPath, ...args], {
				env: {
					...process.env,
					// In packaged Electron, process.execPath is the app binary, not
					// Node; without this it would launch the app instead of the CLI.
					ELECTRON_RUN_AS_NODE: '1',
					// Tell the watch/orchestrate process which agent IS Pianola (so it
					// never acts on itself and can route decision handoffs) and where the
					// bundled CLI is for any sub-invocations.
					MAESTRO_AGENT_ID: this.deps.getPianolaAgentId() ?? '',
					MAESTRO_CLI_JS: cliScriptPath,
				},
				stdio: ['ignore', 'pipe', 'pipe'],
				// Not detached: supervised children must die with the desktop app.
			});
		} catch (error) {
			entry.lastError = error instanceof Error ? error.message : String(error);
			const errCode = (error as NodeJS.ErrnoException)?.code;
			if (errCode !== 'ENOENT') {
				void captureException(error, { operation: 'pianola:supervisor:spawn', cliScriptPath });
			}
			this.scheduleRestart(entry);
			return;
		}

		entry.child = child;
		entry.state = 'running';
		entry.startedAt = Date.now();

		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (data: string) => this.appendLog(entry, data));
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (data: string) => this.appendLog(entry, data));

		child.on('error', (error) => {
			entry.lastError = error instanceof Error ? error.message : String(error);
			const errCode = (error as NodeJS.ErrnoException).code;
			if (errCode !== 'ENOENT') {
				void captureException(error, { operation: 'pianola:supervisor:child', id: target.id });
			}
		});

		child.on('exit', (code, signal) => {
			entry.child = null;
			// Intentional kill (disable/remove/quit): stay stopped, never restart.
			if (entry.stopping) {
				entry.state = 'stopped';
				return;
			}
			// Encore revoked mid-run: do not restart.
			if (!this.deps.isEnabled()) {
				entry.state = 'stopped';
				return;
			}
			// A child that ran long enough counts as recovered: reset the failure
			// streak so "5 consecutive failures" means rapid flapping, not lifetime.
			if (entry.startedAt && Date.now() - entry.startedAt >= STABLE_RUN_MS) {
				entry.restarts = 0;
			}
			// Clean exit (code 0): success. An orchestrate run finishing its plan is
			// expected; do not restart.
			if (code === 0) {
				entry.state = 'stopped';
				return;
			}
			// Unexpected exit: back off and retry, capped at MAX_RESTARTS.
			entry.lastError = signal
				? `killed by signal ${signal}`
				: `exited with code ${code ?? 'null'}`;
			this.scheduleRestart(entry);
		});
	}

	/** Schedule an exponential-backoff restart, or mark failed after the cap. */
	private scheduleRestart(entry: SupervisedChild): void {
		entry.restarts += 1;
		if (entry.restarts > MAX_RESTARTS) {
			entry.state = 'failed';
			logger.warn(
				`Supervised target ${entry.target.id} failed after ${MAX_RESTARTS} restarts; giving up`,
				LOG_CONTEXT
			);
			return;
		}
		entry.state = 'backing-off';
		const delay = Math.min(BACKOFF_BASE_MS * 2 ** (entry.restarts - 1), BACKOFF_CAP_MS);
		if (entry.backoffTimer) clearTimeout(entry.backoffTimer);
		entry.backoffTimer = setTimeout(() => {
			entry.backoffTimer = undefined;
			// Re-check consent and that the target still exists + is enabled.
			if (!this.deps.isEnabled()) {
				entry.state = 'stopped';
				return;
			}
			const target = readSupervisorTargets().find((t) => t.id === entry.target.id);
			if (!target || !target.enabled) {
				entry.state = 'stopped';
				this.children.delete(entry.target.id);
				return;
			}
			this.spawn(target);
		}, delay);
	}

	/** Append child output to the bounded ring buffer. */
	private appendLog(entry: SupervisedChild, data: string): void {
		for (const line of data.split('\n')) {
			if (line.length === 0) continue;
			entry.logs.push(line);
		}
		if (entry.logs.length > MAX_LOG_LINES) {
			entry.logs = entry.logs.slice(entry.logs.length - MAX_LOG_LINES);
		}
	}

	/** Stop one child by id (marks stopping so the exit handler will not restart). */
	private stopChild(id: string): void {
		const entry = this.children.get(id);
		if (!entry) return;
		if (entry.backoffTimer) {
			clearTimeout(entry.backoffTimer);
			entry.backoffTimer = undefined;
		}
		entry.stopping = true;
		entry.state = 'stopped';
		const child = entry.child;
		if (child && child.exitCode === null && child.signalCode === null) {
			this.killProcess(child, false);
		}
	}

	/** Kill all children but leave the watcher running (so a re-enable reconciles). */
	private killAll(): void {
		for (const id of [...this.children.keys()]) {
			this.stopChild(id);
			this.children.delete(id);
		}
	}

	/**
	 * Kill a child process and its tree. On Windows uses taskkill /t so the node
	 * process and any descendants are reaped. On POSIX sends SIGTERM then escalates
	 * to SIGKILL - immediately on the shutdown path (the event loop may drain before
	 * a deferred timer fires), or after a grace period otherwise.
	 */
	private killProcess(child: ChildProcess, sync: boolean): void {
		if (isWindows() && child.pid) {
			if (sync) {
				try {
					execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { timeout: 5000 });
				} catch {
					// taskkill exits non-zero when the process is already gone - fine.
				}
			} else {
				execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], (error) => {
					if (!error) return;
					if (child.exitCode !== null || child.signalCode !== null) return;
					void captureException(error, {
						operation: 'pianola:supervisor:taskkill',
						pid: child.pid,
					});
				});
			}
			return;
		}
		child.kill('SIGTERM');
		if (sync) {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGKILL');
			}
			return;
		}
		setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGKILL');
			}
		}, SIGKILL_DELAY_MS);
	}
}
