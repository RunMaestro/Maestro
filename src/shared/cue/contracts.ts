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

/** What a subscription does when it fires. */
export type CueAction = 'prompt' | 'command';

/** Sub-mode of a `command` action. */
export type CueCommandMode = 'shell' | 'cli';

/**
 * A maestro-cli sub-command. Currently only `send` is supported, but the
 * shape leaves room for future sub-commands.
 */
export interface CueCommandCliCall {
	command: 'send';
	/** Session ID (or template variable) to send the message to. */
	target: string;
	/** Message body. Defaults to `{{CUE_SOURCE_OUTPUT}}` when omitted. */
	message?: string;
}

/**
 * A `command` action — either an arbitrary shell command (PATH-aware, runs in
 * the owning session's project root) or a structured maestro-cli call.
 */
export type CueCommand = { mode: 'shell'; shell: string } | { mode: 'cli'; cli: CueCommandCliCall };

/**
 * A Cue subscription defines a trigger-action pairing.
 *
 * `action` defaults to `'prompt'` (run an AI agent with the substituted
 * `prompt`). When `action` is `'command'`, the subscription instead spawns a
 * shell command or invokes maestro-cli — see {@link CueCommand}.
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
	/** Action type — defaults to `'prompt'` when omitted. */
	action?: CueAction;
	/** Required when `action === 'command'`. */
	command?: CueCommand;
	interval_minutes?: number;
	schedule_times?: string[];
	schedule_days?: CueScheduleDay[];
	watch?: string;
	source_session?: string | string[];
	/** Stable session ID(s) for chain subscriptions (event === 'agent.completed').
	 *  Dual-written alongside `source_session` (session names) for backward
	 *  compatibility. On load, IDs are preferred; names are consulted only
	 *  when IDs are absent OR reference a deleted session. Using stable IDs
	 *  protects chain edges from breaking when an upstream agent is renamed. */
	source_session_ids?: string | string[];
	/** Subscription name(s) whose completion should fire this chain. Narrows
	 *  `source_session` matching by `event.payload.triggeredBy` so a chain sub
	 *  fires ONLY on completions produced by the listed upstream subs.
	 *
	 *  Why: `source_session` alone matches any run in that session. When a
	 *  command node shares a session with its downstream agent (`Schedule →
	 *  Cmd1(owner S1) → Agent1(S1)`), both Cmd1's and Agent1's completions
	 *  emit `agent.completed` for S1 — without this filter the chain
	 *  self-triggers on Agent1's own completion, and downstream fan-in subs
	 *  cross-fire on Cmd1's completion before Agent1 has run.
	 *
	 *  When omitted, falls back to session-only matching (legacy behavior).
	 *  The pipeline-editor serializer sets this on every chain sub so the
	 *  runtime can distinguish "this agent's upstream completed" from
	 *  "something else in the same session completed." */
	source_sub?: string | string[];
	fan_out?: string[];
	/** Per-target prompts for a fan-out subscription, one string per entry in
	 *  `fan_out`. Legacy inline shape — kept for round-tripping YAML written
	 *  by older versions or edited by hand. New writes prefer
	 *  `fan_out_prompt_files` so each agent's prompt lives in its own `.md`
	 *  file, mirroring what the UI shows per-agent. The normalizer resolves
	 *  `fan_out_prompt_files` into this field at load time so the runtime
	 *  dispatch path keeps reading one authoritative place. */
	fan_out_prompts?: string[];
	/** External `.md` file paths for per-agent fan-out prompts, one entry
	 *  per `fan_out` target (positional). Takes precedence over
	 *  `fan_out_prompts` on read: the normalizer resolves each file into the
	 *  corresponding `fan_out_prompts[i]` slot. Emitted by the editor when
	 *  fan-out targets have different prompts so each agent's prompt lives
	 *  in its own file instead of bloating the YAML. */
	fan_out_prompt_files?: string[];
	filter?: Record<string, string | number | boolean>;
	repo?: string;
	poll_minutes?: number;
	gh_state?: CueGitHubState;
	agent_id?: string;
	label?: string;
	fan_in_timeout_minutes?: number;
	fan_in_timeout_on_fail?: 'break' | 'continue';
	/** Subset of `source_session` whose output to include in {{CUE_SOURCE_OUTPUT}}.
	 *  When omitted, all sources' outputs are included (backward-compatible default).
	 *  Set by the pipeline editor for "passthrough" edges where the source must
	 *  complete before the target fires but its output should NOT be injected. */
	include_output_from?: string[];
	/** Sources whose output should be forwarded through this agent to downstream
	 *  agents. The output is attached to this agent's completion event payload so
	 *  agents later in the chain can access it via per-source template variables
	 *  like {{CUE_OUTPUT_<NAME>}}. */
	forward_output_from?: string[];
	/**
	 * @deprecated Replaced by a downstream `action: command` subscription with
	 * `command: { mode: 'cli', cli: { command: 'send', target } }`. The
	 * normalizer migrates legacy YAML automatically; new code should not write
	 * this field.
	 */
	cli_output?: {
		target: string;
	};
	/** Hex color of the visual pipeline this subscription belongs to
	 *  (e.g. `#06b6d4`). All subscriptions in the same pipeline share this
	 *  value. When absent on load, the renderer falls back to palette-order
	 *  derivation; the next save re-stamps a value. Persisting this in YAML
	 *  keeps colors stable across Dashboard tab switches, modal reopens, and
	 *  app restarts. Must be a 7-character hex string (`#RRGGBB`). */
	pipeline_color?: string;
	/** Name of the visual pipeline this subscription belongs to.
	 *  Authoritative for grouping subscriptions into pipelines on load.
	 *  All subscriptions in one pipeline share the same value. Decouples
	 *  pipeline membership from the subscription-name convention
	 *  (`<name>`, `<name>-chain-N`), so editing a single subscription's
	 *  `name` no longer splits a pipeline or loses its chain links. When
	 *  absent on load (legacy YAML), the loader falls back to parsing the
	 *  `-chain-N` suffix off subscription names. */
	pipeline_name?: string;
}

/** Global Cue settings */
export interface CueSettings {
	timeout_minutes: number;
	timeout_on_fail: 'break' | 'continue';
	max_concurrent: number;
	queue_size: number;
	/**
	 * When multiple agents share the same projectRoot, the config is otherwise
	 * loaded N times (once per agent) and every trigger fires N times. Setting
	 * `owner_agent_id` pins execution to a single agent. Accepts either the
	 * agent's internal session id (UUID) or its display name.
	 *
	 * When unset and multiple agents share a projectRoot, the first agent in
	 * the session list wins (deterministic per launch).
	 */
	owner_agent_id?: string;
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
	/**
	 * When true, a local cue.yaml with `subscriptions: []` will NOT walk to
	 * an ancestor cue.yaml looking for shared pipelines. Lets a sub-project
	 * deliberately opt out of inherited pipelines without having to delete
	 * the file. Defaults to false (legacy fallback behaviour).
	 */
	no_ancestor_fallback?: boolean;
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
	/** Populated when this session's unowned subscriptions are suppressed because
	 *  ownership of its cue.yaml is contested (multiple agents in the same
	 *  projectRoot) or unresolvable (owner_agent_id matches no agent). The
	 *  dashboard renders a red indicator with this text as the tooltip. */
	ownershipWarning?: string;
}

/** Session data with subscriptions for the Cue graph visualization */
export interface CueGraphSession {
	sessionId: string;
	sessionName: string;
	toolType: string;
	subscriptions: CueSubscription[];
}
