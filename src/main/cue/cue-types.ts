/**
 * Core type definitions for the Maestro Cue event-driven automation system.
 *
 * Cue triggers agent prompts in response to events:
 * - time.heartbeat: periodic timer-based triggers ("run every X minutes")
 * - time.scheduled: cron-like triggers (specific times and days of week)
 * - file.changed: file system change triggers
 * - agent.completed: triggers when another agent finishes
 * - github.pull_request: triggers when new PRs are detected via GitHub CLI polling
 * - github.issue: triggers when new issues are detected via GitHub CLI polling
 * - task.pending: triggers when unchecked markdown tasks (- [ ]) are found in watched files
 */

/** Days of the week for scheduled triggers */
export type CueScheduleDay = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** All valid schedule day values */
export const CUE_SCHEDULE_DAYS: CueScheduleDay[] = [
	'mon',
	'tue',
	'wed',
	'thu',
	'fri',
	'sat',
	'sun',
];

/** Event types that can trigger a Cue subscription */
export type CueEventType =
	| 'time.heartbeat'
	| 'time.scheduled'
	| 'file.changed'
	| 'agent.completed'
	| 'github.pull_request'
	| 'github.issue'
	| 'task.pending';

/** A Cue subscription defines a trigger-prompt pairing */
export interface CueSubscription {
	name: string;
	event: CueEventType;
	enabled: boolean;
	prompt: string;
	prompt_file?: string;
	output_prompt?: string;
	output_prompt_file?: string;
	interval_minutes?: number;
	schedule_times?: string[];
	schedule_days?: CueScheduleDay[];
	watch?: string;
	source_session?: string | string[];
	fan_out?: string[];
	filter?: Record<string, string | number | boolean>;
	repo?: string;
	poll_minutes?: number;
	/** Session ID of the agent that owns this subscription. When set, only that agent activates it. */
	agent_id?: string;
	/** Human-readable label for the trigger (e.g. "Morning Check"). Editor metadata, ignored by engine. */
	label?: string;
}

/** Global Cue settings */
export interface CueSettings {
	timeout_minutes: number;
	timeout_on_fail: 'break' | 'continue';
	max_concurrent: number;
	queue_size: number;
}

/** Default Cue settings */
export const DEFAULT_CUE_SETTINGS: CueSettings = {
	timeout_minutes: 30,
	timeout_on_fail: 'break',
	max_concurrent: 1,
	queue_size: 10,
};

/** Top-level Cue configuration (parsed from YAML) */
export interface CueConfig {
	subscriptions: CueSubscription[];
	settings: CueSettings;
}

/** An event instance produced by a trigger */
export interface CueEvent {
	id: string;
	type: CueEventType;
	timestamp: string;
	triggerName: string;
	payload: Record<string, unknown>;
}

/** Status of a Cue run */
export type CueRunStatus = 'running' | 'completed' | 'failed' | 'timeout' | 'stopped';

/** Result of a completed (or failed/timed-out) Cue run */
export interface CueRunResult {
	runId: string;
	sessionId: string;
	sessionName: string;
	subscriptionName: string;
	event: CueEvent;
	status: CueRunStatus;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	durationMs: number;
	startedAt: string;
	endedAt: string;
}

/** Status summary for a Cue-enabled session */
export interface CueSessionStatus {
	sessionId: string;
	sessionName: string;
	toolType: string;
	projectRoot: string;
	enabled: boolean;
	subscriptionCount: number;
	activeRuns: number;
	lastTriggered?: string;
	nextTrigger?: string;
}

/** Data passed with an agent completion notification for chaining */
export interface AgentCompletionData {
	sessionName?: string;
	status?: CueRunStatus;
	exitCode?: number | null;
	durationMs?: number;
	stdout?: string;
	triggeredBy?: string;
}

/** Session data with subscriptions for the Cue Graph visualization */
export interface CueGraphSession {
	sessionId: string;
	sessionName: string;
	toolType: string;
	subscriptions: CueSubscription[];
}

/** Default filename for Cue configuration */
export const CUE_YAML_FILENAME = 'maestro-cue.yaml';

/**
 * @deprecated Import CUE_CONFIG_PATH from shared/maestro-paths instead.
 * Kept for backwards compat references that check legacy location.
 */
export const LEGACY_CUE_YAML_FILENAME = CUE_YAML_FILENAME;
