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
	// Sampling CPU profiler: attributes time to JS call stacks. Kept because the
	// raw samples live in the trace for deep dives in Perfetto, even though the
	// markdown analysis leans on the cheaper timeline FunctionCall events.
	'disabled-by-default-v8.cpu_profiler',
	// Input -> response latency.
	'latencyInfo',
	// Resource loading.
	'loading',
];

/**
 * Build the TraceConfig passed to contentTracing.startRecording().
 *
 * `record-until-full` keeps the earliest events and stops capturing once the
 * buffer fills, which suits the intended workflow: start, reproduce the lag for
 * a few seconds, stop. The buffer cap also bounds the on-disk trace size so a
 * forgotten recording cannot grow without limit.
 */
export function buildTraceConfig(categories: string[] = DEFAULT_TRACE_CATEGORIES): TraceConfig {
	return {
		recording_mode: 'record-until-full',
		included_categories: categories,
		// ~150MB ceiling. Generous for a manual capture, still bounded.
		trace_buffer_size_in_kb: 150_000,
	};
}
