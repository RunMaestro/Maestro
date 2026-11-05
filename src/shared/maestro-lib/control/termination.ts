// src/shared/maestro-lib/control/termination.ts

import { execFile, execFileSync, type ChildProcess } from 'child_process';
import type * as pty from 'node-pty';

import { captureException, logger } from '../host';
import { isWindows } from '../../platformDetection';
import { killPty } from './pty-kill';
import {
	killProcessTreeNow,
	killSurvivors,
	refreshProcessTree,
	snapshotProcessTree,
	type ProcessTreeSnapshot,
} from './process-tree';

/** Grace between stages for a turn someone is watching: desktop chat, terminal tabs. */
export const INTERACTIVE_STOP_GRACE_MS = 2000;

/** Grace between stages for an unattended run: Cue, the CLI, the pianola supervisor. */
export const BACKGROUND_STOP_GRACE_MS = 5000;

const TASKKILL_TIMEOUT_MS = 5000;

/**
 * How often the descendant record is re-read while a stop is pending, so a
 * tool the agent starts AFTER the stop was requested is recorded too.
 */
export const TREE_REFRESH_MS = 250;
const LOG_CONTEXT = 'Termination';

/**
 * The three stages of stopping a process, in order.
 *
 * | Stage       | POSIX pipe child | POSIX PTY         | Windows                 |
 * | ----------- | ---------------- | ----------------- | ----------------------- |
 * | `interrupt` | SIGINT           | Ctrl+C on the PTY | Ctrl+C on stdin or PTY  |
 * | `terminate` | SIGTERM          | SIGTERM           | `taskkill /t /f`        |
 * | `kill`      | SIGKILL the tree | SIGKILL the tree  | done by `terminate`     |
 */
export type StopStage = 'interrupt' | 'terminate' | 'kill';

const STAGE_ORDER: Record<StopStage, number> = { interrupt: 0, terminate: 1, kill: 2 };

export interface StopTarget {
	/** A pipe-backed child process. */
	child?: ChildProcess;
	/** A PTY-backed process. */
	pty?: pty.IPty;
	/** Defaults to the child's or the PTY's own pid. */
	pid?: number;
}

export interface StopOptions {
	/**
	 * The first stage to run. A stop the user asked for starts at `interrupt` so
	 * the agent can end its turn itself; a closed tab, a timeout or an aborted
	 * run starts at `terminate`.
	 */
	from: StopStage;
	/** How long a stage gets before the next one runs. */
	graceMs: number;
	/**
	 * The last stage this request may run; `kill` when omitted. A host that is
	 * quitting passes `terminate` for an agent that should get SIGTERM and the
	 * chance to write its state, with no SIGKILL sent right behind it.
	 */
	upTo?: StopStage;
	/**
	 * Called before the first signal. The caller records here that the stop was
	 * asked for, so the exit that follows resolves as `interrupted` rather than
	 * as a crash caused by a signal nobody requested.
	 */
	onStopRequested?: () => void;
	/**
	 * Run every remaining stage now, with no timer and no exit listener. For
	 * shutdown: the event loop may drain before a timer fires, and a listener
	 * left on a PTY races Electron's environment teardown (MAESTRO-3B).
	 */
	immediate?: boolean;
	/** Wait for `taskkill` to return, so the tree is gone before the host exits. */
	blocking?: boolean;
	/**
	 * Also stop what the process started. On by default. Turn it off for a
	 * terminal tab's shell: a job the user deliberately left running there is
	 * theirs to keep. The latest request decides: turning it off also leaves
	 * alone a tree an earlier stop on the same process recorded.
	 */
	includeDescendants?: boolean;
	sessionId?: string;
	label?: string;
}

export interface StopHandle {
	/** The stage reached so far; `undefined` when there was nothing left to stop. */
	stage(): StopStage | undefined;
	/** Drop the pending escalation and the exit listener. Sends no signal. */
	dispose(): void;
}

interface Ladder {
	handle: StopHandle;
	request(options: StopOptions, runActivity?: <T>(operation: () => T) => T): void;
}

const INERT_HANDLE: StopHandle = { stage: () => undefined, dispose: () => {} };

// One ladder per process, so a second stop (Stop pressed twice, a tab closed
// while a Stop is pending) advances the ladder already running instead of
// stacking a second set of timers beside it.
const ladders = new WeakMap<object, Ladder>();

/**
 * Stop a process: interrupt, then terminate, then kill its tree.
 *
 * Every launcher used to carry its own copy of this, and they had drifted.
 * Desktop's interrupt checked `child.killed` to decide whether to escalate,
 * which Node sets as soon as a signal is SENT, so on POSIX an agent that
 * ignored SIGINT was never escalated at all. Desktop's kill never followed
 * SIGTERM with SIGKILL for a pipe child. The CLI had no Windows tree kill.
 * None of them stopped what the agent had started.
 *
 * The rules, in one place:
 * - "Stop requested" is recorded before the first signal.
 * - A process is running while `exitCode` and `signalCode` are both null.
 *   `child.killed` says a signal was sent, not that anything died.
 * - Every stage schedules the next, for pipes and PTYs alike.
 * - Descendants are recorded before the first signal, re-read while the stop
 *   is pending, and swept once the process exits, because an agent that exits
 *   on a signal leaves its tools running.
 * - A tree is only killed when the pid is provably a running child of this
 *   process. Anything else gets the signal through its own handle and no more.
 *
 * Optional host activity guards requests and retained callbacks. Hosts must
 * observe returned promises to retain tree refresh, taskkill native close and
 * diagnostics through settlement. This does not establish a drained descendant
 * tree or safe cleanup, or cover work launched before a host guard was adopted.
 */
export function stopProcess(
	target: StopTarget,
	options: StopOptions,
	runActivity?: <T>(operation: () => T) => T
): StopHandle {
	const request = (): StopHandle => {
		const key = target.child ?? target.pty;
		if (!key)
			return runActivity
				? {
						stage: () => runActivity(INERT_HANDLE.stage),
						dispose: () => runActivity(INERT_HANDLE.dispose),
					}
				: INERT_HANDLE;

		const running = ladders.get(key);
		if (running) {
			running.request(options, runActivity);
			return running.handle;
		}

		const ladder = createLadder(target, key, runActivity);
		ladders.set(key, ladder);
		ladder.request(options);
		return ladder.handle;
	};
	return runActivity ? runActivity(request) : request();
}

function createLadder(
	target: StopTarget,
	key: object,
	runActivity: <T>(operation: () => T) => T = (operation) => operation()
): Ladder {
	const pid = target.pid ?? target.child?.pid ?? target.pty?.pid;
	const hasPid = typeof pid === 'number' && pid > 0;

	let stage: StopStage | undefined;
	let exited = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let refreshing = false;
	let tree: ProcessTreeSnapshot | undefined;
	// Set by the latest request. A quitting host opts out after an earlier Stop
	// already recorded the tree, and that record must then be left alone too.
	let leaveDescendants = false;
	let removeExitListener: (() => void) | undefined;
	let context: { sessionId?: string; label?: string } = {};

	const isRunning = (): boolean => {
		if (exited) return false;
		if (target.child) return target.child.exitCode === null && target.child.signalCode === null;
		return true;
	};

	const stopRefreshing = (): void => {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
	};

	const release = (): void => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		stopRefreshing();
		removeExitListener?.();
		removeExitListener = undefined;
		if (ladders.get(key)?.handle === handle) ladders.delete(key);
	};

	const sweep = (): void => {
		if (!leaveDescendants && tree && tree.descendants.length > 0) {
			killSurvivors(tree.descendants, context);
		}
		tree = undefined;
	};

	const onExit = (): void =>
		runActivity(() => {
			exited = true;
			release();
			sweep();
		});

	// The first record is taken before anything is signalled. An agent that is
	// winding down can still start a tool after that, so the record is re-read
	// until the process exits or the last stage has run.
	const refreshTree = (): void => {
		void runActivity(() => {
			const current = tree;
			if (refreshing || !current?.owned || !hasPid) return;
			refreshing = true;
			return refreshProcessTree(pid, current).then(
				(next) =>
					runActivity(() => {
						refreshing = false;
						// An exit or a sweep in the meantime owns the record; leave it.
						if (tree === current) tree = next;
					}),
				() =>
					runActivity(() => {
						refreshing = false;
					})
			);
		});
	};

	const keepTreeFresh = (): void => {
		if (refreshTimer || !tree?.owned) return;
		refreshTimer = setInterval(refreshTree, TREE_REFRESH_MS);
		refreshTimer.unref?.();
	};

	const listenForExit = (): void => {
		if (removeExitListener) return;
		if (target.child) {
			const child = target.child;
			child.once('exit', onExit);
			removeExitListener = () => child.off('exit', onExit);
		} else if (target.pty) {
			const subscription = target.pty.onExit(onExit);
			removeExitListener = () => subscription.dispose();
		}
	};

	const attempt = (action: string, send: () => void): void => {
		try {
			send();
		} catch (error) {
			// A stop racing the process's own exit is expected, not a fault.
			logger.debug(`[Termination] ${action} failed, process may be gone`, LOG_CONTEXT, {
				...context,
				pid,
				error: String(error),
			});
		}
	};

	// Called directly, never through a shell: the arguments are fixed, and
	// cmd.exe would only add a process to a tree that is being torn down.
	const taskkill = (blocking: boolean): void => {
		const args = ['/pid', String(pid), '/t', '/f'];
		// taskkill could not end the tree. End the process itself through its own
		// handle, so a stop never leaves it running. A child that is already gone
		// makes this a no-op.
		const killThroughHandle = (): void => {
			const child = target.child;
			if (child && isRunning()) attempt('kill after a failed taskkill', () => child.kill());
		};

		if (blocking) {
			try {
				execFileSync('taskkill', args, { timeout: TASKKILL_TIMEOUT_MS });
			} catch {
				// taskkill exits non-zero for a process that is already gone.
				killThroughHandle();
			}
			return;
		}
		void runActivity(() => {
			const completion = Promise.withResolvers<void>();
			// Observe before launch/listener setup. An unavailable close observer
			// must keep the host blocked rather than release an unknown native child.
			void runActivity(() => completion.promise);
			let killer: ChildProcess;
			try {
				killer = execFile('taskkill', args, (error) =>
					runActivity(() => {
						if (!error) return;
						// A process that exited before taskkill ran makes it fail benignly.
						// Only a pipe child can prove it is still running; a PTY cannot.
						if (!target.child || !isRunning()) {
							logger.debug('[Termination] taskkill failed, process may be gone', LOG_CONTEXT, {
								...context,
								pid,
								error: String(error),
							});
							return;
						}
						logger.warn('[Termination] taskkill failed for a running process', LOG_CONTEXT, {
							...context,
							pid,
							error: String(error),
						});
						// A rejecting/throwing reporter cannot prevent the synchronous
						// fallback. Hosts observe this promise independently of close.
						const reporting = Promise.resolve()
							.then(() => captureException(error, { operation: 'termination:taskkill', pid }))
							.catch(() => {});
						void runActivity(() => reporting);
						killThroughHandle();
					})
				);
			} catch (error) {
				// A synchronous execFile throw created no child. Preserve the throw.
				completion.resolve();
				throw error;
			}
			// Neither the result callback, target exit nor ladder disposal proves
			// this subprocess and its stdio have closed. Late callbacks admit anew.
			killer.once('close', () => runActivity(() => completion.resolve()));
		});
	};

	/** Send one stage's signal. Returns the stage that follows, if any. */
	const signal = (next: StopStage, options: StopOptions): StopStage | undefined => {
		const { child, pty: ptyProcess } = target;

		if (next === 'interrupt') {
			if (ptyProcess) {
				attempt('Ctrl+C on the PTY', () => ptyProcess.write('\x03'));
			} else if (child && isWindows()) {
				// POSIX signals do not reach a shell-spawned process on Windows.
				const stdin = child.stdin;
				if (stdin && !stdin.destroyed && !stdin.writableEnded) {
					attempt('Ctrl+C on stdin', () => stdin.write('\x03'));
				}
			} else if (child) {
				attempt('SIGINT', () => child.kill('SIGINT'));
			}
			return 'terminate';
		}

		if (isWindows() && hasPid) {
			// node-pty and child.kill() end only the direct child on Windows;
			// taskkill /t walks the tree, and /f leaves no later stage to run.
			taskkill(Boolean(options.blocking));
			return undefined;
		}

		if (next === 'terminate') {
			if (ptyProcess) {
				// SIGTERM, not the default SIGHUP, which a shell may survive on macOS.
				attempt('SIGTERM on the PTY', () => killPty(ptyProcess, 'SIGTERM'));
			} else if (child) {
				attempt('SIGTERM', () => child.kill('SIGTERM'));
			}
			return 'kill';
		}

		if (ptyProcess) {
			attempt('SIGKILL on the PTY', () => killPty(ptyProcess, 'SIGKILL'));
		}
		if (!leaveDescendants && tree?.owned && hasPid) {
			killProcessTreeNow(pid, context);
		} else if (child) {
			attempt('SIGKILL', () => child.kill('SIGKILL'));
		}
		return undefined;
	};

	/** Whether `next` is within what this request may send. */
	const allowed = (next: StopStage, options: StopOptions): boolean =>
		STAGE_ORDER[next] <= STAGE_ORDER[options.upTo ?? 'kill'];

	const run = (next: StopStage, options: StopOptions): void => {
		if (timer) clearTimeout(timer);
		timer = undefined;

		if (!isRunning()) {
			onExit();
			return;
		}

		if (stage !== undefined && STAGE_ORDER[next] > STAGE_ORDER[stage]) {
			logger.warn('[Termination] Process outlived a stop stage, escalating', LOG_CONTEXT, {
				...context,
				pid,
				from: stage,
				to: next,
			});
		}
		stage = next;

		const afterSignal = signal(next, options);
		const following = afterSignal && allowed(afterSignal, options) ? afterSignal : undefined;
		if (!following) {
			// Nothing further will be sent, so there is nothing left to record for.
			stopRefreshing();
			if (options.immediate) {
				release();
				sweep();
			}
			return;
		}
		if (options.immediate) {
			run(following, options);
			return;
		}
		timer = setTimeout(() => runActivity(() => run(following, options)), options.graceMs);
		timer.unref?.();
	};

	const request = (options: StopOptions): void => {
		context = { sessionId: options.sessionId, label: options.label };
		leaveDescendants = options.includeDescendants === false;
		options.onStopRequested?.();

		if (!isRunning()) {
			onExit();
			return;
		}

		if (tree === undefined && options.includeDescendants !== false && hasPid) {
			tree = snapshotProcessTree(pid);
		}
		if (options.immediate) {
			stopRefreshing();
			removeExitListener?.();
			removeExitListener = undefined;
		} else {
			listenForExit();
			keepTreeFresh();
		}

		// A stage already reached is never run twice; its escalation is pending.
		if (stage !== undefined && STAGE_ORDER[options.from] <= STAGE_ORDER[stage]) {
			if (!options.immediate) return;
			const next = stage === 'kill' ? 'kill' : nextStage(stage);
			if (allowed(next, options)) {
				run(next, options);
				return;
			}
			// An earlier stop already sent all this one may. Its escalation is
			// dropped rather than left to fire: a quitting host capped at SIGTERM
			// must not have a SIGKILL follow from a Stop the user pressed before.
			release();
			sweep();
			return;
		}
		run(options.from, options);
	};

	const handle: StopHandle = {
		stage: () => runActivity(() => stage),
		dispose: () => runActivity(release),
	};

	return {
		handle,
		request: (options, activity = runActivity) =>
			activity(() => {
				// Upgrade an existing portable ladder; omitted injection never drops
				// the current guard, including callbacks retained before this request.
				runActivity = activity;
				request(options);
			}),
	};
}

function nextStage(stage: Exclude<StopStage, 'kill'>): StopStage {
	return stage === 'interrupt' ? 'terminate' : 'kill';
}
