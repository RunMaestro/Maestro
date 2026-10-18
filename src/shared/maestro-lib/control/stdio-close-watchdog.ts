import type { ChildProcess } from 'child_process';

/**
 * How long `close` may lag `exit` before the stdio streams are torn down.
 *
 * Node emits `exit` the moment the child dies and `close` only once every
 * stdio stream has ALSO closed. The gap is normally microseconds (trailing
 * stdout draining), which is why completion is keyed on `close`. Five seconds
 * is orders of magnitude past any real drain.
 */
export const STDIO_CLOSE_GRACE_MS = 5000;

/**
 * Guarantee that `close` follows `exit`.
 *
 * `close` waits for every holder of the stdio pipes, not just the child we
 * spawned. Anything that inherited or was handed those descriptors keeps them
 * open after the child is gone: a grandchild the agent left running, or an SSH
 * ControlMaster, which receives a mux client's stdio over the control socket
 * and keeps it until the remote channel winds down. When that happens `close`
 * never arrives, the exit handler never runs, and the process entry owns its
 * session key forever. ProcessManager then refuses every later spawn on that
 * tab ("already running") while the OS has no such process, and the queue
 * drain re-dispatches into the refusal on every render.
 *
 * So once the child has exited, give `close` a grace period, then destroy the
 * streams ourselves. Destroying them is what makes node emit `close`, so the
 * normal exit path runs exactly once and settles the turn. The data lost is
 * whatever a stray holder writes more than {@link STDIO_CLOSE_GRACE_MS} after
 * the process it belongs to died.
 *
 * Uses `on` rather than `once` on purpose: each handler clears itself, and the
 * spawner's test doubles only implement `on`.
 */
export function armStdioCloseWatchdog(
	child: Pick<ChildProcess, 'on' | 'stdin' | 'stdout' | 'stderr'>,
	opts: { graceMs?: number; onForceClose?: () => void } = {}
): void {
	const graceMs = opts.graceMs ?? STDIO_CLOSE_GRACE_MS;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let closed = false;

	child.on('exit', () => {
		if (closed || timer) return;
		timer = setTimeout(() => {
			timer = null;
			if (closed) return;
			opts.onForceClose?.();
			for (const stream of [child.stdin, child.stdout, child.stderr]) {
				if (stream && !stream.destroyed) stream.destroy();
			}
		}, graceMs);
	});

	child.on('close', () => {
		closed = true;
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	});
}
