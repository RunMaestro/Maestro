import type { AgentError, BatchRunConfig } from './types';

/** Commands operate on the host renderer's existing Auto Run, never a client loop. */
export type AutoRunRemoteControl =
	| { action: 'stop' | 'kill' | 'resume' | 'skip-document' | 'abort' }
	| { action: 'pause'; error: AgentError; documentIndex: number; taskDescription?: string };

export interface AutoRunRemoteResult {
	success: boolean;
	error?: string;
}

export type StartAutoRunCallback = (
	sessionId: string,
	config: BatchRunConfig,
	folderPath: string
) => Promise<AutoRunRemoteResult>;

export type ControlAutoRunCallback = (
	sessionId: string,
	control: AutoRunRemoteControl
) => Promise<AutoRunRemoteResult>;
