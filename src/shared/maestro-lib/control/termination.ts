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
	 * theirs to keep.
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
	request(options: StopOptions): void;
	finished(): boolean;
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
 */
export function stopProcess(target: StopTarget, options: StopOptions): StopHandle {
	const key = target.child ?? target.pty;
	if (!key) return INERT_HANDLE;

	const running = ladders.get(key);
	if (running && !running.finished()) {
		running.request(options);
		return running.handle;
	}

	const ladder = createLadder(target, key);
	ladders.set(key, ladder);
	ladder.request(options);
	return ladder.handle;
}

function createLadder(target: StopTarget, key: object): Ladder {
	const pid = target.pid ?? target.child?.pid ?? target.pty?.pid;
	const hasPid = typeof pid === 'number' && pid > 0;

	let stage: StopStage | undefined;
	let done = false;
	let exited = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let refreshing = false;
	let tree: ProcessTreeSnapshot | undefined;
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
		done = true;
		ladders.delete(key);
	};

	const sweep = (): void => {
		if (tree && tree.descendants.length > 0) killSurvivors(tree.descendants, context);
		tree = undefined;
	};

	const onExit = (): void => {
		exited = true;
		release();
		sweep();
	};

	// The first record is taken before anything is signalled. An agent that is
	// winding down can still start a tool after that, so the record is re-read
	// until the process exits or the last stage has run.
	const refreshTree = (): void => {
		const current = tree;
		if (refreshing || !current?.owned || !hasPid) return;
		refreshing = true;
		void refreshProcessTree(pid, current).then(
			(next) => {
				refreshing = false;
				// An exit or a sweep in the meantime owns the record; leave it.
				if (tree === current) tree = next;
			},
			() => {
				refreshing = false;
			}
		);
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
		execFile('taskkill', args, (error) => {
			if (!error) return;
			// A process that exited before taskkill ran makes it fail benignly.
			// Only a pipe child can prove it is still running (its exit state is
			// locale-independent, unlike taskkill's message); a PTY cannot, so its
			// failure is logged and not reported.
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
			void captureException(error, { operation: 'termination:taskkill', pid });
			killThroughHandle();
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
		if (tree?.owned && hasPid) {
			killProcessTreeNow(pid, context);
		} else if (child) {
			attempt('SIGKILL', () => child.kill('SIGKILL'));
		}
		return undefined;
	};

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
		const following =
			afterSignal && STAGE_ORDER[afterSignal] <= STAGE_ORDER[options.upTo ?? 'kill']
				? afterSignal
				: undefined;
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
		timer = setTimeout(() => run(following, options), options.graceMs);
		timer.unref?.();
	};

	const request = (options: StopOptions): void => {
		context = { sessionId: options.sessionId, label: options.label };
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
			if (options.immediate) run(stage === 'kill' ? 'kill' : nextStage(stage), options);
			return;
		}
		run(options.from, options);
	};

	const handle: StopHandle = {
		stage: () => stage,
		dispose: release,
	};

	return { handle, request, finished: () => done };
}

function nextStage(stage: Exclude<StopStage, 'kill'>): StopStage {
	return stage === 'interrupt' ? 'terminate' : 'kill';
}
