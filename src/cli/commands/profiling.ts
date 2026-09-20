// Profiling commands - start/stop/status a Chromium performance capture in the
// running Maestro desktop app, driven externally so scripts can capture ->
// analyze -> loop while iterating on performance.
//
// contentTracing is an Electron main-process API; the CLI has no Electron, so
// every subcommand routes through the desktop app over the WS bridge.

import path from 'path';
import os from 'os';
import { withMaestroClient } from '../services/maestro-client';

/**
 * Stopping a capture compresses the raw trace (can be hundreds of MB) into the
 * .zip bundle, which takes tens of seconds for a long recording. Give the stop
 * command far more headroom than the default 10s command timeout.
 */
const STOP_TIMEOUT_MS = 180_000;

interface StartOptions {
	json?: boolean;
}

interface StopOptions {
	output?: string;
	json?: boolean;
}

interface StatusOptions {
	json?: boolean;
}

/** Expand a leading `~` and resolve to an absolute path against the CLI's cwd. */
function resolveOutputPath(input: string): string {
	let p = input.trim();
	if (p === '~' || p.startsWith('~/')) {
		p = path.join(os.homedir(), p.slice(1));
	}
	return path.resolve(process.cwd(), p);
}

export async function profilingStart(options: StartOptions): Promise<void> {
	try {
		const result = await withMaestroClient((client) =>
			client.sendCommand<{
				success: boolean;
				active?: boolean;
				startedAt?: number;
				categories?: string[];
				error?: string;
			}>({ type: 'profiling_start' }, 'profiling_start_result')
		);

		if (result.success) {
			if (options.json) {
				console.log(JSON.stringify({ success: true, active: result.active }));
			} else {
				console.log('Performance profiling started. Reproduce the slowness, then run:');
				console.log('  maestro-cli profiling stop --output <path.zip>');
				// How long a capture can run is set by trace-buffer pressure, not by
				// the clock: a busy app fills the buffer in a fraction of the time a
				// quiet one takes, and everything past full is dropped without a word.
				// Point at the one command that can actually answer "is it time yet".
				console.log('');
				console.log('Watch buffer pressure with `maestro-cli profiling status` and stop');
				console.log('before it reaches 85% - past that, events are dropped.');
			}
		} else {
			const errMsg = result.error || 'Failed to start profiling';
			if (options.json) {
				console.log(JSON.stringify({ success: false, error: errMsg }));
			} else {
				console.error(`Error: ${errMsg}`);
			}
			process.exit(1);
		}
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: errMsg }));
		} else {
			console.error(`Error: ${errMsg}`);
		}
		process.exit(1);
	}
}

export async function profilingStop(options: StopOptions): Promise<void> {
	if (!options.output || !options.output.trim()) {
		console.error('Error: --output <path> is required (where the .zip bundle is written)');
		process.exit(1);
	}

	const outputPath = resolveOutputPath(options.output);

	try {
		const result = await withMaestroClient((client) =>
			client.sendCommand<{
				success: boolean;
				path?: string;
				bundleSizeBytes?: number;
				traceSizeBytes?: number;
				durationMs?: number;
				peakBufferPercent?: number;
				autoStopped?: boolean;
				bufferExhausted?: boolean;
				error?: string;
			}>({ type: 'profiling_stop', outputPath }, 'profiling_stop_result', STOP_TIMEOUT_MS)
		);

		if (result.success) {
			if (options.json) {
				console.log(
					JSON.stringify({
						success: true,
						path: result.path,
						bundleSizeBytes: result.bundleSizeBytes,
						traceSizeBytes: result.traceSizeBytes,
						durationMs: result.durationMs,
						peakBufferPercent: result.peakBufferPercent,
						bufferExhausted: result.bufferExhausted,
					})
				);
			} else {
				console.log(`Profile saved: ${result.path}`);
				if (typeof result.durationMs === 'number') {
					console.log(`  Recording: ${(result.durationMs / 1000).toFixed(1)}s`);
				}
				// Say whether the bundle is whole. A scripted loop that keeps feeding
				// truncated captures to the analyzer gets confident answers about a
				// fragment, and nothing in the numbers reveals that.
				const peakPct = Math.round((result.peakBufferPercent ?? 0) * 100);
				if (result.bufferExhausted) {
					console.log(
						`  INCOMPLETE: trace buffer peaked at ${peakPct}% - events were dropped and ` +
							'this trace covers less time than the recording ran for.'
					);
				} else if (typeof result.peakBufferPercent === 'number') {
					console.log(`  Complete: peak trace-buffer usage ${peakPct}%, no events dropped.`);
				}
			}
		} else {
			const errMsg = result.error || 'Failed to save profile';
			if (options.json) {
				console.log(JSON.stringify({ success: false, error: errMsg }));
			} else {
				console.error(`Error: ${errMsg}`);
			}
			process.exit(1);
		}
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: errMsg }));
		} else {
			console.error(`Error: ${errMsg}`);
		}
		process.exit(1);
	}
}

export async function profilingStatus(options: StatusOptions): Promise<void> {
	try {
		const result = await withMaestroClient((client) =>
			client.sendCommand<{
				success: boolean;
				active?: boolean;
				startedAt?: number;
				elapsedMs?: number;
				categories?: string[];
				bufferPercent?: number;
				peakBufferPercent?: number;
				autoStopRequested?: boolean;
				error?: string;
			}>({ type: 'profiling_status' }, 'profiling_status_result')
		);

		if (options.json) {
			console.log(
				JSON.stringify({
					success: result.success,
					active: result.active ?? false,
					elapsedMs: result.elapsedMs ?? 0,
					// The field a polling loop should branch on: once this is true the
					// recording is at the edge of dropping events and should be stopped.
					bufferPercent: result.bufferPercent ?? 0,
					autoStopRequested: result.autoStopRequested ?? false,
				})
			);
		} else if (result.active) {
			const secs = ((result.elapsedMs ?? 0) / 1000).toFixed(1);
			const bufferPct = Math.round((result.bufferPercent ?? 0) * 100);
			console.log(`Profiling is ACTIVE (recording for ${secs}s, trace buffer ${bufferPct}% full)`);
			if (result.autoStopRequested) {
				console.log('  STOP NOW: the buffer is full enough that events are about to be dropped.');
			}
		} else {
			console.log('Profiling is not active');
		}
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: errMsg }));
		} else {
			console.error(`Error: ${errMsg}`);
		}
		process.exit(1);
	}
}
