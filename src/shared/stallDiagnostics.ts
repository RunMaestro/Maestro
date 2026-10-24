export type DiagnosticOperationKind = 'ipc' | 'spawn' | 'renderer-script';

interface OperationTiming {
	kind: DiagnosticOperationKind;
	name: string;
	count: number;
	totalMs: number;
	maxMs: number;
}

interface ActiveOperation {
	name: string;
	startedAt: number;
	reported: boolean;
}

export interface StallReport {
	process: 'main' | 'renderer';
	attribution: 'correlated-timings';
	windowMs: number;
	stallSamples: number;
	maxDelayMs: number;
	/** Timings within the reporting window; correlation, not a CPU stack trace. */
	synchronousWork: OperationTiming[];
	slowOperations: OperationTiming[];
	activeOperations: Array<{ name: string; elapsedMs: number }>;
	untrackedOperations: number;
}

const STALL_THRESHOLD_MS = 250;
const SLOW_OPERATION_MS = 2000;
const MAX_ACTIVE_OPERATIONS = 128;
const MAX_TIMING_LABELS = 32;
const MAX_REPORT_ITEMS = 5;

/** Bounded metadata only: callers supply code-owned labels, never arguments or paths. */
export class StallDiagnostics {
	enabled = false;
	private nextId = 1;
	private startedAt = 0;
	private stallSamples = 0;
	private maxDelayMs = 0;
	private untrackedOperations = 0;
	private readonly active = new Map<number, ActiveOperation>();
	private readonly synchronous = new Map<string, OperationTiming>();
	private readonly slow = new Map<string, OperationTiming>();

	constructor(
		private readonly processKind: StallReport['process'],
		private readonly now: () => number = () => performance.now()
	) {}

	start(): void {
		this.reset();
		this.enabled = true;
	}

	stop(): void {
		this.enabled = false;
		this.reset();
	}

	/** Drop pre-suspend work so sleep is not reported as an application stall. */
	reset(): void {
		this.startedAt = this.now();
		this.active.clear();
		this.clearWindow();
	}

	beginOperation(name: string): number | undefined {
		if (!this.enabled) return;
		if (this.active.size >= MAX_ACTIVE_OPERATIONS) {
			this.untrackedOperations++;
			return;
		}
		const id = this.nextId++;
		this.active.set(id, { name: name.slice(0, 120), startedAt: this.now(), reported: false });
		return id;
	}

	endOperation(id: number | undefined): void {
		if (id === undefined) return;
		const operation = this.active.get(id);
		if (!operation) return;
		this.active.delete(id);
		const duration = this.now() - operation.startedAt;
		if (!operation.reported && duration >= SLOW_OPERATION_MS) {
			this.addTiming(this.slow, 'ipc', operation.name, duration);
		}
	}

	measureSynchronous<T>(kind: DiagnosticOperationKind, name: string, run: () => T): T {
		if (!this.enabled) return run();
		const start = this.now();
		try {
			return run();
		} finally {
			this.recordSynchronous(kind, name, this.now() - start);
		}
	}

	recordSynchronous(kind: DiagnosticOperationKind, name: string, durationMs: number): void {
		if (!this.enabled || !Number.isFinite(durationMs) || durationMs < 1) return;
		this.addTiming(this.synchronous, kind, name, durationMs);
		if (durationMs >= STALL_THRESHOLD_MS) this.recordStall(durationMs);
	}

	recordStall(delayMs: number): void {
		if (!this.enabled || !Number.isFinite(delayMs) || delayMs < STALL_THRESHOLD_MS) return;
		this.stallSamples++;
		this.maxDelayMs = Math.max(this.maxDelayMs, delayMs);
	}

	/** Called at most once per reporting window, never from the instrumented operation. */
	drain(): StallReport | undefined {
		if (!this.enabled) return;
		const now = this.now();
		for (const operation of this.active.values()) {
			const elapsed = now - operation.startedAt;
			if (!operation.reported && elapsed >= SLOW_OPERATION_MS) {
				operation.reported = true;
				this.addTiming(this.slow, 'ipc', operation.name, elapsed);
			}
		}
		let report: StallReport | undefined;
		if (this.stallSamples > 0 || this.slow.size > 0) {
			report = {
				process: this.processKind,
				attribution: 'correlated-timings',
				windowMs: Math.round(now - this.startedAt),
				stallSamples: this.stallSamples,
				maxDelayMs: Math.round(this.maxDelayMs),
				synchronousWork: this.topTimings(this.synchronous),
				slowOperations: this.topTimings(this.slow),
				activeOperations: [...this.active.values()]
					.sort((a, b) => a.startedAt - b.startedAt)
					.slice(0, MAX_REPORT_ITEMS)
					.map((operation) => ({
						name: operation.name,
						elapsedMs: Math.round(now - operation.startedAt),
					})),
				untrackedOperations: this.untrackedOperations,
			};
		}
		this.startedAt = now;
		this.clearWindow();
		return report;
	}

	private clearWindow(): void {
		this.stallSamples = 0;
		this.maxDelayMs = 0;
		this.untrackedOperations = 0;
		this.synchronous.clear();
		this.slow.clear();
	}

	private addTiming(
		map: Map<string, OperationTiming>,
		kind: DiagnosticOperationKind,
		name: string,
		duration: number
	): void {
		name = name.slice(0, 120);
		let key = `${kind}:${name}`;
		if (!map.has(key) && map.size >= MAX_TIMING_LABELS) {
			key = 'other';
			name = '(other operations)';
		}
		const existing = map.get(key);
		if (existing) {
			existing.count++;
			existing.totalMs += duration;
			existing.maxMs = Math.max(existing.maxMs, duration);
		} else {
			map.set(key, { kind, name, count: 1, totalMs: duration, maxMs: duration });
		}
	}

	private topTimings(map: Map<string, OperationTiming>): OperationTiming[] {
		return [...map.values()]
			.sort((a, b) => b.totalMs - a.totalMs)
			.slice(0, MAX_REPORT_ITEMS)
			.map((timing) => ({
				...timing,
				totalMs: Math.round(timing.totalMs),
				maxMs: Math.round(timing.maxMs),
			}));
	}
}

/** Disabled in standalone library/CLI consumers; enabled by desktop bootstrap only. */
export const mainStallDiagnostics = new StallDiagnostics('main');

let mainReporter: ((report: StallReport) => void) | undefined;
const pendingReports: StallReport[] = [];

/** Connect to the existing logger without importing Electron into library consumers. */
export function setMainStallReporter(reporter: (report: StallReport) => void): void {
	mainReporter = reporter;
	for (const report of pendingReports.splice(0)) emitMainStallReport(report);
}

export function emitMainStallReport(report: StallReport): void {
	if (!mainReporter) {
		if (pendingReports.length === 3) pendingReports.shift();
		pendingReports.push(report);
		return;
	}
	try {
		mainReporter(report);
	} catch {
		// Diagnostic reporting must never change an application's result or error.
		console.warn('[StallMonitor] Diagnostic log sink failed');
	}
}
