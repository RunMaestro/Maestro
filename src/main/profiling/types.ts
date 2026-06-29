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
	mainProcessMemory: {
		rss: number;
		heapTotal: number;
		heapUsed: number;
		external: number;
	};
}
