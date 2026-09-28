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
	// Compositor: paint, layerize, frame production. This is the single largest
	// emitter in a capture (1.26M events, 37% of a 95-second trace) and it stays
	// because PaintArtifactCompositor::Update and the frame-commit stream are
	// what tell us whether the renderer is doing work nobody asked for.
	//
	// The `gpu` category used to sit beside it and was dropped: 247,490 events
	// (~7% of the same trace) from the GPU process, which produced zero findings
	// across two field captures. Buffer spent there is buffer not spent on the
	// renderer, which is where every answer has come from.
	'cc',
	// V8 execution (JS).
	'v8',
	'v8.execute',
	// The DevTools "Timeline" events: Layout, RecalcStyles, Paint, FunctionCall,
	// EvaluateScript, TimerFire, etc. This is the backbone of the analysis.
	'disabled-by-default-devtools.timeline',
	'disabled-by-default-devtools.timeline.frame',
	'disabled-by-default-devtools.timeline.stack',
	// WHY a style recalc or layout happened, not just that it did. Emits
	// StyleRecalcInvalidationTracking / LayoutInvalidationTracking carrying the
	// invalidated node, the reason, and the JS stack that dirtied it.
	//
	// Added after a Sep 2026 field trace could establish that the renderer was
	// repainting every frame while completely idle, and that 41,672 forced
	// synchronous layouts happened in 95 seconds, but could NOT establish who
	// was responsible for either. Without this category those two questions are
	// unanswerable from a trace, which makes the trace unable to close them.
	'disabled-by-default-devtools.timeline.invalidationTracking',
	// Sampling CPU profiler. This is the ONLY usable JS attribution in an
	// Electron trace: the devtools timeline FunctionCall / EvaluateScript events
	// the analysis script originally looked for are not emitted here, so its
	// "hottest JS" table was empty until it learned to read these samples. Drop
	// this category and every JS question becomes unanswerable.
	'disabled-by-default-v8.cpu_profiler',
	// Input -> response latency.
	'latencyInfo',
];

/**
 * Per-process trace buffer, in KB. NOT a whole-capture budget: every process in
 * the app fills its own, so a capture's bundle is a multiple of this.
 *
 * Exported because the buffer watchdog in content-tracing.ts reports usage
 * against it, and because it is the number that decides how long a recording
 * can run before data starts being lost.
 */
export const TRACE_BUFFER_SIZE_KB = 150_000;

/**
 * Build the TraceConfig passed to contentTracing.startRecording().
 *
 * `record-until-full` is the right mode BECAUSE the buffer is now watched: the
 * recording is stopped before the buffer fills (see content-tracing.ts), so
 * what lands on disk is a complete window rather than a fragment.
 *
 * This replaced a "keep captures short" instruction that did not work. Two
 * field captures taken under it retained 22% and 43% of their recordings; the
 * rest was silently discarded, and the analysis could only be done on whatever
 * happened to survive. A person cannot judge how full a trace buffer is by
 * watching an app, so asking them to was never going to hold. The watchdog
 * measures it instead and ends the recording while the data is still intact.
 */
export function buildTraceConfig(categories: string[] = DEFAULT_TRACE_CATEGORIES): TraceConfig {
	return {
		recording_mode: 'record-until-full',
		included_categories: categories,
		trace_buffer_size_in_kb: TRACE_BUFFER_SIZE_KB,
	};
}
