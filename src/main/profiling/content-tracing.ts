/**
 * Recording state machine around Electron's `contentTracing`, plus the buffer
 * watchdog that decides when a recording has to end.
 *
 * contentTracing is a process-global singleton: only one recording can be in
 * flight across the whole app at a time. This module owns that single bit of
 * state so the IPC layer and the renderer always agree on whether profiling is
 * active. Nothing here runs while profiling is off, so the feature has no
 * steady-state cost.
 *
 * ## The buffer watchdog
 *
 * Chromium records into a fixed per-process ring of `TRACE_BUFFER_SIZE_KB`.
 * When it fills, events are dropped, and NOTHING in the app or the resulting
 * file says so - the trace simply covers less time than the recording ran for,
 * and every question asked of it is silently answered from a fragment.
 *
 * That is not hypothetical. Two field captures (Sep 2026) retained 22% and 43%
 * of their recordings. The guidance at the time was "keep captures short",
 * which asks a person to estimate trace-buffer pressure by looking at an app
 * window. Nobody can do that.
 *
 * So the buffer is polled while recording. Usage is reported live (the UI shows
 * it), and at {@link BUFFER_STOP_THRESHOLD} the watchdog calls the registered
 * auto-stop handler, which drives the same stop-and-save flow the user's own
 * "End Performance Profiling" does. The recording ends while its data is still
 * complete, instead of degrading into a fragment nobody knows to distrust.
 */

import { contentTracing } from 'electron';
import { logger } from '../utils/logger';
import { buildTraceConfig, DEFAULT_TRACE_CATEGORIES, TRACE_BUFFER_SIZE_KB } from './categories';
import type { ProfilingStatus, StopProfilingOutcome } from './types';

const LOG_CONTEXT = '[Profiling]';

/**
 * Fraction of the trace buffer at which a recording is stopped.
 *
 * Headroom matters more than squeezing out the last few percent: between two
 * polls a busy renderer can add tens of megabytes, and everything past 1.0 is
 * lost rather than merely unrecorded. Ending at 85% costs a few seconds of
 * window and guarantees the window is whole.
 */
export const BUFFER_STOP_THRESHOLD = 0.85;

/** How often buffer usage is sampled while recording. */
export const BUFFER_POLL_INTERVAL_MS = 1_000;

/**
 * Who asked for this recording, which decides what happens when the buffer
 * fills.
 *
 * A desktop capture ends through the UI (save dialog, progress modal). A CLI
 * capture is unattended and already knows where its bundle goes, so raising a
 * save dialog in its face would hijack a scripted capture -> analyze loop and
 * write the bundle somewhere the script is not looking. CLI callers see
 * `autoStopRequested` in `profiling status` instead and stop themselves.
 */
export type ProfilingOrigin = 'desktop' | 'cli';

interface RecordingState {
	startedAt: number;
	origin: ProfilingOrigin;
	categories: string[];
	/** Most recent sampled buffer usage, 0-1. */
	bufferPercent: number;
	/** Highest usage seen during this recording, 0-1. */
	peakBufferPercent: number;
	/** True once the watchdog has asked for a stop (it only ever asks once). */
	autoStopRequested: boolean;
	pollTimer: NodeJS.Timeout | null;
}

let recording: RecordingState | null = null;

/**
 * Called when the buffer watchdog decides the recording must end now.
 *
 * The handler is expected to drive the normal stop-and-save flow rather than
 * stopping the recording itself, so an automatic stop and a user-initiated one
 * take byte-identical paths - including the save dialog, the progress modal,
 * and the bundling. Registered once by the IPC layer.
 */
let autoStopHandler: ((reason: 'buffer-full') => void) | null = null;

/** Register the auto-stop handler. Passing null clears it. */
export function setProfilingAutoStopHandler(
	handler: ((reason: 'buffer-full') => void) | null
): void {
	autoStopHandler = handler;
}

export function isProfiling(): boolean {
	return recording !== null;
}

export function getProfilingStatus(): ProfilingStatus {
	if (!recording) {
		return {
			active: false,
			startedAt: 0,
			elapsedMs: 0,
			categories: [],
			bufferPercent: 0,
			peakBufferPercent: 0,
			bufferSizeKb: TRACE_BUFFER_SIZE_KB,
			autoStopRequested: false,
		};
	}
	return {
		active: true,
		startedAt: recording.startedAt,
		elapsedMs: Date.now() - recording.startedAt,
		categories: recording.categories,
		bufferPercent: recording.bufferPercent,
		peakBufferPercent: recording.peakBufferPercent,
		bufferSizeKb: TRACE_BUFFER_SIZE_KB,
		autoStopRequested: recording.autoStopRequested,
	};
}

/**
 * Sample buffer usage once and trip the watchdog if the recording is close to
 * losing data.
 *
 * Failures are swallowed deliberately. A usage probe that throws (the tracing
 * service went away, the API is unavailable on this platform) must not kill the
 * recording it is only supposed to be observing - it just means the capture
 * runs unsupervised, which is exactly where this feature started.
 */
async function sampleBuffer(): Promise<void> {
	if (!recording) return;

	let percentage: number;
	try {
		const usage = await contentTracing.getTraceBufferUsage();
		percentage = usage?.percentage ?? 0;
	} catch (err) {
		logger.warn(`${LOG_CONTEXT} getTraceBufferUsage failed; capture is unsupervised`, undefined, {
			error: err instanceof Error ? err.message : String(err),
		});
		return;
	}

	// The recording may have been stopped while the probe was in flight.
	if (!recording) return;

	recording.bufferPercent = percentage;
	if (percentage > recording.peakBufferPercent) {
		recording.peakBufferPercent = percentage;
	}

	if (percentage < BUFFER_STOP_THRESHOLD || recording.autoStopRequested) return;

	recording.autoStopRequested = true;
	const elapsedMs = Date.now() - recording.startedAt;
	logger.info(
		`${LOG_CONTEXT} Trace buffer at ${(percentage * 100).toFixed(0)}% after ${elapsedMs}ms; ` +
			`requesting auto-stop to keep the capture complete`
	);

	if (recording.origin === 'cli') {
		// Nothing to do but flag it. The CLI owns its own output path and its own
		// stop call; taking the recording out from under it would be worse than a
		// truncated trace, because the bundle would land somewhere it never looks.
		logger.info(
			`${LOG_CONTEXT} CLI-owned capture: flagged autoStopRequested, waiting for the caller to stop`
		);
		return;
	}

	if (!autoStopHandler) {
		logger.warn(
			`${LOG_CONTEXT} No auto-stop handler registered; the buffer will overflow and ` +
				`the capture will be truncated`
		);
		return;
	}
	try {
		autoStopHandler('buffer-full');
	} catch (err) {
		logger.error(`${LOG_CONTEXT} auto-stop handler threw`, undefined, err);
	}
}

function startBufferWatchdog(): void {
	if (!recording || recording.pollTimer) return;
	const timer = setInterval(() => {
		void sampleBuffer();
	}, BUFFER_POLL_INTERVAL_MS);
	// Never hold the process open for a profiling poll.
	timer.unref?.();
	recording.pollTimer = timer;
}

function stopBufferWatchdog(state: RecordingState): void {
	if (state.pollTimer) {
		clearInterval(state.pollTimer);
		state.pollTimer = null;
	}
}

/**
 * Begin a recording. Returns the resulting status. No-ops (returns the existing
 * active status) if a recording is already in flight, so a double "Start" can
 * never desync the singleton.
 */
export async function startProfiling(
	categories: string[] = DEFAULT_TRACE_CATEGORIES,
	origin: ProfilingOrigin = 'desktop'
): Promise<ProfilingStatus> {
	if (recording) {
		logger.warn(`${LOG_CONTEXT} startProfiling called while already recording; ignoring`);
		return getProfilingStatus();
	}

	await contentTracing.startRecording(buildTraceConfig(categories));
	recording = {
		startedAt: Date.now(),
		origin,
		categories,
		bufferPercent: 0,
		peakBufferPercent: 0,
		autoStopRequested: false,
		pollTimer: null,
	};
	startBufferWatchdog();
	logger.info(
		`${LOG_CONTEXT} Recording started (${categories.length} categories, origin ${origin})`
	);
	return getProfilingStatus();
}

/**
 * Stop the active recording and flush it to `outputPath`.
 *
 * The returned {@link StopProfilingOutcome} carries what the capture knows
 * about its own completeness. That travels into the bundle's metadata so a
 * trace can state whether it is whole, rather than leaving a reader to infer it
 * from a covered-window calculation that only ever produced a suspicion.
 *
 * Throws if nothing was recording so callers do not silently produce an empty
 * trace.
 */
export async function stopProfiling(outputPath: string): Promise<StopProfilingOutcome> {
	if (!recording) {
		throw new Error('No active profiling recording to stop');
	}

	const state = recording;
	const durationMs = Date.now() - state.startedAt;
	// Clear state before awaiting so a failure can't leave us wedged "recording",
	// and stop the watchdog so it cannot fire against a dead recording.
	stopBufferWatchdog(state);
	recording = null;

	try {
		await contentTracing.stopRecording(outputPath);
	} catch (err) {
		logger.error(`${LOG_CONTEXT} stopRecording failed`, undefined, err);
		throw err;
	}

	const outcome: StopProfilingOutcome = {
		durationMs,
		categories: state.categories,
		peakBufferPercent: state.peakBufferPercent,
		autoStopped: state.autoStopRequested,
		// Peak usage is sampled, so a buffer that filled between two polls reads
		// below 1.0 here. Treat anything at or past the stop threshold as "this
		// capture may have started dropping events" rather than claiming a
		// precision the sampling does not have.
		bufferExhausted: state.peakBufferPercent >= BUFFER_STOP_THRESHOLD,
	};

	logger.info(
		`${LOG_CONTEXT} Recording stopped after ${durationMs}ms ` +
			`(peak buffer ${(state.peakBufferPercent * 100).toFixed(0)}%` +
			`${state.autoStopRequested ? ', auto-stopped' : ''}) -> ${outputPath}`
	);
	return outcome;
}
