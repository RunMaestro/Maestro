/**
 * Type definitions for the visual pipeline editor.
 *
 * Pipelines are named chains: trigger -> agent1 -> agent2 -> ...
 * with fan-out/fan-in support. Each pipeline has a unique color
 * for visual differentiation on the React Flow canvas.
 */

import type {
	CueCommand,
	CueCommandMode,
	CueEventType,
	CueGraphSession as SharedCueGraphSession,
} from './cue';
export type { CueCommand, CueCommandMode, CueEventType } from './cue';

/** Cue brand color — single source of truth for all Cue UI */
export const CUE_COLOR = '#06b6d4';

/**
 * Accent color used for command nodes in the pipeline canvas. Distinct from
 * the per-pipeline palette so commands read as "infrastructure" alongside
 * agents, which carry their pipeline color.
 */
export const COMMAND_NODE_COLOR = '#64748b';

/** 12 visually distinct colors suitable for dark backgrounds */
export const PIPELINE_COLORS: string[] = [
	'#06b6d4', // cyan
	'#8b5cf6', // violet
	'#f59e0b', // amber
	'#ef4444', // red
	'#22c55e', // green
	'#ec4899', // pink
	'#3b82f6', // blue
	'#f97316', // orange
	'#14b8a6', // teal
	'#a855f7', // purple
	'#eab308', // yellow
	'#6366f1', // indigo
];

export type EdgeMode = 'pass' | 'debate' | 'autorun';

interface DebateConfig {
	maxRounds: number;
	timeoutPerRound: number;
}

interface PipelineNodePosition {
	x: number;
	y: number;
}

export interface TriggerNodeData {
	eventType: CueEventType;
	label: string;
	/** User-defined label overriding the default event-type label (e.g. "Morning Check") */
	customLabel?: string;
	config: {
		interval_minutes?: number;
		schedule_times?: string[];
		schedule_days?: string[];
		watch?: string;
		repo?: string;
		poll_minutes?: number;
		filter?: Record<string, string | number | boolean>;
	};
	/** Name of the underlying Cue subscription this trigger represents on disk.
	 *  Populated on load by `yamlToPipeline`. Every trigger node in a multi-
	 *  trigger pipeline maps to a distinct subscription — the first keeps the
	 *  pipeline name (e.g. "Pipeline 1"), subsequent triggers carry the
	 *  `-chain-N` suffix (e.g. "Pipeline 1-chain-2"). The trigger's Play
	 *  button uses this field to fire the correct subscription; without it,
	 *  all Play buttons would fire the first sub only. Undefined for
	 *  never-saved pipelines — the Play button is hidden until save. */
	subscriptionName?: string;
}

export interface AgentNodeData {
	sessionId: string;
	sessionName: string;
	toolType: string;
	inputPrompt?: string;
	outputPrompt?: string;
	/** Whether to auto-include {{CUE_SOURCE_OUTPUT}} in generated chain prompts. Default: true. */
	includeUpstreamOutput?: boolean;
	/** Per-node fan-in timeout override (minutes). Used when this agent has multiple incoming agent edges. */
	fanInTimeoutMinutes?: number;
	/** Per-node fan-in timeout-on-fail override. 'break' waits for all, 'continue' fires with partial data. */
	fanInTimeoutOnFail?: 'break' | 'continue';
	/** Stable per-instance identifier (UUID), generated when the node is
	 *  created in the editor. Persisted in YAML via `target_node_key` /
	 *  `fan_out_node_keys` on the owning subscription so two visual nodes
	 *  pointing at the same agent session round-trip as separate nodes
	 *  instead of being merged by sessionName. Same key across multiple
	 *  incoming edges = explicit fan-in (single visual node, multi-input). */
	nodeKey?: string;
}

/**
 * A command node represents a `action: command` subscription. It runs either
 * an arbitrary shell command (`mode: 'shell'`) in the owning session's project
 * root, or a structured maestro-cli call (`mode: 'cli'`) such as `send`.
 */
export interface CommandNodeData {
	/** Subscription name (unique within the project's cue.yaml). */
	name: string;
	/** Selected sub-mode of the unified command node. */
	mode: CueCommandMode;
	/** Shell command (used when `mode === 'shell'`). */
	shell?: string;
	/** maestro-cli sub-command name. Only `'send'` is supported today. */
	cliCommand?: 'send';
	/** maestro-cli send target session ID (used when `mode === 'cli'`). */
	cliTarget?: string;
	/** Optional message override for `mode === 'cli'`. Defaults to {{CUE_SOURCE_OUTPUT}} when blank. */
	cliMessage?: string;
	/** Owning session that provides cwd/project root + agent_id binding. */
	owningSessionId: string;
	/** Cached owning session name for display. */
	owningSessionName: string;
	/** Stable per-instance identifier (UUID). See `AgentNodeData.nodeKey`
	 *  for the round-trip semantics — the same `target_node_key` field on
	 *  the subscription carries this value to/from YAML. */
	nodeKey?: string;
}

/**
 * Data for an "error" node rendered in place of an unresolved agent. The
 * loader emits these when a chain/target session reference in the YAML
 * cannot be matched to any live session — `agent_id` points to a deleted
 * session, `source_session_ids` misses, and name-based fallback also
 * misses. Showing a visible error beats silently picking a wrong agent
 * (which is how the "two agents swapped" bug manifested). Save is blocked
 * while any error node is present in a pipeline.
 */
export interface ErrorNodeData {
	reason: 'missing-target' | 'missing-source';
	/** The subscription (or chain sub) that produced the unresolved reference. */
	subscriptionName: string;
	/** The stable ID from YAML that failed to resolve (may be undefined when
	 *  YAML only had a legacy name). */
	unresolvedId?: string;
	/** The legacy session name from YAML that also failed to resolve. */
	unresolvedName?: string;
	/** Short human-readable description shown on the node. */
	message: string;
}

export type PipelineNodeType = 'trigger' | 'agent' | 'command' | 'error';

export interface PipelineNode {
	id: string;
	type: PipelineNodeType;
	position: PipelineNodePosition;
	data: TriggerNodeData | AgentNodeData | CommandNodeData | ErrorNodeData;
}

/** Convert a CommandNodeData to the wire-format CueCommand object. */
export function commandNodeDataToCueCommand(data: CommandNodeData): CueCommand | undefined {
	if (data.mode === 'shell') {
		return data.shell ? { mode: 'shell', shell: data.shell } : undefined;
	}
	if (data.cliTarget) {
		return {
			mode: 'cli',
			cli: {
				command: 'send',
				target: data.cliTarget,
				message: data.cliMessage || undefined,
			},
		};
	}
	return undefined;
}

/** Build CommandNodeData from a wire-format CueCommand (for deserialization). */
export function cueCommandToCommandNodeFields(
	cmd: CueCommand
): Pick<CommandNodeData, 'mode' | 'shell' | 'cliCommand' | 'cliTarget' | 'cliMessage'> {
	if (cmd.mode === 'shell') {
		return { mode: 'shell', shell: cmd.shell };
	}
	return {
		mode: 'cli',
		cliCommand: cmd.cli.command,
		cliTarget: cmd.cli.target,
		cliMessage: cmd.cli.message,
	};
}

export interface PipelineEdge {
	id: string;
	source: string;
	target: string;
	mode: EdgeMode;
	debateConfig?: DebateConfig;
	/** Per-edge input prompt (used when multiple triggers feed the same agent with different prompts) */
	prompt?: string;
	/** Per-edge override: whether this source agent's output is included in
	 *  {{CUE_SOURCE_OUTPUT}} (and its per-source variable) for the target agent.
	 *  When undefined, falls back to the target agent's `includeUpstreamOutput`.
	 *  Set to `false` if this source's output should not appear in the prompt. */
	includeUpstreamOutput?: boolean;
	/** Whether this source's output should be forwarded through this agent to
	 *  downstream agents. When true, the output is attached to this agent's
	 *  completion event so agents later in the chain can still access it via
	 *  per-source template variables. Default: false. */
	forwardOutput?: boolean;
}

/** Info about an incoming agent→agent edge, used by the config panel to render
 *  per-source upstream-output toggles. */
export interface IncomingAgentEdgeInfo {
	edgeId: string;
	sourceNodeId: string;
	sourceSessionName: string;
	includeUpstreamOutput: boolean;
	forwardOutput: boolean;
}

/**
 * Sanitize an agent session name into a valid template-variable suffix.
 * Used by both the backend enricher and the pipeline editor UI to derive
 * consistent variable names like `CUE_OUTPUT_AGENT_A`.
 *
 * "Agent A" → "AGENT_A", "my-agent.1" → "MY_AGENT_1", "   " → "UNNAMED"
 */
export function sanitizeVarName(name: string): string {
	const sanitized = name
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
	return sanitized || 'UNNAMED';
}

export interface CuePipeline {
	id: string;
	name: string;
	color: string;
	nodes: PipelineNode[];
	edges: PipelineEdge[];
}

export interface CuePipelineState {
	pipelines: CuePipeline[];
	selectedPipelineId: string | null;
}

interface PipelineViewport {
	x: number;
	y: number;
	zoom: number;
}

/**
 * Per-project view state. Each entry stores the selected pipeline and
 * viewport for one project root, so switching between projects restores the
 * user's prior focus instead of sharing a global selection that no longer
 * matches. Node positions live on the pipelines themselves (not here) and
 * are already project-scoped because each pipeline is owned by one project.
 */
export interface PipelineProjectViewState {
	selectedPipelineId: string | null;
	viewport?: PipelineViewport;
}

/**
 * The `__default__` key is used when no active project root is available
 * (e.g. no sessions configured yet) so the editor still has somewhere to
 * persist viewport/selection before the user picks a project.
 */
export const PIPELINE_LAYOUT_DEFAULT_PROJECT_KEY = '__default__';

export interface PipelineLayoutState {
	/**
	 * Schema version. Legacy files (v1) have no version field — the loader
	 * translates them into v2 on first read. Bump this only on breaking
	 * changes to the shape; additive changes should stay at 2 with optional
	 * fields so older clients keep loading.
	 */
	version?: 2;
	pipelines: CuePipeline[];
	/**
	 * @deprecated v1 field kept for backward-compatible reads. New writes
	 * use `perProject` keyed by project root. Readers should treat this as
	 * a fallback for the default project key only.
	 */
	selectedPipelineId: string | null;
	/**
	 * @deprecated v1 field kept for backward-compatible reads. Same
	 * fallback semantics as `selectedPipelineId`.
	 */
	viewport?: PipelineViewport;
	/**
	 * Per-project-root view state. When present, overrides the top-level
	 * `selectedPipelineId` / `viewport` for any project key that has an
	 * entry. Projects without an entry fall back to the v1 fields.
	 */
	perProject?: Record<string, PipelineProjectViewState>;
	/**
	 * Set of project roots that the most recent successful save wrote to.
	 * Persisted alongside the layout so we can re-seed lastWrittenRootsRef on
	 * editor mount even when an agent that previously wrote to a root has been
	 * renamed or removed since (in which case sessionId/sessionName lookup
	 * would otherwise miss the root and a future "delete the orphaned pipeline"
	 * save would leave a stale YAML at that root).
	 */
	writtenRoots?: string[];
}

/** Session data with subscriptions for the Cue graph/pipeline visualization */
export type CueGraphSession = SharedCueGraphSession;

/** Returns the first unused color from the palette, cycling if all used. */
export function getNextPipelineColor(existingPipelines: CuePipeline[]): string {
	const usedColors = new Set(existingPipelines.map((p) => p.color));
	for (const color of PIPELINE_COLORS) {
		if (!usedColors.has(color)) {
			return color;
		}
	}
	return PIPELINE_COLORS[existingPipelines.length % PIPELINE_COLORS.length];
}

// ─── Shared pipeline-editor types ────────────────────────────────────────────

/** Lightweight session descriptor used by the pipeline editor (avoids importing full Session). */
export interface CuePipelineSessionInfo {
	id: string;
	groupId?: string;
	name: string;
	toolType: string;
	projectRoot?: string;
}

/** Info about an incoming trigger edge for per-edge prompt editing. */
export interface IncomingTriggerEdgeInfo {
	edgeId: string;
	triggerLabel: string;
	configSummary: string;
	prompt: string;
}
