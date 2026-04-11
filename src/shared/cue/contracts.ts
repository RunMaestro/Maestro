/**
 * Shared Cue contracts used across main, preload, and renderer.
 *
 * Keep these types runtime-agnostic and free of Node/Electron dependencies.
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
	| 'app.startup'
	| 'time.heartbeat'
	| 'time.scheduled'
	| 'file.changed'
	| 'agent.completed'
	| 'github.pull_request'
	| 'github.issue'
	| 'task.pending'
	| 'cli.trigger';

/** All valid event type values */
export const CUE_EVENT_TYPES: CueEventType[] = [
	'app.startup',
	'time.heartbeat',
	'time.scheduled',
	'file.changed',
	'agent.completed',
	'github.pull_request',
	'github.issue',
	'task.pending',
	'cli.trigger',
];

/** Valid GitHub state filters for polling triggers */
export type CueGitHubState = 'open' | 'closed' | 'merged' | 'all';

/** All valid GitHub state values */
export const CUE_GITHUB_STATES: CueGitHubState[] = ['open', 'closed', 'merged', 'all'];

/**
 * A Cue subscription defines a trigger-prompt pairing.
 *
 * Note: prompt content is always materialized at config-load time. The raw YAML
 * `prompt_file` / `output_prompt_file` fields are resolved by the normalizer and
 * are NOT part of the runtime contract. See `CueSubscriptionDocument` in the
 * config normalizer if you need to know whether the prompt came from a file.
 */
export interface CueSubscription {
	name: string;
	event: CueEventType;
	enabled: boolean;
	prompt: string;
	output_prompt?: string;
	interval_minutes?: number;
	schedule_times?: string[];
	schedule_days?: CueScheduleDay[];
	watch?: string;
	source_session?: string | string[];
	fan_out?: string[];
	fan_out_prompts?: string[];
	filter?: Record<string, string | number | boolean>;
	repo?: string;
	poll_minutes?: number;
	gh_state?: CueGitHubState;
	agent_id?: string;
	label?: string;
	fan_in_timeout_minutes?: number;
	fan_in_timeout_on_fail?: 'break' | 'continue';
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

/** Top-level Cue configuration */
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

/** Session data with subscriptions for the Cue graph visualization */
export interface CueGraphSession {
	sessionId: string;
	sessionName: string;
	toolType: string;
	subscriptions: CueSubscription[];
}
