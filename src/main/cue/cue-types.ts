/**
 * Core type definitions for the Maestro Cue event-driven automation system.
 *
 * Cue triggers agent prompts in response to events:
 * - time.interval: periodic timer-based triggers
 * - file.changed: file system change triggers
 * - agent.completed: triggers when another agent finishes
 */

/** Event types that can trigger a Cue subscription */
export type CueEventType = 'time.interval' | 'file.changed' | 'agent.completed';

/** A Cue subscription defines a trigger-prompt pairing */
export interface CueSubscription {
	name: string;
	event: CueEventType;
	enabled: boolean;
	prompt: string;
	interval_minutes?: number;
	watch?: string;
	source_session?: string | string[];
	fan_out?: string[];
}

/** Global Cue settings */
export interface CueSettings {
	timeout_minutes: number;
	timeout_on_fail: 'break' | 'continue';
}

/** Default Cue settings */
export const DEFAULT_CUE_SETTINGS: CueSettings = {
	timeout_minutes: 30,
	timeout_on_fail: 'break',
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
	enabled: boolean;
	subscriptionCount: number;
	activeRuns: number;
	lastTriggered?: string;
	nextTrigger?: string;
}

/** Default filename for Cue configuration */
export const CUE_YAML_FILENAME = 'maestro-cue.yaml';
