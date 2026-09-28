/**
 * Heap Guard - reporting a main-process OOM that cannot be caught.
 *
 * A V8 heap exhaustion in the main process is an `abort()`, not a throw. It
 * does not reach `process.on('uncaughtException')`, it does not unwind, and it
 * takes the whole app with it. That has two consequences worth stating plainly,
 * because both are counter-intuitive:
 *
 *  1. **Sentry cannot report the crash itself.** There is no exception to
 *     capture and no moment after it to capture one in.
 *  2. **Breadcrumbs are useless here.** They live in memory and are attached to
 *     a future event; if the process aborts, they die with it. The existing
 *     memory monitor leaves breadcrumbs every 60 seconds, which is both too
 *     slow to observe a 2-second blowup and, for this failure mode, discarded
 *     anyway.
 *
 * So the only thing that works is reporting BEFORE the abort: sample the heap
 * during risky work, and when it crosses a fraction of the real ceiling, send
 * an event immediately. That event is a warning about an imminent crash rather
 * than a record of one, which is the best available and considerably better
 * than the silence it replaces.
 *
 * The guard is armed around specific operations rather than run globally. A
 * fast global poll would burn CPU forever for a rare event, and would not know
 * WHAT was running - and the operation name is the entire diagnostic value.
 */

import v8 from 'v8';

import { captureMessage } from './sentry';
import { logger } from './logger';

/** How often the heap is sampled while an operation is guarded. */
const SAMPLE_INTERVAL_MS = 250;

/**
 * Fraction of the heap ceiling that triggers a report.
 *
 * 0.75 is chosen from the observed failure: that file peaked at 3.36 GB against
 * a 4.19 GB limit (80%) while surviving, and died above it. Reporting at 75%
 * catches the run that is about to die while still firing on the run that
 * merely came close - the near miss is worth knowing about, because it is the
 * same bug on a machine with more headroom.
 */
const DANGER_FRACTION = 0.75;

/** Details attached to a heap-pressure report. */
export interface HeapPressureContext {
	/** What was running, e.g. `parquet:query`. The point of the whole report. */
	operation: string;
	/** Anything that identifies the input, e.g. row/column counts. No paths. */
	detail?: Record<string, unknown>;
}

export interface HeapSample {
	heapUsedMB: number;
	heapLimitMB: number;
	rssMB: number;
	fraction: number;
}

/** Current heap usage against the real V8 ceiling for this process. */
export function sampleHeap(): HeapSample {
	const stats = v8.getHeapStatistics();
	const memory = process.memoryUsage();
	const heapLimit = stats.heap_size_limit || 0;
	return {
		heapUsedMB: Math.round(memory.heapUsed / 1048576),
		heapLimitMB: Math.round(heapLimit / 1048576),
		rssMB: Math.round(memory.rss / 1048576),
		fraction: heapLimit > 0 ? memory.heapUsed / heapLimit : 0,
	};
}

/**
 * Run `work` with the heap under watch, reporting once if it gets dangerous.
 *
 * Reports at most one event per call. A run that crosses the threshold is
 * usually seconds from either finishing or dying, and a report per sample would
 * be a flood in exactly the moment the process can least afford the work.
 *
 * The guard never rejects and never alters the result: it observes. Turning a
 * near-miss into a thrown error would trade a rare crash for a common refusal,
 * and the operation that triggers it is frequently one that would have
 * completed.
 */
export async function withHeapGuard<T>(
	context: HeapPressureContext,
	work: () => Promise<T>
): Promise<T> {
	const baseline = sampleHeap();
	// A process with no reported ceiling gives nothing to compare against, so
	// watching it would produce noise rather than signal.
	if (baseline.heapLimitMB <= 0) return work();

	let reported = false;
	let peakMB = baseline.heapUsedMB;

	const timer = setInterval(() => {
		const sample = sampleHeap();
		peakMB = Math.max(peakMB, sample.heapUsedMB);
		if (reported || sample.fraction < DANGER_FRACTION) return;
		reported = true;

		logger.warn(
			`Heap pressure during ${context.operation}: ${sample.heapUsedMB}MB of ${sample.heapLimitMB}MB limit`,
			'HeapGuard',
			{ ...sample, ...context.detail }
		);

		// Sent eagerly, not queued as a breadcrumb: if this run is about to
		// abort, an event dispatched now is the only thing that gets out.
		void captureMessage(
			`Heap pressure during ${context.operation} (${Math.round(sample.fraction * 100)}% of limit)`,
			'warning',
			{
				operation: context.operation,
				heapUsedMB: sample.heapUsedMB,
				heapLimitMB: sample.heapLimitMB,
				rssMB: sample.rssMB,
				percentOfLimit: Math.round(sample.fraction * 100),
				...context.detail,
			}
		);
	}, SAMPLE_INTERVAL_MS);
	timer.unref?.();

	try {
		return await work();
	} finally {
		clearInterval(timer);
		if (reported) {
			logger.info(
				`${context.operation} finished after heap pressure (peak ${peakMB}MB)`,
				'HeapGuard'
			);
		}
	}
}

/** Test seam: the fraction at which a report fires. */
export const HEAP_DANGER_FRACTION = DANGER_FRACTION;
