/**
 * The one piece of state a headless Cue engine's health surfaces read.
 *
 * `maestro-cli cue engine start` owns exactly one of these. The loopback
 * status server (`cue-status-server.ts`) READS it to answer `/healthz`,
 * `/readyz` and `/status`; the command, the engine's lock heartbeat (through
 * `CueEngineDeps.onLockLost`), and later the SIGTERM drain and the systemd
 * notifier WRITE it. Keeping it one object is the point: a drain that sets a
 * module global the server never reads would leave `/readyz` reporting ready
 * while the engine refuses work.
 *
 * Liveness and readiness are separate questions with separate rules, kept as
 * pure functions here so the server and the tests share them:
 *
 * - Liveness ("restart me if this fails") fails only when restarting would
 *   help: the lock was taken over by another engine, or the event loop is
 *   saturated. Readiness gaps never fail it, so a misconfigured engine
 *   reports its gaps instead of being restart-looped.
 * - Readiness ("send work / consider started") fails while starting,
 *   draining, stopped, after a lost lock, and whenever the last readiness
 *   report has gaps, with or without `--require-ready`.
 *
 * No Electron imports: this runs under plain Node in the standalone engine.
 */

import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';
import type { CueReadinessReport } from './cue-readiness';

export type CueEnginePhase = 'starting' | 'running' | 'draining' | 'stopped' | 'lock-lost';

/** A readiness report older than this is re-checked when someone asks. */
export const CUE_READINESS_REFRESH_MS = 60_000;
/** Length of one event-loop delay window; the PREVIOUS full window is what health reads. */
export const CUE_EVENT_LOOP_WINDOW_MS = 30_000;
/**
 * A window whose MEDIAN delay reaches this means the loop spent most of the
 * window blocked. One long synchronous step (a git call, a lock back-off)
 * moves p99 and max, not the median, so it does not trip liveness.
 */
export const CUE_EVENT_LOOP_UNHEALTHY_P50_MS = 1_000;
/** Sampling resolution of the delay histogram (one libuv timer at this period). */
const EVENT_LOOP_RESOLUTION_MS = 50;

export interface CueEventLoopDelay {
	p50: number;
	p99: number;
	max: number;
	mean: number;
	windowMs: number;
}

/** Where delay figures come from. The default wraps `monitorEventLoopDelay`; tests inject a stub. */
export interface CueEventLoopDelaySource {
	/** The last COMPLETE window, or `null` before the first one has finished. */
	read(): CueEventLoopDelay | null;
	dispose(): void;
}

export interface CueEngineHealthOptions {
	version: string;
	dataDir: string;
	pid?: number;
	now?: () => number;
	/**
	 * Recompute the readiness report. Called at most once at a time, and only
	 * when the cached report is older than {@link CUE_READINESS_REFRESH_MS} and
	 * someone asks, so an idle engine never probes.
	 */
	refreshReadiness?: () => Promise<CueReadinessReport>;
	/** Measure the event loop. Omit for no measurement (the loop then counts as healthy). */
	eventLoop?: CueEventLoopDelaySource;
}

export interface CueEngineHealth {
	readonly version: string;
	readonly dataDir: string;
	readonly pid: number;
	/** Epoch ms this object was created, i.e. when the command started. */
	readonly startedAt: number;
	now(): number;
	phase(): CueEnginePhase;
	markRunning(): void;
	markDraining(): void;
	markStopped(): void;
	/** Terminal: a later markStopped/markRunning keeps `lock-lost`, so the reason survives shutdown. */
	markLockLost(): void;
	readiness(): CueReadinessReport | null;
	setReadiness(report: CueReadinessReport): void;
	/** Refresh the readiness report when it is stale; resolves once it is current (or the refresh failed). */
	ensureFreshReadiness(): Promise<void>;
	eventLoopDelay(): CueEventLoopDelay | null;
	dispose(): void;
}

function nsToMs(ns: number): number {
	return Number.isFinite(ns) ? Math.round((ns / 1e6) * 10) / 10 : 0;
}

/**
 * Event-loop delay over rolling windows. One histogram, reset every
 * {@link CUE_EVENT_LOOP_WINDOW_MS} after its figures are copied out, so the
 * reported numbers describe the last 30 seconds rather than the whole uptime.
 */
export function createEventLoopDelaySource(
	windowMs: number = CUE_EVENT_LOOP_WINDOW_MS
): CueEventLoopDelaySource {
	const histogram: IntervalHistogram = monitorEventLoopDelay({
		resolution: EVENT_LOOP_RESOLUTION_MS,
	});
	histogram.enable();
	let last: CueEventLoopDelay | null = null;
	const timer = setInterval(() => {
		// The histogram includes the sampling period itself in every reading, so
		// an idle loop reads ~resolution; subtract it to report real delay.
		const offset = EVENT_LOOP_RESOLUTION_MS;
		last = {
			p50: Math.max(0, nsToMs(histogram.percentile(50)) - offset),
			p99: Math.max(0, nsToMs(histogram.percentile(99)) - offset),
			max: Math.max(0, nsToMs(histogram.max) - offset),
			mean: Math.max(0, nsToMs(histogram.mean) - offset),
			windowMs,
		};
		histogram.reset();
	}, windowMs);
	timer.unref?.();
	return {
		read: () => last,
		dispose: () => {
			clearInterval(timer);
			histogram.disable();
		},
	};
}

export function createCueEngineHealth(options: CueEngineHealthOptions): CueEngineHealth {
	const now = options.now ?? Date.now;
	const startedAt = now();
	let phase: CueEnginePhase = 'starting';
	let report: CueReadinessReport | null = null;
	let reportAt = 0;
	let inFlight: Promise<void> | null = null;

	const setPhase = (next: CueEnginePhase) => {
		if (phase === 'lock-lost') return;
		phase = next;
	};

	return {
		version: options.version,
		dataDir: options.dataDir,
		pid: options.pid ?? process.pid,
		startedAt,
		now,
		phase: () => phase,
		markRunning: () => setPhase('running'),
		markDraining: () => setPhase('draining'),
		markStopped: () => setPhase('stopped'),
		markLockLost: () => {
			phase = 'lock-lost';
		},
		readiness: () => report,
		setReadiness(next) {
			report = next;
			reportAt = now();
		},
		ensureFreshReadiness() {
			const refresh = options.refreshReadiness;
			if (!refresh) return Promise.resolve();
			if (report && now() - reportAt < CUE_READINESS_REFRESH_MS) return Promise.resolve();
			if (!inFlight) {
				inFlight = refresh()
					.then((next) => {
						report = next;
						reportAt = now();
					})
					.catch(() => {
						// Keep the previous report; stamp the attempt so a failing probe
						// is not retried on every request.
						reportAt = now();
					})
					.finally(() => {
						inFlight = null;
					});
			}
			return inFlight;
		},
		eventLoopDelay: () => options.eventLoop?.read() ?? null,
		dispose: () => options.eventLoop?.dispose(),
	};
}

export interface CueHealthVerdict {
	ok: boolean;
	reasons: string[];
}

/** Liveness: fails only on a lost lock or a saturated event loop. Readiness gaps never fail it. */
export function evaluateLiveness(health: CueEngineHealth): CueHealthVerdict {
	const reasons: string[] = [];
	if (health.phase() === 'lock-lost') {
		reasons.push('lock-lost: another Cue engine took over the lock for this data directory');
	}
	const delay = health.eventLoopDelay();
	if (delay && delay.p50 >= CUE_EVENT_LOOP_UNHEALTHY_P50_MS) {
		reasons.push(
			`event-loop: median delay ${delay.p50}ms over the last ${delay.windowMs / 1000}s (limit ${CUE_EVENT_LOOP_UNHEALTHY_P50_MS}ms)`
		);
	}
	return { ok: reasons.length === 0, reasons };
}

/** Readiness: running, and the last readiness report has no gaps. */
export function evaluateReadiness(health: CueEngineHealth): CueHealthVerdict {
	const reasons: string[] = [];
	const phase = health.phase();
	if (phase !== 'running') reasons.push(`phase: ${phase}`);
	const report = health.readiness();
	if (!report) reasons.push('readiness: not checked yet');
	else if (!report.ready) reasons.push(`readiness: ${report.gaps.length} gap(s)`);
	return { ok: reasons.length === 0, reasons };
}
