/**
 * Cue Presence Monitor - is the human at the machine right now?
 *
 * Feeds the `presence.return` / `presence.leave` trigger sources. One monitor
 * serves every presence subscription in the process: it turns raw OS signals
 * into two transitions, `away` (the user stopped using the machine) and
 * `return` (they came back), each carrying when the absence began.
 *
 * Signals come from two places:
 *  - EVENTS, which arrive the instant they happen: screen lock / unlock,
 *    system suspend / resume, and fast-user-switch session resign / become
 *    active. On macOS these are the NSWorkspace / distributed notifications
 *    Electron's `powerMonitor` already listens to, so there is nothing to poll.
 *  - SYSTEM IDLE TIME, for the user who walks away WITHOUT locking. No OS
 *    event exists for "nobody has touched the keyboard in a while", so the
 *    monitor reads `getSystemIdleTime()` (a cheap in-process syscall). It only
 *    reads while at least one presence subscription exists, slowly while the
 *    user is present and quickly while they are idle-away, so a return by
 *    keystroke is noticed within a couple of seconds.
 *
 * Two rules keep the transitions honest:
 *  - While the screen is locked, the system is suspended, or the session is
 *    switched out, idle readings are IGNORED. Typing a password at the lock
 *    screen resets HID idle time on macOS, and that is not the user being
 *    back - the unlock is.
 *  - An absence starts at the user's LAST INPUT, not at the moment it was
 *    noticed: `awaySince = now - idle`. A lock five minutes after the last
 *    keystroke is an absence that began five minutes ago.
 *
 * This module stays free of Electron imports so it can be unit tested; the
 * `powerMonitor` adapter is wired in `src/main/index.ts`
 * ({@link createPowerMonitorPresenceProvider} +
 * {@link installCuePresenceProvider}). Without an installed provider (unit
 * tests, a process without Electron) presence subscriptions simply never fire.
 */

/** OS-level presence signals, normalized across platforms. */
export type PresenceSignal =
	| 'lock-screen'
	| 'unlock-screen'
	| 'suspend'
	| 'resume'
	| 'session-inactive'
	| 'session-active';

/** Why the user was judged to have left. */
export type PresenceAwayReason = 'lock' | 'idle' | 'suspend' | 'session-inactive';

/** Why the user was judged to have come back. */
export type PresenceReturnReason = 'unlock' | 'input' | 'session-active';

export type PresenceTransition =
	| {
			kind: 'away';
			/** When the transition was observed (ms since epoch). */
			at: number;
			/** When the absence began - the user's last input (ms since epoch). */
			awaySince: number;
			reason: PresenceAwayReason;
	  }
	| {
			kind: 'return';
			at: number;
			awaySince: number;
			/** `at - awaySince`. */
			awayMs: number;
			reason: PresenceReturnReason;
	  };

export type PresenceListener = (transition: PresenceTransition) => void;

/** What the monitor needs from the OS. Implemented over Electron's `powerMonitor`. */
export interface PresenceSignalProvider {
	/** Seconds since the last keyboard / mouse input. */
	getSystemIdleSeconds(): number;
	/** Subscribe to OS presence signals. Returns an unsubscribe function. */
	subscribe(listener: (signal: PresenceSignal) => void): () => void;
}

/** Idle time after which a user who did not lock is judged to have left. */
export const PRESENCE_IDLE_AWAY_MS = 60_000;
/** Idle-time read cadence while the user is present (only to notice them leaving). */
export const PRESENCE_POLL_PRESENT_MS = 15_000;
/** Idle-time read cadence while the user is idle-away (to notice them coming back). */
export const PRESENCE_POLL_AWAY_MS = 2_000;

export interface PresenceSnapshot {
	away: boolean;
	awaySince: number | null;
	/** True while the screen is locked, the system is suspended, or the session is switched out. */
	hardAway: boolean;
}

export class CuePresenceMonitor {
	private readonly listeners = new Set<PresenceListener>();
	private unsubscribeProvider: (() => void) | null = null;
	private pollTimer: ReturnType<typeof setTimeout> | null = null;

	private locked = false;
	private suspended = false;
	private sessionInactive = false;
	private awaySince: number | null = null;
	/** Idle reading at the previous poll; a lower reading means there was input. */
	private lastIdleMs = 0;

	constructor(private readonly provider: PresenceSignalProvider) {}

	/**
	 * Listen for transitions. The monitor only touches the OS (signal listeners
	 * and idle polling) while it has at least one listener.
	 */
	subscribe(listener: PresenceListener): () => void {
		this.listeners.add(listener);
		if (this.listeners.size === 1) this.activate();
		return () => {
			if (!this.listeners.delete(listener)) return;
			if (this.listeners.size === 0) this.deactivate();
		};
	}

	getSnapshot(): PresenceSnapshot {
		return {
			away: this.awaySince !== null,
			awaySince: this.awaySince,
			hardAway: this.isHardAway(),
		};
	}

	/** Exposed for tests and for the provider adapter; normally driven by the provider. */
	handleSignal(signal: PresenceSignal): void {
		const now = Date.now();
		switch (signal) {
			case 'lock-screen':
				this.locked = true;
				this.goAway(now, 'lock');
				break;
			case 'session-inactive':
				this.sessionInactive = true;
				this.goAway(now, 'session-inactive');
				break;
			case 'suspend':
				this.suspended = true;
				this.goAway(now, 'suspend');
				break;
			case 'unlock-screen':
				this.locked = false;
				this.comeBackIfFree(now, 'unlock');
				break;
			case 'session-active':
				this.sessionInactive = false;
				this.comeBackIfFree(now, 'session-active');
				break;
			case 'resume':
				// Waking is not the user being back: a scheduled wake touches no
				// keyboard, and a locked screen still has to be unlocked. Read idle
				// time now - a lid opened by a person resets it.
				this.suspended = false;
				this.poll();
				break;
		}
	}

	private isHardAway(): boolean {
		return this.locked || this.suspended || this.sessionInactive;
	}

	private activate(): void {
		this.locked = false;
		this.suspended = false;
		this.sessionInactive = false;
		this.awaySince = null;
		this.lastIdleMs = this.readIdleMs();
		this.unsubscribeProvider = this.provider.subscribe((signal) => this.handleSignal(signal));
		this.schedulePoll();
	}

	private deactivate(): void {
		this.unsubscribeProvider?.();
		this.unsubscribeProvider = null;
		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
	}

	private readIdleMs(): number {
		const seconds = this.provider.getSystemIdleSeconds();
		return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
	}

	private schedulePoll(): void {
		if (this.pollTimer) clearTimeout(this.pollTimer);
		const delay =
			this.awaySince !== null && !this.isHardAway()
				? PRESENCE_POLL_AWAY_MS
				: PRESENCE_POLL_PRESENT_MS;
		this.pollTimer = setTimeout(() => {
			this.pollTimer = null;
			this.poll();
		}, delay);
	}

	private poll(): void {
		if (this.listeners.size === 0) return;
		if (!this.suspended) {
			const now = Date.now();
			const idleMs = this.readIdleMs();
			if (this.awaySince === null) {
				if (idleMs >= PRESENCE_IDLE_AWAY_MS) this.goAway(now, 'idle', idleMs);
			} else if (!this.isHardAway() && idleMs < this.lastIdleMs) {
				this.comeBack(now, 'input');
			}
			this.lastIdleMs = idleMs;
		}
		this.schedulePoll();
	}

	private goAway(now: number, reason: PresenceAwayReason, idleMs = this.readIdleMs()): void {
		// Already away (e.g. idle, then the screen locked): the absence began at
		// the earlier point, and listeners have already heard about it.
		if (this.awaySince !== null) return;
		this.awaySince = now - idleMs;
		// The baseline a later idle drop is measured against - including the
		// first read after a resume, which compares to the reading at suspend.
		this.lastIdleMs = idleMs;
		this.emit({ kind: 'away', at: now, awaySince: this.awaySince, reason });
		this.schedulePoll();
	}

	private comeBackIfFree(now: number, reason: PresenceReturnReason): void {
		if (this.isHardAway()) return;
		this.comeBack(now, reason);
	}

	private comeBack(now: number, reason: PresenceReturnReason): void {
		const awaySince = this.awaySince;
		if (awaySince === null) return;
		this.awaySince = null;
		this.lastIdleMs = this.readIdleMs();
		this.emit({ kind: 'return', at: now, awaySince, awayMs: Math.max(0, now - awaySince), reason });
		this.schedulePoll();
	}

	private emit(transition: PresenceTransition): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(transition);
			} catch (err) {
				console.error('[CUE] presence listener threw:', err);
			}
		}
	}
}

// ─── Process-wide instance ───────────────────────────────────────────────────

let monitor: CuePresenceMonitor | null = null;

/** Install the OS signal provider. Called once from `src/main/index.ts` after app ready. */
export function installCuePresenceProvider(provider: PresenceSignalProvider): CuePresenceMonitor {
	monitor = new CuePresenceMonitor(provider);
	return monitor;
}

/** The process-wide monitor, or `null` when no provider was installed. */
export function getCuePresenceMonitor(): CuePresenceMonitor | null {
	return monitor;
}

/** Test seam: drop the installed monitor. */
export function resetCuePresenceMonitor(): void {
	monitor = null;
}

// ─── Electron powerMonitor adapter ───────────────────────────────────────────

/** The slice of Electron's `powerMonitor` the adapter uses (structural, so no Electron import). */
export interface PowerMonitorLike {
	getSystemIdleTime(): number;
	on(event: string, listener: () => void): unknown;
	removeListener(event: string, listener: () => void): unknown;
}

/**
 * `powerMonitor` event -> presence signal. `lock-screen` / `unlock-screen`
 * fire on macOS and Windows; `user-did-*` (fast user switching) on macOS.
 * Linux reports none of these, so presence there rests on idle time alone.
 */
const POWER_MONITOR_SIGNALS: ReadonlyArray<readonly [string, PresenceSignal]> = [
	['lock-screen', 'lock-screen'],
	['unlock-screen', 'unlock-screen'],
	['suspend', 'suspend'],
	['resume', 'resume'],
	['user-did-resign-active', 'session-inactive'],
	['user-did-become-active', 'session-active'],
];

export function createPowerMonitorPresenceProvider(
	powerMonitor: PowerMonitorLike
): PresenceSignalProvider {
	return {
		getSystemIdleSeconds: () => powerMonitor.getSystemIdleTime(),
		subscribe(listener) {
			const handlers = POWER_MONITOR_SIGNALS.map(([event, signal]) => {
				const handler = () => listener(signal);
				powerMonitor.on(event, handler);
				return [event, handler] as const;
			});
			return () => {
				for (const [event, handler] of handlers) powerMonitor.removeListener(event, handler);
			};
		},
	};
}
