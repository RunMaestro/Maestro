/**
 * Preload API for debug and document graph operations
 *
 * Provides the window.maestro.debug and window.maestro.documentGraph namespaces for:
 * - Debug package generation
 * - Document graph file watching
 */

import { ipcRenderer } from 'electron';
import type { DebugPackageOptions } from '../../shared/debugPackage';

import type { RuntimeSelfTestReport } from '../acappella/runtime/runtime-selftest';

// Re-exported rather than re-declared: rc moved the canonical definition to
// `shared/debugPackage`, and a second local copy of the same shape is exactly
// how the two drift apart.
export type { DebugPackageOptions };

/**
 * The voice self-test response.
 *
 * `success` is the IPC envelope (did the handler run), `report.passed` is the
 * diagnosis (did the runtimes work). They are different questions and a caller
 * has to be able to tell "the self-test could not run" from "the self-test says
 * ONNX is broken".
 */
export interface VoiceSelfTestResponse {
	success: boolean;
	report?: RuntimeSelfTestReport;
	error?: string;
}

/**
 * Document graph file change event
 */
export interface DocumentGraphChange {
	filePath: string;
	eventType: 'add' | 'change' | 'unlink';
}

/**
 * Runtime snapshot returned by debug:getAppStats.
 * See src/main/ipc/handlers/debug.ts for field population details.
 */
export interface AppStatsSnapshot {
	timestamp: number;
	platform: NodeJS.Platform;
	main: {
		rss: number;
		heapTotal: number;
		heapUsed: number;
		external: number;
		arrayBuffers: number;
	};
	electronProcesses: Array<{
		pid: number;
		type: string;
		name?: string;
		serviceName?: string;
		cpuPercent?: number;
		workingSetBytes?: number;
		peakWorkingSetBytes?: number;
	}>;
	managedProcesses: Array<{
		sessionId: string;
		toolType: string;
		pid?: number;
		isTerminal?: boolean;
		isBatchMode: boolean;
		startTime?: number;
		rssBytes?: number;
	}>;
}

/**
 * Live performance-profiling status (debug:getProfilingStatus / startProfiling).
 */
export interface ProfilingStatusResponse {
	success: boolean;
	active: boolean;
	startedAt: number;
	elapsedMs: number;
	categories: string[];
	/**
	 * Trace-buffer usage, 0-1. This - not elapsed time - is what limits a
	 * recording: Chromium drops events once the buffer fills, so the UI shows
	 * this so a capture's remaining headroom is visible rather than guessed at.
	 */
	bufferPercent: number;
	peakBufferPercent: number;
	bufferSizeKb: number;
	/** True once the watchdog has asked for the recording to end. */
	autoStopRequested: boolean;
	error?: string;
}

/**
 * Emitted when the buffer watchdog ends a recording (debug:profilingAutoStopped).
 * The renderer responds by opening the capture modal, which runs the ordinary
 * stop-and-save flow.
 */
export interface ProfilingAutoStoppedEvent extends Omit<ProfilingStatusResponse, 'success'> {
	reason: 'buffer-full';
}

/**
 * Result of stopping a recording and saving the bundle (debug:stopProfiling).
 */
export interface StopProfilingResponse {
	success: boolean;
	path: string | null;
	cancelled: boolean;
	bundleSizeBytes: number;
	traceSizeBytes: number;
	durationMs: number;
	/** Highest trace-buffer usage the recording reached, 0-1. */
	peakBufferPercent?: number;
	/** The buffer watchdog ended the recording rather than the user. */
	autoStopped?: boolean;
	/** Usage hit the stop threshold; the trace may be missing events. */
	bufferExhausted?: boolean;
	error?: string;
}

/**
 * Result of stopping a recording and writing the bundle to a temp file without
 * a save dialog (debug:stopProfilingToFile). The path is a temp .zip the caller
 * must either submit with feedback or drop via debug:discardTrace.
 */
export interface StopProfilingToFileResponse {
	success: boolean;
	path: string;
	bundleSizeBytes: number;
	traceSizeBytes: number;
	durationMs: number;
	error?: string;
}

/**
 * Live phase updates emitted while a capture is being stopped and bundled
 * (debug:profilingProgress). Drives the progress modal so a slow zip compression
 * doesn't look like a frozen UI.
 */
export interface ProfilingProgressEvent {
	phase: 'stopping' | 'awaiting-save' | 'compressing' | 'done' | 'cancelled' | 'error';
	/** 0-100, present during 'compressing' and 'done'. */
	percent?: number;
	bytesProcessed?: number;
	totalBytes?: number;
	/** Saved bundle path, present on 'done'. */
	path?: string | null;
	bundleSizeBytes?: number;
	/** Present on 'error'. */
	error?: string;
}

/**
 * Creates the Debug API object for preload exposure
 */
export function createDebugApi() {
	return {
		createPackage: (options?: DebugPackageOptions) =>
			ipcRenderer.invoke('debug:createPackage', options),

		previewPackage: () => ipcRenderer.invoke('debug:previewPackage'),

		getAppStats: (): Promise<AppStatsSnapshot> => ipcRenderer.invoke('debug:getAppStats'),

		// A Cappella voice self-test: loads each native runtime, runs a trivial
		// operation, and reports per-runtime pass/fail with timings. Loads no model,
		// so it is safe to run at any time, including before anything is downloaded.
		voiceSelfTest: (): Promise<VoiceSelfTestResponse> => ipcRenderer.invoke('debug:voiceSelfTest'),

		// Performance profiling (Chromium contentTracing). Off by default with no
		// steady-state cost; see src/main/profiling.
		getProfilingStatus: (): Promise<ProfilingStatusResponse> =>
			ipcRenderer.invoke('debug:getProfilingStatus'),

		startProfiling: (): Promise<ProfilingStatusResponse> =>
			ipcRenderer.invoke('debug:startProfiling'),

		stopProfiling: (): Promise<StopProfilingResponse> => ipcRenderer.invoke('debug:stopProfiling'),

		// Stop the recording and bundle it to a temp .zip without a save dialog,
		// for attaching a trace to in-app feedback.
		stopProfilingToFile: (): Promise<StopProfilingToFileResponse> =>
			ipcRenderer.invoke('debug:stopProfilingToFile'),

		// Delete an abandoned temp trace zip produced by stopProfilingToFile.
		discardTrace: (filePath: string): Promise<{ success: boolean }> =>
			ipcRenderer.invoke('debug:discardTrace', filePath),
		/**
		 * Fire a synthetic provider credential failure through the real event
		 * channel, so the whole re-authentication flow can be exercised without
		 * waiting for a token to actually expire.
		 */
		simulateAuthExpiry: (payload: {
			processSessionId: string;
			agentId: string;
			sshRemoteId?: string;
			fromPipeline?: boolean;
		}): Promise<{ success: boolean }> => ipcRenderer.invoke('debug:simulateAuthExpiry', payload),

		// Subscribe to capture progress (stopping -> compressing -> done). Returns
		// an unsubscribe function. Mirrors the documentGraph:filesChanged pattern.
		onProfilingProgress: (handler: (event: ProfilingProgressEvent) => void) => {
			const wrapped = (_event: Electron.IpcRendererEvent, data: ProfilingProgressEvent) =>
				handler(data);
			ipcRenderer.on('debug:profilingProgress', wrapped);
			return () => ipcRenderer.removeListener('debug:profilingProgress', wrapped);
		},

		/**
		 * Subscribe to the buffer watchdog ending a recording. Returns an
		 * unsubscribe function.
		 */
		onProfilingAutoStopped: (handler: (event: ProfilingAutoStoppedEvent) => void) => {
			const wrapped = (_event: Electron.IpcRendererEvent, data: ProfilingAutoStoppedEvent) =>
				handler(data);
			ipcRenderer.on('debug:profilingAutoStopped', wrapped);
			return () => ipcRenderer.removeListener('debug:profilingAutoStopped', wrapped);
		},
	};
}

/**
 * Creates the Document Graph API object for preload exposure
 */
export function createDocumentGraphApi() {
	return {
		watchFolder: (rootPath: string) => ipcRenderer.invoke('documentGraph:watchFolder', rootPath),

		unwatchFolder: (rootPath: string) =>
			ipcRenderer.invoke('documentGraph:unwatchFolder', rootPath),

		onFilesChanged: (
			handler: (data: { rootPath: string; changes: DocumentGraphChange[] }) => void
		) => {
			const wrappedHandler = (
				_event: Electron.IpcRendererEvent,
				data: { rootPath: string; changes: DocumentGraphChange[] }
			) => handler(data);
			ipcRenderer.on('documentGraph:filesChanged', wrappedHandler);
			return () => ipcRenderer.removeListener('documentGraph:filesChanged', wrappedHandler);
		},
	};
}

export type DebugApi = ReturnType<typeof createDebugApi>;
export type DocumentGraphApi = ReturnType<typeof createDocumentGraphApi>;
