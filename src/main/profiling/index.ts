/**
 * Performance profiling: public surface for the IPC layer.
 *
 * The recording state machine lives in content-tracing.ts; here we add the
 * "stop -> bundle" orchestration and re-export everything the IPC handlers need.
 * Trace analysis is deliberately NOT done in-app - it is a development-time
 * activity (see scripts/analyze-perf-trace.mjs and CLAUDE-PERFORMANCE.md).
 */

import fs from 'fs';
import os from 'os';
import { app } from 'electron';
import { writeProfileBundle } from './bundle';
import { TRACE_BUFFER_SIZE_KB } from './categories';
import type { ProfileMetadata, StopProfilingOutcome } from './types';

export {
	startProfiling,
	stopProfiling,
	isProfiling,
	getProfilingStatus,
	setProfilingAutoStopHandler,
	BUFFER_STOP_THRESHOLD,
} from './content-tracing';
export { DEFAULT_TRACE_CATEGORIES, TRACE_BUFFER_SIZE_KB } from './categories';
export type { ProfilingStatus, StopProfilingResult, StopProfilingOutcome } from './types';
export type { ProfilingOrigin } from './content-tracing';

function buildMetadata(tracePath: string, outcome: StopProfilingOutcome): ProfileMetadata {
	const mem = process.memoryUsage();
	let traceSizeBytes = 0;
	try {
		traceSizeBytes = fs.statSync(tracePath).size;
	} catch {
		// best-effort
	}
	return {
		capturedAt: new Date().toISOString(),
		appVersion: app.getVersion(),
		electronVersion: process.versions.electron ?? 'unknown',
		chromeVersion: process.versions.chrome ?? 'unknown',
		v8Version: process.versions.v8 ?? 'unknown',
		platform: process.platform,
		arch: process.arch,
		cpuModel: os.cpus()[0]?.model ?? 'unknown',
		cpuCount: os.cpus().length,
		totalMemBytes: os.totalmem(),
		freeMemBytes: os.freemem(),
		loadAvg: os.loadavg(),
		profilingDurationMs: outcome.durationMs,
		recordingMode: 'record-until-full',
		categories: outcome.categories,
		traceSizeBytes,
		traceBufferSizeKb: TRACE_BUFFER_SIZE_KB,
		peakBufferPercent: outcome.peakBufferPercent,
		autoStopped: outcome.autoStopped,
		bufferExhausted: outcome.bufferExhausted,
		mainProcessMemory: {
			rss: mem.rss,
			heapTotal: mem.heapTotal,
			heapUsed: mem.heapUsed,
			external: mem.external,
		},
	};
}

/**
 * Write the .zip bundle (raw trace + capture metadata) to `outputPath`.
 * Pure orchestration: caller owns the save dialog and temp-file cleanup.
 */
export async function finalizeCapture(
	tracePath: string,
	outputPath: string,
	outcome: StopProfilingOutcome,
	onProgress?: (percent: number, bytesProcessed: number, totalBytes: number) => void
): Promise<{
	path: string;
	bundleSizeBytes: number;
	traceSizeBytes: number;
}> {
	const meta = buildMetadata(tracePath, outcome);
	const { path: bundlePath, sizeBytes } = await writeProfileBundle(
		tracePath,
		meta,
		outputPath,
		onProgress
	);

	return {
		path: bundlePath,
		bundleSizeBytes: sizeBytes,
		traceSizeBytes: meta.traceSizeBytes,
	};
}
