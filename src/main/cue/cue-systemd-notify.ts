/**
 * systemd supervision for the standalone Cue engine (`Type=notify` units).
 *
 * Node cannot write to the unix datagram socket in `NOTIFY_SOCKET`, so each
 * message is sent by spawning `systemd-notify`; the unit's `NotifyAccess=all`
 * is what makes systemd accept a message from that child. Everything here is
 * driven by the engine's one health object (`cue-engine-health.ts`), the same
 * one behind `/healthz` and `/readyz`, so systemd and the status server cannot
 * disagree.
 *
 * What is sent:
 * - `READY=1 MAINPID=<pid> STATUS=...` when the engine reaches `running`
 *   (readiness checked, lock held, triggers armed). A running engine with
 *   readiness gaps still sends READY: READY means "start-up finished", like
 *   `/readyz`'s phase, and withholding it would have systemd kill a working
 *   engine at TimeoutStartSec. The gaps are in STATUS and in `/readyz`.
 * - `WATCHDOG=1` every `WATCHDOG_USEC / 2`, but ONLY while `/healthz` would
 *   answer 200 (lock held, event loop not saturated). Not pinging is the
 *   point: systemd restarts an engine that stopped being alive.
 * - `STOPPING=1` when the drain starts, then `STATUS=` per drain phase.
 *
 * The form is raw `VARIABLE=VALUE` arguments only. `--stopping` does not exist
 * before systemd 253 (Debian 12 ships 252, Ubuntu 22.04 249). No `--no-block`:
 * since 246 `systemd-notify` waits until the manager has processed the
 * message, which is what lets systemd attribute it to the unit even though the
 * sender exits at once.
 *
 * `NOTIFY_SOCKET` and `WATCHDOG_*` are removed from this process's environment
 * once read, as `sd_notify(unset_environment=1)` does: otherwise every agent
 * and shell step Cue spawns inherits them and, under NotifyAccess=all, could
 * notify systemd on the engine's behalf.
 *
 * No Electron imports.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { evaluateLiveness, type CueEngineHealth } from './cue-engine-health';

/** A `systemd-notify` that has not answered by now is killed (Node's spawn timeout). */
export const SYSTEMD_NOTIFY_TIMEOUT_MS = 5_000;

export type SystemdNotifySpawn = (
	command: string,
	args: string[],
	options: SpawnOptions
) => ChildProcess;

export interface SystemdNotifierOptions {
	/** Where `NOTIFY_SOCKET` / `WATCHDOG_*` are read from, and removed from. Normally `process.env`. */
	env: NodeJS.ProcessEnv;
	health: CueEngineHealth;
	onLog: (level: string, message: string) => void;
	/** Injectable for tests. */
	spawnImpl?: SystemdNotifySpawn;
	pid?: number;
}

export interface SystemdNotifier {
	/** Begin following the health object. */
	start(): void;
	/** Stop the watchdog and stop following. Sends nothing. */
	stop(): void;
	/**
	 * Resolves once every queued message has been handed to systemd, or after
	 * `timeoutMs`. The exit path awaits it so the drain's last STATUS lines are
	 * not lost to `process.exit`.
	 */
	flush(timeoutMs: number): Promise<void>;
	/** The watchdog ping interval, or null when systemd set no watchdog for this process. */
	readonly watchdogIntervalMs: number | null;
}

/** `WATCHDOG_USEC / 2` in ms when the watchdog applies to `pid` (the `sd_watchdog_enabled` rule), else null. */
export function watchdogIntervalMs(
	usec: string | undefined,
	watchdogPid: string | undefined,
	pid: number
): number | null {
	if (!usec || !/^\d+$/.test(usec)) return null;
	const micros = Number(usec);
	if (!Number.isSafeInteger(micros) || micros <= 0) return null;
	if (watchdogPid !== undefined && watchdogPid !== '' && Number(watchdogPid) !== pid) return null;
	return Math.max(1, Math.floor(micros / 2 / 1000));
}

/** Build the notifier, or null (and nothing is ever spawned) when not running under systemd. */
export function createSystemdNotifier(options: SystemdNotifierOptions): SystemdNotifier | null {
	const { env, health, onLog } = options;
	const socket = env.NOTIFY_SOCKET;
	if (!socket) return null;
	const pid = options.pid ?? process.pid;
	const interval = watchdogIntervalMs(env.WATCHDOG_USEC, env.WATCHDOG_PID, pid);
	const childEnv: NodeJS.ProcessEnv = { PATH: env.PATH, NOTIFY_SOCKET: socket };
	delete env.NOTIFY_SOCKET;
	delete env.WATCHDOG_USEC;
	delete env.WATCHDOG_PID;
	const spawnImpl = options.spawnImpl ?? nodeSpawn;

	let disabled = false;
	let inFlight = false;
	/** Messages waiting for the child in flight; STATUS-only entries coalesce. */
	const queue: string[][] = [];
	let failing = false;
	let failures = 0;
	let watchdog: ReturnType<typeof setInterval> | null = null;
	let unsubscribe: (() => void) | null = null;
	let idleWaiters: Array<() => void> = [];
	const isIdle = () => disabled || (!inFlight && queue.length === 0);
	function notifyIdle(): void {
		if (!isIdle()) return;
		const waiters = idleWaiters;
		idleWaiters = [];
		for (const resolve of waiters) resolve();
	}

	function settle(ok: boolean, reason: string): void {
		inFlight = false;
		if (ok) {
			if (failing) {
				onLog('info', `systemd-notify works again after ${failures} failed message(s)`);
			}
			failing = false;
			failures = 0;
		} else {
			failures++;
			if (!failing) {
				onLog(
					'warn',
					`systemd-notify failed (${reason}); systemd may not see this engine's state. Further failures are not logged until one succeeds.`
				);
			}
			failing = true;
		}
		pump();
	}

	function run(args: string[]): void {
		inFlight = true;
		let child: ChildProcess;
		try {
			child = spawnImpl('systemd-notify', args, {
				stdio: 'ignore',
				env: childEnv,
				timeout: SYSTEMD_NOTIFY_TIMEOUT_MS,
				killSignal: 'SIGKILL',
			});
		} catch (err) {
			handleSpawnError(err);
			return;
		}
		let done = false;
		child.once('error', (err) => {
			if (done) return;
			done = true;
			handleSpawnError(err);
		});
		child.once('exit', (code, signal) => {
			if (done) return;
			done = true;
			settle(code === 0, signal ? `killed by ${signal}` : `exit code ${code}`);
		});
	}

	function handleSpawnError(err: unknown): void {
		const code = (err as NodeJS.ErrnoException | null)?.code;
		if (code === 'ENOENT') {
			disabled = true;
			inFlight = false;
			queue.length = 0;
			clearWatchdog();
			notifyIdle();
			onLog(
				'warn',
				'systemd-notify was not found on PATH; systemd notifications are disabled (install systemd, or drop Type=notify from the unit).'
			);
			return;
		}
		settle(false, err instanceof Error ? err.message : String(err));
	}

	function pump(): void {
		if (disabled || inFlight) {
			notifyIdle();
			return;
		}
		const next = queue.shift();
		if (next) run(next);
		else notifyIdle();
	}

	function send(args: string[]): void {
		if (disabled) return;
		// A STATUS-only update replaces a STATUS-only update still waiting.
		const statusOnly = args.length === 1 && args[0].startsWith('STATUS=');
		const last = queue[queue.length - 1];
		if (statusOnly && last && last.length === 1 && last[0].startsWith('STATUS=')) {
			queue[queue.length - 1] = args;
		} else {
			queue.push(args);
		}
		pump();
	}

	function ping(): void {
		// Skipped, not queued: a manager that is not answering must not pile
		// up children, and the next tick tries again.
		if (disabled || inFlight || queue.length > 0) return;
		if (!evaluateLiveness(health).ok) return;
		run(['WATCHDOG=1']);
	}

	function clearWatchdog(): void {
		if (watchdog) clearInterval(watchdog);
		watchdog = null;
	}

	const status = (text: string) => `STATUS=${text.replace(/[\r\n]+/g, ' ')}`;

	return {
		watchdogIntervalMs: interval,
		start() {
			if (unsubscribe || disabled) return;
			unsubscribe = health.subscribe((change) => {
				if (change.kind === 'phase') {
					if (change.phase === 'running') {
						send(['READY=1', `MAINPID=${pid}`, status(health.statusText())]);
						if (interval !== null && !watchdog) {
							watchdog = setInterval(ping, interval);
							watchdog.unref?.();
						}
					} else if (change.phase === 'draining') {
						send(['STOPPING=1', status('Draining')]);
					} else {
						send([status(health.statusText())]);
					}
				} else if (change.kind === 'readiness') {
					if (health.phase() === 'running') send([status(health.statusText())]);
				} else {
					send([status(`Draining: ${change.message}`)]);
				}
			});
		},
		stop() {
			clearWatchdog();
			unsubscribe?.();
			unsubscribe = null;
		},
		flush(timeoutMs) {
			if (isIdle()) return Promise.resolve();
			return new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, timeoutMs);
				timer.unref?.();
				idleWaiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		},
	};
}
