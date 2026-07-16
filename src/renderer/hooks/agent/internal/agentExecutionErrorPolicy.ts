export type AgentSpawnErrorKind =
	| 'watchdog-stalled'
	| 'watchdog-timeout'
	| 'process-exit'
	| 'process-exit-unknown'
	| 'spawn-failed'
	| 'cancelled';

export interface ProcessExitClassification {
	success: boolean;
	error?: string;
	errorKind?: AgentSpawnErrorKind;
}

/**
 * Turns a process exit status into the stable result consumed by batch callers.
 * A missing status is distinct from a non-zero exit because the process manager
 * could not establish whether the agent completed its work.
 */
export function classifyProcessExit(code: number | null | undefined): ProcessExitClassification {
	if (code === 0) return { success: true };
	if (code == null) {
		return {
			success: false,
			error: 'Agent task exited without a status code',
			errorKind: 'process-exit-unknown',
		};
	}
	return {
		success: false,
		error: `Agent task exited with code ${code}`,
		errorKind: 'process-exit',
	};
}

export function classifySpawnFailure(error: unknown): ProcessExitClassification {
	return {
		success: false,
		error: error instanceof Error ? error.message : String(error),
		errorKind: 'spawn-failed',
	};
}

export function classifyCancelledExecution(): ProcessExitClassification {
	return {
		success: false,
		error: 'Agent execution cancelled',
		errorKind: 'cancelled',
	};
}
