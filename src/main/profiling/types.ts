/**
 * Shared types for the performance-profiling feature.
 *
 * Profiling is driven by Electron's `contentTracing` (Chromium's built-in trace
 * engine). When recording is off the trace points compile to a single disabled
 * atomic-flag check, so there is no measurable runtime cost. A capture produces
 * a raw Chromium trace that we bundle (with capture metadata) into a compressed
 * .zip. Analysis is intentionally a development-time activity: process the
 * bundle with `scripts/analyze-perf-trace.mjs` or load `trace.json` into
 * https://ui.perfetto.dev. See CLAUDE-PERFORMANCE.md.
 */

/** Live recording status, surfaced to the renderer so the palette can toggle. */
export interface ProfilingStatus {
	active: boolean;
	/** Epoch ms when the current recording began (0 when inactive). */
	startedAt: number;
	/** Wall-clock ms elapsed since recording began (0 when inactive). */
	elapsedMs: number;
	/** Categories the active recording was started with (empty when inactive). */
	categories: string[];
	/**
	 * Most recently sampled trace-buffer usage, 0-1.
	 *
	 * This is the number that decides how long a recording can usefully run, so
	 * it is surfaced rather than kept internal: elapsed time tells a user nothing
	 * about how much window they have left, and a quiet app can record for many
	 * minutes where a busy one fills the buffer in one.
	 */
	bufferPercent: number;
	/** Highest usage seen during this recording, 0-1. */
	peakBufferPercent: number;
	/** Per-process buffer size the percentages are measured against. */
	bufferSizeKb: number;
	/** True once the buffer watchdog has asked for the recording to end. */
	autoStopRequested: boolean;
}

/**
 * What a stopped recording knows about itself, including whether its data is
 * complete. Produced by `stopProfiling`, folded into the bundle metadata.
 */
export interface StopProfilingOutcome {
	/** Wall-clock ms the recording ran for. */
	durationMs: number;
	categories: string[];
	/** Highest trace-buffer usage sampled during the recording, 0-1. */
	peakBufferPercent: number;
	/** True when the buffer watchdog ended the recording rather than the user. */
	autoStopped: boolean;
	/**
	 * True when buffer usage reached the stop threshold, meaning events may have
	 * been dropped and the trace may cover less time than it ran for.
	 */
	bufferExhausted: boolean;
}

/** Result of stopping a recording and saving the bundle. */
export interface StopProfilingResult {
	/** Absolute path to the saved .zip, or null when the save dialog was cancelled. */
	path: string | null;
	cancelled: boolean;
	/** Compressed bundle size in bytes (0 when cancelled). */
	bundleSizeBytes: number;
	/** Raw (uncompressed) trace size in bytes. */
	traceSizeBytes: number;
	/** Wall-clock duration the recording ran for, in ms. */
	durationMs: number;
}

/** Capture context bundled alongside the trace for offline analysis. */
export interface ProfileMetadata {
	capturedAt: string;
	appVersion: string;
	electronVersion: string;
	chromeVersion: string;
	v8Version: string;
	platform: string;
	arch: string;
	cpuModel: string;
	cpuCount: number;
	totalMemBytes: number;
	freeMemBytes: number;
	loadAvg: number[];
	profilingDurationMs: number;
	recordingMode: string;
	categories: string[];
	traceSizeBytes: number;
	/**
	 * Per-process trace buffer size, and how full it got.
	 *
	 * Present so a trace can state its own completeness. Before these existed,
	 * the only way to suspect a truncated capture was to compare the covered
	 * window against `profilingDurationMs` after parsing the whole file - a
	 * check that produced a warning, not a fact, and only after the analysis had
	 * already been run on possibly-partial data.
	 */
	traceBufferSizeKb: number;
	peakBufferPercent: number;
	/** The buffer watchdog ended this recording rather than the user. */
	autoStopped: boolean;
	/** Buffer usage reached the stop threshold; events may have been dropped. */
	bufferExhausted: boolean;
	mainProcessMemory: {
		rss: number;
		heapTotal: number;
		heapUsed: number;
		external: number;
	};
}
