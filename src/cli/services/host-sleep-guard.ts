/**
 * Keep a macOS host awake while it has work in flight (`maestro-cli host`).
 *
 * A Mac mini that serves agents would otherwise idle-sleep in the middle of a turn or an Auto Run.
 * While the host has work, the guard holds a `caffeinate -i -w <host pid>` child: `-i` blocks idle
 * sleep only (the display may still sleep, and a closed lid still sleeps), and `-w` ends caffeinate
 * when the host exits, so a crashed host never leaves the machine awake. When the host goes idle the
 * child is killed and the machine may sleep again.
 *
 * On every other platform the guard does nothing. Linux and Windows hosts are servers here, and their
 * own power policy is the operator's (systemd-inhibit, a server profile).
 */

import { spawn, type ChildProcess } from 'child_process';

import { isMacOS } from '../../shared/platformDetection';

export interface HostSleepGuardOptions {
	/** `false` for `host start --no-prevent-sleep`: the guard never holds. */
	enabled: boolean;
	/** The host's pid, which caffeinate waits on. */
	pid: number;
	log(line: string): void;
}

export interface HostSleepGuard {
	/** Hold or release to match whether the host has work in flight. Cheap to call often. */
	update(hasWork: boolean): void;
	/** Is a caffeinate child holding the machine awake right now? */
	holding(): boolean;
	/** Release for good: the host is stopping. Later `update` calls do nothing. */
	stop(): void;
}

const CAFFEINATE = 'caffeinate';

export function createHostSleepGuard(options: HostSleepGuardOptions): HostSleepGuard {
	const active = options.enabled && isMacOS();
	let child: ChildProcess | undefined;
	let stopped = false;
	// A caffeinate that cannot start (missing, refused) is said once, not on every work change.
	let unavailable = false;

	const release = (why: string): void => {
		const holder = child;
		child = undefined;
		if (!holder) return;
		holder.kill();
		options.log(`Allowing sleep: ${why}.`);
	};

	const hold = (): void => {
		let holder: ChildProcess;
		try {
			holder = spawn(CAFFEINATE, ['-i', '-w', String(options.pid)], { stdio: 'ignore' });
		} catch (error) {
			unavailable = true;
			options.log(
				`Could not prevent sleep (caffeinate did not start: ${error instanceof Error ? error.message : String(error)}). The Mac may sleep during work.`
			);
			return;
		}
		child = holder;
		// The host's own lifetime is not tied to this child.
		holder.unref();
		holder.once('error', (error) => {
			if (child === holder) child = undefined;
			unavailable = true;
			options.log(
				`Could not prevent sleep (caffeinate failed: ${error.message}). The Mac may sleep during work.`
			);
		});
		// Killed by someone else: the next work change holds again.
		holder.once('exit', () => {
			if (child === holder) child = undefined;
		});
		options.log(`Preventing sleep while work is in flight (caffeinate pid ${holder.pid ?? '?'}).`);
	};

	return {
		update(hasWork) {
			if (!active || stopped) return;
			if (hasWork && !child && !unavailable) hold();
			else if (!hasWork && child) release('the host is idle');
		},
		holding: () => child !== undefined,
		stop() {
			stopped = true;
			release('the host is stopping');
		},
	};
}
