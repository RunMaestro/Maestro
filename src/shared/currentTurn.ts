import type { LogEntryRecord } from './maestro-lib/store/transcript';

/** Additive v1 desktop observation protocol. A revision is meaningful only in its host generation. */
export interface CurrentTurnCursor {
	generation: string;
	/** Native owner-renderer incarnation; changes when the transcript publisher restarts. */
	sourceGeneration: string;
	agentId: string;
	tabId: string;
	createdAt: number;
	provider: string;
	agentSessionId: string | null;
	runId: string | null;
	turnId: string | null;
	revision: number;
}

/** Native log rows keep tool input/output and card payloads as well as prose. */
export type CurrentTurnMessage = LogEntryRecord;

export interface CurrentTurnRead {
	version: 1;
	cursor: CurrentTurnCursor;
	status: 'complete' | 'incomplete' | 'gap' | 'reset' | 'unknown';
	reason?: string;
	/** Full current turn, beginning with the native submitted user row. Never a tail. */
	messages: CurrentTurnMessage[];
}

/** Ordered commits from the native owning renderer, separate from disk's 100-row window. */
export interface TranscriptObservation {
	sourceGeneration: string;
	sequence: number;
	createdAt: number;
	provider: string;
	closed?: boolean;
}
