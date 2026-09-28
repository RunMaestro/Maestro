/**
 * Processes Collector
 *
 * Collects information about active processes.
 * - Working directories are replaced with opaque descriptors
 * - No command output included
 */

import { ProcessManager } from '../../process-manager';
import { redactPath } from './sanitize';

export interface ProcessInfo {
	sessionId: string;
	toolType: string;
	pid: number;
	cwd: string; // Redacted path descriptor
	isTerminal: boolean;
	isBatchMode: boolean;
	uptimeMs: number;
	hasParser: boolean;
}

/**
 * Collect information about active processes.
 */
export async function collectProcesses(
	processManager: ProcessManager | null
): Promise<ProcessInfo[]> {
	const processes: ProcessInfo[] = [];

	if (!processManager) {
		return processes;
	}

	// Get active processes from the process manager
	const activeProcesses = processManager.getAll();

	for (const proc of activeProcesses) {
		const processInfo: ProcessInfo = {
			sessionId: proc.sessionId || 'unknown',
			toolType: proc.toolType || 'unknown',
			pid: proc.pid || 0,
			cwd: redactPath(proc.cwd || ''),
			isTerminal: !!proc.isTerminal,
			isBatchMode: !!proc.isBatchMode,
			uptimeMs: proc.startTime ? Date.now() - proc.startTime : 0,
			hasParser: !!proc.outputParser,
		};

		processes.push(processInfo);
	}

	return processes;
}
