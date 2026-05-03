import * as crypto from 'crypto';
export type {
	CueAction,
	CueCommand,
	CueCommandCliCall,
	CueCommandMode,
	CueConfig,
	CueEvent,
	CueEventType,
	CueGitHubState,
	CueGraphSession,
	CueRunResult,
	CueRunStatus,
	CueScheduleDay,
	CueSessionStatus,
	CueSettings,
	CueSubscription,
} from '../../shared/cue';
export {
	CUE_EVENT_TYPES,
	CUE_GITHUB_STATES,
	CUE_SCHEDULE_DAYS,
	DEFAULT_CUE_SETTINGS,
} from '../../shared/cue';
import type { CueEvent, CueEventType, CueRunStatus } from '../../shared/cue';

/** Data passed with an agent completion notification for chaining */
export interface AgentCompletionData {
	sessionName?: string;
	status?: CueRunStatus;
	exitCode?: number | null;
	durationMs?: number;
	stdout?: string;
	triggeredBy?: string;
	/** Tracks how many chained hops have occurred to prevent infinite loops */
	chainDepth?: number;
	/** Outputs from upstream agents that should be forwarded through this agent
	 *  to downstream agents. Keyed by source session name. */
	forwardedOutputs?: Record<string, string>;
	/** Phase 01 — chain lineage carriers for stats. The completing run's own
	 *  `runId` (becomes the next event's `parentEventId`) and its `chainRootId`
	 *  (which the next event inherits, or falls back to `parentRunId` if the
	 *  parent was itself a root). Both are absent for non-Cue completions
	 *  (e.g. exit-listener-driven user session completes), in which case the
	 *  downstream dispatch becomes a new chain root. */
	parentRunId?: string;
	chainRootId?: string;
}

/** Create a CueEvent with auto-generated id and timestamp */
export function createCueEvent(
	type: CueEventType,
	triggerName: string,
	payload: Record<string, unknown> = {}
): CueEvent {
	return {
		id: crypto.randomUUID(),
		type,
		timestamp: new Date().toISOString(),
		triggerName,
		payload,
	};
}

/** Default filename for Cue configuration */
export const CUE_YAML_FILENAME = 'maestro-cue.yaml';

/**
 * @deprecated Import CUE_CONFIG_PATH from shared/maestro-paths instead.
 * Kept for backwards compat references that check legacy location.
 */
export const LEGACY_CUE_YAML_FILENAME = CUE_YAML_FILENAME;
