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
import type { ProfileMetadata } from './types';

export { startProfiling, stopProfiling, isProfiling, getProfilingStatus } from './content-tracing';
export { DEFAULT_TRACE_CATEGORIES } from './categories';
export type { ProfilingStatus, StopProfilingResult } from './types';

function buildMetadata(
	tracePath: string,
	durationMs: number,
	categories: string[]
): ProfileMetadata {
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
		profilingDurationMs: durationMs,
		recordingMode: 'record-until-full',
		categories,
		traceSizeBytes,
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
	durationMs: number,
	categories: string[],
	onProgress?: (percent: number, bytesProcessed: number, totalBytes: number) => void
): Promise<{
	path: string;
	bundleSizeBytes: number;
	traceSizeBytes: number;
}> {
	const meta = buildMetadata(tracePath, durationMs, categories);
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
