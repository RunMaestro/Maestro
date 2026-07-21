import type { ManagedProcess, ProcessConfig } from '../types';

/**
 * Creates only the metadata shared by every managed process. Transport handles,
 * streams, cancellation, and cleanup remain owned by their individual spawner.
 */
export function createManagedProcessBase(
	config: Pick<ProcessConfig, 'sessionId' | 'toolType' | 'cwd' | 'command' | 'args'>,
	options: {
		pid: number;
		isTerminal: boolean;
		startTime?: number;
		command?: string;
		args?: string[];
	}
): Pick<
	ManagedProcess,
	'sessionId' | 'toolType' | 'cwd' | 'pid' | 'isTerminal' | 'startTime' | 'command' | 'args'
> {
	return {
		sessionId: config.sessionId,
		toolType: config.toolType,
		cwd: config.cwd,
		pid: options.pid,
		isTerminal: options.isTerminal,
		startTime: options.startTime ?? Date.now(),
		command: options.command ?? config.command,
		args: options.args ?? config.args,
	};
}
