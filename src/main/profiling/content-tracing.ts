/**
 * Recording state machine around Electron's `contentTracing`.
 *
 * contentTracing is a process-global singleton: only one recording can be in
 * flight across the whole app at a time. This module owns that single bit of
 * state so the IPC layer and the renderer always agree on whether profiling is
 * active. Nothing here runs while profiling is off, so the feature has no
 * steady-state cost.
 */

import { contentTracing } from 'electron';
import { logger } from '../utils/logger';
import { buildTraceConfig, DEFAULT_TRACE_CATEGORIES } from './categories';
import type { ProfilingStatus } from './types';

const LOG_CONTEXT = '[Profiling]';

interface RecordingState {
	startedAt: number;
	categories: string[];
}

let recording: RecordingState | null = null;

export function isProfiling(): boolean {
	return recording !== null;
}

export function getProfilingStatus(): ProfilingStatus {
	if (!recording) {
		return { active: false, startedAt: 0, elapsedMs: 0, categories: [] };
	}
	return {
		active: true,
		startedAt: recording.startedAt,
		elapsedMs: Date.now() - recording.startedAt,
		categories: recording.categories,
	};
}

/**
 * Begin a recording. Returns the resulting status. No-ops (returns the existing
 * active status) if a recording is already in flight, so a double "Start" can
 * never desync the singleton.
 */
export async function startProfiling(
	categories: string[] = DEFAULT_TRACE_CATEGORIES
): Promise<ProfilingStatus> {
	if (recording) {
		logger.warn(`${LOG_CONTEXT} startProfiling called while already recording; ignoring`);
		return getProfilingStatus();
	}

	await contentTracing.startRecording(buildTraceConfig(categories));
	recording = { startedAt: Date.now(), categories };
	logger.info(`${LOG_CONTEXT} Recording started (${categories.length} categories)`);
	return getProfilingStatus();
}

/**
 * Stop the active recording and flush it to `outputPath`. Resolves to the
 * duration the recording ran for. Throws if nothing was recording so callers do
 * not silently produce an empty trace.
 */
export async function stopProfiling(
	outputPath: string
): Promise<{ durationMs: number; categories: string[] }> {
	if (!recording) {
		throw new Error('No active profiling recording to stop');
	}

	const durationMs = Date.now() - recording.startedAt;
	const categories = recording.categories;
	// Clear state before awaiting so a failure can't leave us wedged "recording".
	recording = null;

	try {
		await contentTracing.stopRecording(outputPath);
	} catch (err) {
		logger.error(`${LOG_CONTEXT} stopRecording failed`, undefined, err);
		throw err;
	}

	logger.info(`${LOG_CONTEXT} Recording stopped after ${durationMs}ms -> ${outputPath}`);
	return { durationMs, categories };
}
