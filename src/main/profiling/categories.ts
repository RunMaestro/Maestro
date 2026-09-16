/**
 * Trace category presets for performance profiling.
 *
 * We deliberately avoid the `*` firehose. The set below mirrors what Chrome
 * DevTools records for its Performance panel: enough to pinpoint UI lag (tasks,
 * layout/paint, JS execution, frames, input latency) without the overhead and
 * file-size blow-up of capturing every category. Each entry is a Chromium trace
 * category; `disabled-by-default-*` categories are dormant unless explicitly
 * requested here, so naming them is what turns them on.
 */

import type { TraceConfig } from 'electron';

export const DEFAULT_TRACE_CATEGORIES: string[] = [
	// The unit of "a task" on the message loop. Top-level entries here are what
	// we rank to find long tasks / jank.
	'toplevel',
	'sequence_manager',
	'scheduler',
	'renderer.scheduler',
	// Blink rendering engine + our own performance.mark()/measure() marks.
	'blink',
	'blink.user_timing',
	// Compositor + GPU: paint, layerize, frame production.
	'cc',
	'gpu',
	// V8 execution (JS).
	'v8',
	'v8.execute',
	// The DevTools "Timeline" events: Layout, RecalcStyles, Paint, FunctionCall,
	// EvaluateScript, TimerFire, etc. This is the backbone of the analysis.
	'disabled-by-default-devtools.timeline',
	'disabled-by-default-devtools.timeline.frame',
	'disabled-by-default-devtools.timeline.stack',
	// Sampling CPU profiler. This is the ONLY usable JS attribution in an
	// Electron trace: the devtools timeline FunctionCall / EvaluateScript events
	// the analysis script originally looked for are not emitted here, so its
	// "hottest JS" table was empty until it learned to read these samples. Drop
	// this category and every JS question becomes unanswerable.
	'disabled-by-default-v8.cpu_profiler',
	// Input -> response latency.
	'latencyInfo',
	// Resource loading.
	'loading',
];

/**
 * Build the TraceConfig passed to contentTracing.startRecording().
 *
 * `record-until-full` suits the intended workflow: start, reproduce the lag for
 * a few seconds, stop.
 *
 * The buffer is NOT a whole-capture budget. It is applied per process, and a
 * busy window overruns it fast: a 14-minute field capture on an 18-core Mac
 * produced a 657MB bundle whose renderer covered only its final 93 seconds,
 * with the earlier 87% discarded. Two consequences worth knowing before reading
 * one of these:
 *
 * - The size cap below does not bound the bundle. Six processes each fill their
 *   own buffer.
 * - What survives is the tail, not the head, so a trace says nothing about what
 *   happened at the start of a long recording.
 *
 * `analyze-perf-trace.mjs` compares the covered window against
 * `profilingDurationMs` and warns when it sees this. Keep captures short.
 */
export function buildTraceConfig(categories: string[] = DEFAULT_TRACE_CATEGORIES): TraceConfig {
	return {
		recording_mode: 'record-until-full',
		included_categories: categories,
		// ~150MB per process, not per capture. See the note above.
		trace_buffer_size_in_kb: 150_000,
	};
}
