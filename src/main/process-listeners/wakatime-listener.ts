/**
 * WakaTime heartbeat listener.
 * Sends WakaTime heartbeats on AI activity (data, thinking-chunk events) and batch
 * query completions. Cleans up debounce tracking on process exit.
 *
 * The `data` event fires on every stdout chunk for both interactive and batch sessions.
 * The `thinking-chunk` event fires while the AI is actively reasoning (extended thinking).
 * Together these ensure heartbeats cover the full duration of AI activity.
 * The `query-complete` event fires only for batch/auto-run processes.
 *
 * When detailed tracking is enabled, `tool-execution` events accumulate file paths
 * from write operations, which are flushed as file-level heartbeats on `query-complete`
 * (batch) or after a debounced `usage` event (interactive).
 */

import path from 'path';
import type Store from 'electron-store';
import type { ProcessManager } from '../process-manager';
import type { QueryCompleteData, ToolExecution, UsageStats } from '../process-manager/types';
import type { WakaTimeManager } from '../wakatime-manager';
import { extractFilePathFromToolExecution } from '../wakatime-manager';
import type { MaestroSettings } from '../stores/types';

/** Helper to send a heartbeat for a managed process */
function heartbeatForSession(
	processManager: ProcessManager,
	wakaTimeManager: WakaTimeManager,
	sessionId: string
): void {
	const managedProcess = processManager.get(sessionId);
	if (!managedProcess || managedProcess.isTerminal) return;
	const projectDir = managedProcess.projectPath || managedProcess.cwd;
	const projectName = projectDir ? path.basename(projectDir) : sessionId;
	void wakaTimeManager.sendHeartbeat(sessionId, projectName, projectDir);
}

/** Debounce delay for flushing file heartbeats after a `usage` event (ms) */
const USAGE_FLUSH_DELAY_MS = 500;

/**
 * Sets up the WakaTime heartbeat listener on data, thinking-chunk,
 * tool-execution, usage, query-complete, and exit events.
 * Heartbeat calls are fire-and-forget (no await needed in the listener).
 */
export function setupWakaTimeListener(
	processManager: ProcessManager,
	wakaTimeManager: WakaTimeManager,
	settingsStore: Store<MaestroSettings>
): void {
	// Cache enabled state so data/thinking-chunk listeners can bail out
	// without hitting the store on every stdout chunk
	let enabled = settingsStore.get('wakatimeEnabled', false);
	settingsStore.onDidChange('wakatimeEnabled', (v) => {
		enabled = !!v;
	});

	// Cache detailed tracking state for file-level heartbeats
	let detailedEnabled = settingsStore.get('wakatimeDetailedTracking', false) as boolean;
	settingsStore.onDidChange('wakatimeDetailedTracking', (val: unknown) => {
		detailedEnabled = !!val;
	});

	// Per-session accumulator for file paths from tool-execution events.
	// Outer key: sessionId, inner key: filePath (deduplicates, keeping latest timestamp).
	const pendingFiles = new Map<string, Map<string, { filePath: string; timestamp: number }>>();

	// Per-session debounce timers for usage-based file flush.
	const usageFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();

	/** Flush accumulated file heartbeats for a session. */
	function flushPendingFiles(sessionId: string, projectDir: string | undefined, projectName: string): void {
		const sessionFiles = pendingFiles.get(sessionId);
		if (!sessionFiles || sessionFiles.size === 0) return;

		const filesArray = Array.from(sessionFiles.values()).map((f) => ({
			filePath: path.isAbsolute(f.filePath)
				? f.filePath
				: path.resolve(projectDir || '', f.filePath),
			timestamp: f.timestamp,
		}));

		void wakaTimeManager.sendFileHeartbeats(filesArray, projectName, projectDir);
		pendingFiles.delete(sessionId);
	}

	// Send heartbeat on any AI output (covers interactive sessions)
	// The 2-minute debounce in WakaTimeManager prevents flooding
	processManager.on('data', (sessionId: string) => {
		if (!enabled) return;
		heartbeatForSession(processManager, wakaTimeManager, sessionId);
	});

	// Send heartbeat during AI thinking (extended thinking / reasoning)
	// This ensures time spent on long reasoning is captured
	processManager.on('thinking-chunk', (sessionId: string) => {
		if (!enabled) return;
		heartbeatForSession(processManager, wakaTimeManager, sessionId);
	});

	// Collect file paths from write-tool executions for file-level heartbeats
	processManager.on('tool-execution', (sessionId: string, toolExecution: ToolExecution) => {
		if (!enabled || !detailedEnabled) return;

		const filePath = extractFilePathFromToolExecution(toolExecution);
		if (!filePath) return;

		let sessionFiles = pendingFiles.get(sessionId);
		if (!sessionFiles) {
			sessionFiles = new Map();
			pendingFiles.set(sessionId, sessionFiles);
		}
		sessionFiles.set(filePath, { filePath, timestamp: toolExecution.timestamp });
	});

	// Also send heartbeat on query-complete for batch/auto-run processes
	processManager.on('query-complete', (_sessionId: string, queryData: QueryCompleteData) => {
		if (!enabled) return;
		const projectName = queryData.projectPath
			? path.basename(queryData.projectPath)
			: queryData.sessionId;
		void wakaTimeManager.sendHeartbeat(queryData.sessionId, projectName, queryData.projectPath);

		// Flush accumulated file heartbeats
		if (detailedEnabled) {
			flushPendingFiles(queryData.sessionId, queryData.projectPath, projectName);
		}

		// Cancel any pending usage-based flush since query-complete already flushed
		const timer = usageFlushTimers.get(queryData.sessionId);
		if (timer) {
			clearTimeout(timer);
			usageFlushTimers.delete(queryData.sessionId);
		}
	});

	// Flush accumulated file heartbeats on usage events (fires for ALL sessions,
	// including interactive). Debounced per-session since usage can fire multiple
	// times per turn.
	processManager.on('usage', (sessionId: string, _usageStats: UsageStats) => {
		if (!enabled || !detailedEnabled) return;
		if (!pendingFiles.has(sessionId) || pendingFiles.get(sessionId)!.size === 0) return;

		// Reset existing timer for this session (debounce)
		const existingTimer = usageFlushTimers.get(sessionId);
		if (existingTimer) {
			clearTimeout(existingTimer);
		}

		usageFlushTimers.set(
			sessionId,
			setTimeout(() => {
				usageFlushTimers.delete(sessionId);

				const managedProcess = processManager.get(sessionId);
				if (!managedProcess || managedProcess.isTerminal) return;

				const projectDir = managedProcess.projectPath || managedProcess.cwd;
				const projectName = projectDir ? path.basename(projectDir) : sessionId;

				flushPendingFiles(sessionId, projectDir, projectName);
			}, USAGE_FLUSH_DELAY_MS)
		);
	});

	// Clean up debounce tracking, pending file data, and flush timers on exit
	processManager.on('exit', (sessionId: string) => {
		wakaTimeManager.removeSession(sessionId);
		pendingFiles.delete(sessionId);
		const timer = usageFlushTimers.get(sessionId);
		if (timer) {
			clearTimeout(timer);
			usageFlushTimers.delete(sessionId);
		}
	});
}
