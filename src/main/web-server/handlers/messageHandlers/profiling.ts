/**
 * Profiling domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: profiling_start,
 * profiling_status, profiling_stop.
 */

import path from 'path';
import fs from 'fs/promises';
import { app } from 'electron';
import { logger } from '../../../utils/logger';
import {
	startProfiling,
	stopProfiling,
	getProfilingStatus,
	finalizeCapture,
} from '../../../profiling';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/**
 * Handle profiling_start - begin a Chromium contentTracing capture.
 *
 * contentTracing is an Electron main-process API, so the CLI (a plain bundle
 * with no Electron) cannot drive it directly - it routes through here. Mirrors
 * the desktop debug:startProfiling handler but with no renderer/dialog coupling
 * so it works headlessly for external instrumentation loops.
 */
export async function handleProfilingStart(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	try {
		const status = await startProfiling();
		ctx.send(client, {
			type: 'profiling_start_result',
			success: true,
			active: status.active,
			startedAt: status.startedAt,
			categories: status.categories,
			requestId: message.requestId,
		});
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		ctx.send(client, {
			type: 'profiling_start_result',
			success: false,
			error: `Failed to start profiling: ${errMsg}`,
			requestId: message.requestId,
		});
	}
}

/**
 * Handle profiling_status - report whether a capture is in flight.
 */
export function handleProfilingStatus(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const status = getProfilingStatus();
	ctx.send(client, {
		type: 'profiling_status_result',
		success: true,
		active: status.active,
		startedAt: status.startedAt,
		elapsedMs: status.elapsedMs,
		categories: status.categories,
		requestId: message.requestId,
	});
}

/**
 * Handle profiling_stop - stop the capture and write the bundle to `outputPath`.
 *
 * Unlike the desktop flow (which prompts for a save location), the CLI supplies
 * an absolute output path so external scripts can capture -> analyze -> loop
 * unattended. The trace is flushed to a temp file first (ending the recording
 * overhead immediately), then compressed into the .zip bundle at `outputPath`.
 */
export async function handleProfilingStop(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const sendResult = (success: boolean, extra?: Record<string, unknown>) => {
		ctx.send(client, {
			type: 'profiling_stop_result',
			success,
			...extra,
			requestId: message.requestId,
		});
	};

	const outputPath = typeof message.outputPath === 'string' ? message.outputPath : '';
	if (!outputPath) {
		sendResult(false, { error: 'Missing outputPath' });
		return;
	}
	// The CLI resolves to an absolute path (it knows the user's cwd); the app's
	// cwd is unrelated, so reject relative paths rather than guess.
	if (!path.isAbsolute(outputPath)) {
		sendResult(false, { error: `outputPath must be absolute, got: ${outputPath}` });
		return;
	}

	if (!getProfilingStatus().active) {
		sendResult(false, { error: 'No active profiling recording to stop' });
		return;
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const tracePath = path.join(app.getPath('temp'), `maestro-trace-${timestamp}.json`);

	try {
		const { durationMs, categories } = await stopProfiling(tracePath);
		// Ensure the destination directory exists so callers can point at a fresh
		// output dir per loop iteration without pre-creating it.
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		const finalized = await finalizeCapture(tracePath, outputPath, durationMs, categories);
		logger.info(`[Profiling] CLI capture saved: ${finalized.path} (${durationMs}ms trace)`);
		sendResult(true, {
			path: finalized.path,
			bundleSizeBytes: finalized.bundleSizeBytes,
			traceSizeBytes: finalized.traceSizeBytes,
			durationMs,
		});
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		sendResult(false, { error: `Failed to save profile: ${errMsg}` });
	} finally {
		await fs.rm(tracePath, { force: true }).catch(() => {});
	}
}
