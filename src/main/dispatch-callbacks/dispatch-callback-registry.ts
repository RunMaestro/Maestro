/**
 * In-memory registry of armed dispatch callbacks.
 *
 * Pure and dependency-injected (clock, id generator, timers, Auto Run probe) in
 * the style of cue-completion-service.ts, so the whole lifecycle is testable
 * without Electron, a process manager, or a renderer.
 *
 * Correlation model: an entry is keyed by the composite process session id the
 * exit listener sees for the dispatched tab (`{agentId}-ai-{tabId}`) and only
 * fires for exits that happen AFTER the dispatched process actually started.
 * That start gate is what makes `--queue` safe: a queued prompt can sit behind
 * another turn for minutes, and that predecessor's exit must not fire us.
 */

import type {
	DispatchCallbackEntry,
	DispatchCallbackFire,
	DispatchCallbackRegistration,
	DispatchCallbackStatus,
} from './types';

/** Cap on simultaneously armed callbacks - a cheap runaway guard. */
export const MAX_ARMED_CALLBACKS = 200;

/** Default give-up window (1 hour), matching the CLI default. */
export const DEFAULT_CALLBACK_TIMEOUT_MS = 60 * 60 * 1000;

/** Hard cap on --callback-timeout (24 hours). */
export const MAX_CALLBACK_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * How long to wait after a dispatched process exits before firing, when no Auto
 * Run is active yet. Covers the race where the dispatched turn's last act is to
 * start an Auto Run: the batch's `isRunning: true` broadcast lands a beat after
 * the turn's process exits, and firing immediately would wake the caller while
 * the real work is only starting.
 */
export const AUTORUN_GRACE_MS = 3000;

/**
 * How far back a `--new-tab` registration may look for an already-observed
 * spawn. The renderer can spawn the agent before the new-tab ack round-trips
 * back to the web server, so without this the entry would sit `pending` forever
 * and only ever fire on timeout.
 */
export const SPAWN_LOOKBACK_MS = 60_000;

export interface DispatchCallbackRegistryDeps {
	now?: () => number;
	generateId?: () => string;
	/**
	 * Whether an Auto Run batch is currently running for this agent. Fed by the
	 * main-process AutoRunStateTracker (Phase 2). When absent, callbacks behave
	 * as single-run only.
	 */
	isAutoRunActive?: (agentId: string) => boolean;
	/** Invoked exactly once per entry when it fires. */
	onFire: (fire: DispatchCallbackFire) => void;
	graceMs?: number;
	setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
	logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

/** Build the composite process session id for an AI tab. */
export function buildProcessSessionId(agentId: string, tabId: string): string {
	return `${agentId}-ai-${tabId}`;
}

let idCounter = 0;

function defaultGenerateId(): string {
	idCounter += 1;
	return `cb_${Date.now().toString(36)}${idCounter.toString(36).padStart(3, '0')}`;
}

export class DispatchCallbackRegistry {
	private entries = new Map<string, DispatchCallbackEntry>();
	private graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** processSessionId -> last observed spawn time (see SPAWN_LOOKBACK_MS). */
	private recentSpawns = new Map<string, number>();
	private readonly now: () => number;
	private readonly generateId: () => string;
	private readonly graceMs: number;
	private readonly setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	private readonly clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void;
	private readonly deps: DispatchCallbackRegistryDeps;

	constructor(deps: DispatchCallbackRegistryDeps) {
		this.deps = deps;
		this.now = deps.now ?? (() => Date.now());
		this.generateId = deps.generateId ?? defaultGenerateId;
		this.graceMs = deps.graceMs ?? AUTORUN_GRACE_MS;
		this.setTimeoutFn = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearTimeoutFn = deps.clearTimeoutFn ?? ((h) => clearTimeout(h));
	}

	/**
	 * Arm a callback for a dispatch that has just been delivered.
	 * Throws when the armed-entry cap is hit, so the caller reports a real error
	 * rather than silently dropping the promise to wake up.
	 */
	register(registration: DispatchCallbackRegistration): DispatchCallbackEntry {
		if (this.countActive() >= MAX_ARMED_CALLBACKS) {
			throw new Error(
				`Too many armed dispatch callbacks (${MAX_ARMED_CALLBACKS}). Cancel some before arming more.`
			);
		}
		const now = this.now();
		const timeoutMs = Math.min(Math.max(registration.timeoutMs, 1000), MAX_CALLBACK_TIMEOUT_MS);
		const entry: DispatchCallbackEntry = {
			...registration,
			timeoutMs,
			callbackId: this.generateId(),
			processSessionId: buildProcessSessionId(registration.targetAgentId, registration.targetTabId),
			createdAt: now,
			expiresAt: now + timeoutMs,
			state: 'pending',
		};

		// --new-tab only: the renderer may already have spawned the agent before
		// this registration landed. The tab id is brand new, so a recent spawn
		// against it can only be our dispatch.
		if (registration.armFromRecentSpawn) {
			const spawnedAt = this.recentSpawns.get(entry.processSessionId);
			if (spawnedAt !== undefined && now - spawnedAt <= SPAWN_LOOKBACK_MS) {
				entry.state = 'armed';
				entry.startedAt = spawnedAt;
			}
		}

		this.entries.set(entry.callbackId, entry);
		this.deps.logger?.info(
			`[DispatchCallback] armed ${entry.callbackId} target=${entry.processSessionId} caller=${entry.callerAgentId}`
		);
		return entry;
	}

	/**
	 * A process started. Flips the matching pending entry to `armed` so the next
	 * exit of that tab is recognised as ours.
	 */
	noteSpawn(processSessionId: string): void {
		const now = this.now();
		this.recentSpawns.set(processSessionId, now);
		this.prunePendingSpawns(now);
		for (const entry of this.entries.values()) {
			if (entry.processSessionId !== processSessionId) continue;
			if (entry.state !== 'pending') continue;
			entry.state = 'armed';
			entry.startedAt = now;
		}
	}

	/** Keep the spawn-lookback map from growing without bound. */
	private prunePendingSpawns(now: number): void {
		for (const [key, at] of this.recentSpawns) {
			if (now - at > SPAWN_LOOKBACK_MS) this.recentSpawns.delete(key);
		}
	}

	/**
	 * A process exited. Fires (after the Auto Run grace window) or parks the
	 * entry until the Auto Run batch finishes.
	 */
	noteExit(processSessionId: string, exitCode: number | null): void {
		for (const entry of [...this.entries.values()]) {
			if (entry.processSessionId !== processSessionId) continue;
			if (entry.state !== 'armed') continue;
			entry.exitCode = exitCode;
			entry.durationMs = this.now() - (entry.startedAt ?? entry.createdAt);

			if (this.deps.isAutoRunActive?.(entry.targetAgentId)) {
				entry.state = 'awaiting-autorun';
				this.deps.logger?.info(
					`[DispatchCallback] ${entry.callbackId} parked - Auto Run still running on ${entry.targetAgentId}`
				);
				continue;
			}

			entry.state = 'grace';
			const handle = this.setTimeoutFn(() => {
				this.graceTimers.delete(entry.callbackId);
				const current = this.entries.get(entry.callbackId);
				if (!current || current.state !== 'grace') return;
				// An Auto Run started during the grace window: park instead of firing.
				if (this.deps.isAutoRunActive?.(current.targetAgentId)) {
					current.state = 'awaiting-autorun';
					return;
				}
				this.fire(current, current.exitCode === 0 ? 'completed' : 'failed');
			}, this.graceMs);
			this.graceTimers.set(entry.callbackId, handle);
		}
	}

	/**
	 * The agent's Auto Run batch reached its running -> not-running edge. Fires
	 * every entry parked on that agent, exactly once each.
	 */
	noteAutoRunFinal(
		agentId: string,
		progress?: { tasksCompleted?: number; tasksTotal?: number }
	): void {
		for (const entry of [...this.entries.values()]) {
			if (entry.targetAgentId !== agentId) continue;
			if (entry.state !== 'awaiting-autorun') continue;
			this.fire(entry, entry.exitCode === 0 ? 'completed' : 'failed', progress);
		}
	}

	/** Fire `timeout` callbacks for everything past its deadline. */
	sweepExpired(): void {
		const now = this.now();
		for (const entry of [...this.entries.values()]) {
			if (this.isTerminal(entry)) continue;
			if (entry.expiresAt > now) continue;
			this.deps.logger?.warn(
				`[DispatchCallback] ${entry.callbackId} timed out after ${entry.timeoutMs}ms`
			);
			this.fire(entry, 'timeout');
		}
	}

	/** Cancel a single callback by id. Returns false when unknown/terminal. */
	cancel(callbackId: string): boolean {
		const entry = this.entries.get(callbackId);
		if (!entry || this.isTerminal(entry)) return false;
		this.clearGraceTimer(callbackId);
		entry.state = 'cancelled';
		this.entries.delete(callbackId);
		return true;
	}

	/**
	 * Cancel everything targeting a tab that just went away. Without this a
	 * closed target tab leaves an entry armed until its timeout.
	 */
	cancelForTab(agentId: string, tabId: string): number {
		const key = buildProcessSessionId(agentId, tabId);
		let cancelled = 0;
		for (const entry of [...this.entries.values()]) {
			if (entry.processSessionId !== key) continue;
			if (this.cancel(entry.callbackId)) cancelled += 1;
		}
		return cancelled;
	}

	/** True when a non-terminal callback already targets this exact tab. */
	hasArmedFor(agentId: string, tabId: string): boolean {
		const key = buildProcessSessionId(agentId, tabId);
		for (const entry of this.entries.values()) {
			if (entry.processSessionId === key && !this.isTerminal(entry)) return true;
		}
		return false;
	}

	/** Snapshot of live entries (for `dispatch callbacks list`). */
	list(): DispatchCallbackEntry[] {
		return [...this.entries.values()].filter((e) => !this.isTerminal(e));
	}

	get(callbackId: string): DispatchCallbackEntry | undefined {
		return this.entries.get(callbackId);
	}

	/** Drop every timer and entry (app shutdown / tests). */
	dispose(): void {
		for (const handle of this.graceTimers.values()) this.clearTimeoutFn(handle);
		this.graceTimers.clear();
		this.entries.clear();
		this.recentSpawns.clear();
	}

	private countActive(): number {
		let count = 0;
		for (const entry of this.entries.values()) if (!this.isTerminal(entry)) count += 1;
		return count;
	}

	private isTerminal(entry: DispatchCallbackEntry): boolean {
		return entry.state === 'fired' || entry.state === 'cancelled';
	}

	/**
	 * Single-transition guard. Everything funnels through here, so a second
	 * completion (or a timeout racing a real exit) is a no-op.
	 */
	private fire(
		entry: DispatchCallbackEntry,
		status: DispatchCallbackStatus,
		progress?: { tasksCompleted?: number; tasksTotal?: number }
	): void {
		if (this.isTerminal(entry)) return;
		this.clearGraceTimer(entry.callbackId);
		entry.state = 'fired';
		this.entries.delete(entry.callbackId);
		const fire: DispatchCallbackFire = {
			entry,
			status,
			exitCode: entry.exitCode ?? null,
			durationMs: entry.durationMs ?? this.now() - entry.createdAt,
			...(progress?.tasksCompleted !== undefined
				? { tasksCompleted: progress.tasksCompleted }
				: {}),
			...(progress?.tasksTotal !== undefined ? { tasksTotal: progress.tasksTotal } : {}),
		};
		this.deps.onFire(fire);
	}

	private clearGraceTimer(callbackId: string): void {
		const handle = this.graceTimers.get(callbackId);
		if (handle === undefined) return;
		this.clearTimeoutFn(handle);
		this.graceTimers.delete(callbackId);
	}
}
