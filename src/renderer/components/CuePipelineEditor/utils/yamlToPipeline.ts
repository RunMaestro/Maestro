/**
 * Converts existing YAML/subscriptions back into visual pipeline graph state.
 *
 * Reverses the pipelineToYaml conversion: groups subscriptions by pipeline name,
 * reconstructs trigger/agent nodes and edges, and auto-layouts the graph.
 */

import type {
	CuePipeline,
	PipelineNode,
	PipelineEdge,
	TriggerNodeData,
	AgentNodeData,
	CliOutputNodeData,
	CueEventType,
	EdgeMode,
	ErrorNodeData,
} from '../../../../shared/cue-pipeline-types';
import { getNextPipelineColor } from '../../../../shared/cue-pipeline-types';
import type { CueSubscription } from '../../../../shared/cue';

/** Minimal graph session input - compatible with both local and cue-types CueGraphSession */
interface GraphSessionInput {
	sessionId: string;
	sessionName: string;
	toolType: string;
	subscriptions: Array<{
		name: string;
		event: string;
		enabled: boolean;
		prompt?: string;
		output_prompt?: string;
		interval_minutes?: number;
		schedule_times?: string[];
		schedule_days?: string[];
		watch?: string;
		source_session?: string | string[];
		fan_out?: string[];
		fan_out_prompts?: string[];
		filter?: Record<string, string | number | boolean>;
		repo?: string;
		poll_minutes?: number;
		agent_id?: string;
		label?: string;
		fan_in_timeout_minutes?: number;
		fan_in_timeout_on_fail?: 'break' | 'continue';
		include_output_from?: string[];
		forward_output_from?: string[];
		cli_output?: { target: string };
	}>;
}

/** Minimal session info needed for pipeline reconstruction */
interface PipelineSessionInfo {
	id: string;
	name: string;
	toolType: string;
}

/** Layout constants for auto-positioning nodes */
const LAYOUT = {
	triggerX: 100,
	firstAgentX: 400,
	stepSpacing: 300,
	verticalSpacing: 150,
	baseY: 200,
} as const;

/**
 * Extracts the base pipeline name by stripping `-chain-N` and `-fanin` suffixes.
 */
function getBasePipelineName(subscriptionName: string): string {
	return subscriptionName.replace(/-chain-\d+$/, '').replace(/-fanin$/, '');
}

/**
 * Returns the pipeline grouping key for a subscription — the explicit
 * `pipeline_name` field when present, otherwise the legacy base-name
 * derived from the subscription-name suffix convention.
 */
function getPipelineKey(sub: CueSubscription): string {
	if (typeof sub.pipeline_name === 'string' && sub.pipeline_name.length > 0) {
		return sub.pipeline_name;
	}
	return getBasePipelineName(sub.name);
}

/**
 * Groups subscriptions by their owning pipeline, using the explicit
 * `pipeline_name` field when present and falling back to stripping the
 * subscription-name suffix convention (`-chain-N`, `-fanin`) for legacy
 * YAML. Explicit `pipeline_name` makes editing a single subscription's
 * `name` safe — it no longer splits the pipeline or orphans its chains.
 *
 * Maintains insertion order within each group.
 */
function groupSubscriptionsByPipeline(
	subscriptions: CueSubscription[]
): Map<string, CueSubscription[]> {
	const groups = new Map<string, CueSubscription[]>();

	for (const sub of subscriptions) {
		const key = getPipelineKey(sub);
		const group = groups.get(key) ?? [];
		group.push(sub);
		groups.set(key, group);
	}

	return groups;
}

/**
 * Determines if a subscription is the initial trigger (not an agent.completed chain link).
 */
/**
 * Creates an error-type PipelineNode that renders as a visible unresolved
 * placeholder on the canvas. See ErrorNode.tsx for the rendered component
 * and cue-pipeline-types for the data shape.
 */
function createErrorNode(
	nodeId: string,
	data: ErrorNodeData,
	position: { x: number; y: number }
): PipelineNode {
	return {
		id: nodeId,
		type: 'error',
		position,
		data,
	};
}

/**
 * One resolved chain-source position. A position is either `resolved`
 * (maps to an existing session) or `unresolved` (no ID match, no name
 * match — the upstream agent was deleted and must be surfaced as an
 * error node rather than silently dropped).
 */
interface ResolvedChainSource {
	kind: 'resolved' | 'unresolved';
	/** Session name when resolved. */
	sessionName?: string;
	/** The stable ID from YAML when resolution was attempted by ID. */
	unresolvedId?: string;
	/** The legacy name from YAML when resolution was attempted by name. */
	unresolvedName?: string;
}

/**
 * Resolves chain-source positions with ID-first precedence and surfaces
 * unresolved positions as explicit `unresolved` entries. This is what
 * lets the loader emit an error node instead of silently falling back to
 * the wrong agent (the "two agents swapped" bug vector).
 */
function resolveChainSourcePositions(
	sub: CueSubscription,
	sessions: PipelineSessionInfo[]
): ResolvedChainSource[] {
	const ids = Array.isArray(sub.source_session_ids)
		? sub.source_session_ids
		: sub.source_session_ids
			? [sub.source_session_ids]
			: [];
	const names = Array.isArray(sub.source_session)
		? sub.source_session
		: sub.source_session
			? [sub.source_session]
			: [];

	const positions = Math.max(ids.length, names.length);
	const resolved: ResolvedChainSource[] = [];
	for (let i = 0; i < positions; i++) {
		const id = ids[i];
		const legacyName = names[i];
		const hasId = typeof id === 'string' && id.length > 0;
		const hasName = typeof legacyName === 'string' && legacyName.length > 0;

		// When an ID was written, it is authoritative. If the ID doesn't match
		// any live session we MUST surface the position as unresolved and never
		// fall through to name-based resolution — that would be the "silent
		// identity swap" failure mode. Example: agent `uuid-A "Deploy"` deleted,
		// a NEW agent `uuid-B "Deploy"` recreated with the same visible name.
		// Name-match would happily rewire the chain to the new agent, hiding
		// the fact that the user's original reference is gone.
		if (hasId) {
			const matched = sessions.find((s) => s.id === id);
			if (matched) {
				resolved.push({ kind: 'resolved', sessionName: matched.name });
				continue;
			}
			resolved.push({
				kind: 'unresolved',
				unresolvedId: id,
				unresolvedName: hasName ? legacyName : undefined,
			});
			continue;
		}
		if (hasName) {
			const matchedByName = sessions.find((s) => s.name === legacyName);
			if (matchedByName) {
				resolved.push({ kind: 'resolved', sessionName: matchedByName.name });
				continue;
			}
			// Legacy YAML with name only and no matching live session: emit
			// the name so the downstream code creates a placeholder agent
			// node. This is backwards compat for pre-source_session_ids YAML
			// — without an ID we have no stable way to distinguish "stale
			// name" from "the agent still named this". Placeholder renders
			// as a normal agent node; the user sees the name and can fix it.
			resolved.push({ kind: 'resolved', sessionName: legacyName });
			continue;
		}
		// Neither ID nor name present → hard unresolved.
		resolved.push({
			kind: 'unresolved',
			unresolvedId: id,
			unresolvedName: legacyName,
		});
	}
	return resolved;
}

/**
 * Extracts the first valid hex color (`#RRGGBB`) from a pipeline's
 * subscriptions' `pipeline_color` fields. Returns `undefined` when no
 * subscription carries a valid color so callers can fall back to
 * palette-order derivation. Malformed values (non-hex strings, wrong
 * length) are ignored so a typo in the YAML never corrupts the palette.
 */
function firstValidPipelineColor(subs: CueSubscription[]): string | undefined {
	const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
	for (const sub of subs) {
		const candidate = sub.pipeline_color;
		if (typeof candidate === 'string' && HEX_COLOR.test(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function isInitialTrigger(sub: CueSubscription): boolean {
	if (sub.event !== 'agent.completed') return true;

	// agent.completed subscriptions without a source_session from the naming convention
	// are still initial triggers if they're the first in their group
	return false;
}

/**
 * Maps a CueSubscription's event type to trigger node config fields.
 */
function extractTriggerConfig(sub: CueSubscription): TriggerNodeData['config'] {
	const config: TriggerNodeData['config'] = {};

	switch (sub.event as CueEventType) {
		case 'time.heartbeat':
			if (sub.interval_minutes != null) config.interval_minutes = sub.interval_minutes;
			break;
		case 'time.scheduled':
			if (sub.schedule_times != null) config.schedule_times = sub.schedule_times;
			if (sub.schedule_days != null) config.schedule_days = sub.schedule_days as string[];
			break;
		case 'file.changed':
			if (sub.watch != null) config.watch = sub.watch;
			if (sub.filter != null) config.filter = sub.filter;
			break;
		case 'github.pull_request':
		case 'github.issue':
			if (sub.repo != null) config.repo = sub.repo;
			if (sub.poll_minutes != null) config.poll_minutes = sub.poll_minutes;
			break;
		case 'task.pending':
			if (sub.watch != null) config.watch = sub.watch;
			break;
	}

	return config;
}

/**
 * Generates a human-readable label for a trigger event type.
 */
function triggerLabel(eventType: CueEventType): string {
	switch (eventType) {
		case 'time.heartbeat':
			return 'Heartbeat';
		case 'time.scheduled':
			return 'Scheduled';
		case 'file.changed':
			return 'File Change';
		case 'github.pull_request':
			return 'Pull Request';
		case 'github.issue':
			return 'Issue';
		case 'task.pending':
			return 'Task Pending';
		case 'agent.completed':
			return 'Agent Done';
		case 'cli.trigger':
			return 'CLI Trigger';
		default:
			return 'Trigger';
	}
}

/**
 * Finds or creates an agent node, deduplicating by session name.
 *
 * When `forceNew` is true, always creates a fresh node even if one already
 * exists for this session — needed for chains where the same agent appears
 * at multiple positions (e.g. A → B → A).
 */
function getOrCreateAgentNode(
	sessionName: string,
	sessions: PipelineSessionInfo[],
	nodeMap: Map<string, PipelineNode>,
	position: { x: number; y: number },
	forceNew?: boolean
): PipelineNode {
	// Check if we already have a node for this session
	if (!forceNew) {
		for (const [, node] of nodeMap) {
			if (node.type === 'agent' && (node.data as AgentNodeData).sessionName === sessionName) {
				return node;
			}
		}
	}

	const session = sessions.find((s) => s.name === sessionName);
	const nodeId = `agent-${sessionName}-${nodeMap.size}`;

	const node: PipelineNode = {
		id: nodeId,
		type: 'agent',
		position,
		data: {
			sessionId: session?.id ?? sessionName,
			sessionName,
			toolType: session?.toolType ?? 'claude-code',
		} as AgentNodeData,
	};

	nodeMap.set(nodeId, node);
	return node;
}

/**
 * Converts CueSubscription objects back into visual CuePipeline structures.
 *
 * Groups subscriptions by name prefix, reconstructs trigger and agent nodes,
 * creates edges for chains/fan-out/fan-in, and auto-layouts the graph.
 */
export function subscriptionsToPipelines(
	subscriptions: CueSubscription[],
	sessions: PipelineSessionInfo[]
): CuePipeline[] {
	const groups = groupSubscriptionsByPipeline(subscriptions);
	const pipelines: CuePipeline[] = [];

	for (const [baseName, subs] of groups) {
		const nodeMap = new Map<string, PipelineNode>();
		const edges: PipelineEdge[] = [];

		// Sort deterministically so the reconstructed graph doesn't depend on
		// YAML write order:
		//   1. Initial triggers first (so agents exist before their chain
		//      consumers try to reference them).
		//   2. Within chain subs, sort by chain index (matches the pipeline's
		//      natural left-to-right flow).
		//   3. Break ties on subscription name for total determinism.
		// Without this, re-saving YAML in a different order used to visually
		// swap agents that shared a session name — the "two agents swapped"
		// bug vector that ID-based `sessionToNode` keying (below) also guards
		// against.
		// Fan-in subscriptions terminate a pipeline (they collect from many
		// upstream sources and converge on a single target). `pipelineToYaml`
		// emits fan-in subs with the `-chain-N` suffix, but legacy / hand-
		// written YAML may use the `-fanin` suffix convention instead. Under
		// that legacy convention, `getChainIndex` returns 0 for `-fanin` names
		// (no `-chain-N` suffix to parse), which would place them BEFORE
		// `-chain-1` in the sort — reversing the intended flow. Treat any
		// `-fanin` suffix as a very high chain index so fan-in always sorts
		// last among non-initial subs.
		const isLegacyFanIn = (name: string) => /-fanin$/.test(name);
		const sorted = [...subs].sort((a, b) => {
			const aInit = isInitialTrigger(a) ? 0 : 1;
			const bInit = isInitialTrigger(b) ? 0 : 1;
			if (aInit !== bInit) return aInit - bInit;
			const aIdx = isLegacyFanIn(a.name) ? Number.MAX_SAFE_INTEGER : getChainIndex(a.name);
			const bIdx = isLegacyFanIn(b.name) ? Number.MAX_SAFE_INTEGER : getChainIndex(b.name);
			if (aIdx !== bIdx) return aIdx - bIdx;
			return a.name.localeCompare(b.name);
		});

		let triggerCount = 0;
		let columnIndex = 0;
		// Track which column each session name appears in for layout
		const sessionColumn = new Map<string, number>();
		const sessionRow = new Map<string, number>();
		let edgeCount = 0;

		// Track the agent node for each session name for deduplication
		const sessionToNode = new Map<string, PipelineNode>();

		for (const sub of sorted) {
			if (isInitialTrigger(sub)) {
				// Create trigger node
				const triggerId = `trigger-${triggerCount}`;
				triggerCount++;

				const triggerNode: PipelineNode = {
					id: triggerId,
					type: 'trigger',
					position: {
						x: LAYOUT.triggerX,
						y: LAYOUT.baseY + (triggerCount - 1) * LAYOUT.verticalSpacing,
					},
					data: {
						eventType: sub.event as CueEventType,
						label: triggerLabel(sub.event as CueEventType),
						customLabel: sub.label || undefined,
						config: extractTriggerConfig(sub),
						// Bind this visual trigger node to its owning YAML
						// subscription so the Play button fires the right sub
						// in multi-trigger pipelines. Without this, every Play
						// button in the pipeline fired the first sub only (the
						// one named exactly `pipeline.name`), making chain
						// triggers — including GitHub PR/Issue polls — unreachable
						// from the UI.
						subscriptionName: sub.name,
					} as TriggerNodeData,
				};
				nodeMap.set(triggerId, triggerNode);
				columnIndex = 1;

				if (sub.fan_out && sub.fan_out.length > 0) {
					// Fan-out: trigger connects to multiple agents
					for (let i = 0; i < sub.fan_out.length; i++) {
						const sessionName = sub.fan_out[i];
						const pos = {
							x: LAYOUT.firstAgentX,
							y: LAYOUT.baseY + i * LAYOUT.verticalSpacing,
						};

						const agentNode = getOrCreateAgentNode(sessionName, sessions, nodeMap, pos);
						sessionToNode.set(sessionName, agentNode);
						sessionColumn.set(sessionName, 1);
						sessionRow.set(sessionName, i);

						// Apply per-agent prompt from fan_out_prompts, fallback to shared prompt
						const perAgentPrompt = sub.fan_out_prompts?.[i];
						const agentPrompt = perAgentPrompt ?? sub.prompt;
						if (agentPrompt) {
							(agentNode.data as AgentNodeData).inputPrompt = agentPrompt;
						}
						if (i === 0 && sub.output_prompt) {
							(agentNode.data as AgentNodeData).outputPrompt = sub.output_prompt;
						}

						// Store per-edge prompt when fan_out_prompts differ from shared prompt
						const edgePrompt =
							perAgentPrompt !== undefined && perAgentPrompt !== sub.prompt
								? perAgentPrompt
								: undefined;
						edges.push({
							id: `edge-${edgeCount++}`,
							source: triggerId,
							target: agentNode.id,
							mode: 'pass' as EdgeMode,
							...(edgePrompt ? { prompt: edgePrompt } : {}),
						});
					}
				} else {
					// Single target - infer target from subscription context.
					// If `agent_id` is explicitly set but points at a session
					// that no longer exists, surface it as an error node
					// rather than letting `findTargetSession`'s heuristic chain
					// pick a different agent (the silent-swap failure mode).
					const targetAgentIdMissing =
						typeof sub.agent_id === 'string' &&
						sub.agent_id.length > 0 &&
						!sessions.some((s) => s.id === sub.agent_id);
					const targetSessionName = targetAgentIdMissing
						? null
						: findTargetSession(sub, subs, sessions);

					const pos = {
						x: LAYOUT.firstAgentX,
						y: LAYOUT.baseY + (triggerCount - 1) * LAYOUT.verticalSpacing,
					};

					if (!targetSessionName) {
						const errorNodeId = `error-target-${sub.name}`;
						const errorNode = createErrorNode(
							errorNodeId,
							{
								reason: 'missing-target',
								subscriptionName: sub.name,
								unresolvedId: sub.agent_id,
								message: targetAgentIdMissing
									? `Target agent (id ${sub.agent_id}) no longer exists.`
									: 'Target agent for this trigger could not be resolved.',
							},
							pos
						);
						nodeMap.set(errorNodeId, errorNode);
						edges.push({
							id: `edge-${edgeCount++}`,
							source: triggerId,
							target: errorNodeId,
							mode: 'pass' as EdgeMode,
							prompt: sub.prompt || undefined,
						});
						continue;
					}

					const agentNode = getOrCreateAgentNode(targetSessionName, sessions, nodeMap, pos);
					const isReusedAgent = sessionToNode.has(targetSessionName);
					sessionToNode.set(targetSessionName, agentNode);
					sessionColumn.set(targetSessionName, 1);
					sessionRow.set(targetSessionName, triggerCount - 1);

					if (sub.output_prompt) {
						(agentNode.data as AgentNodeData).outputPrompt = sub.output_prompt;
					}

					// `edge.prompt` is the single source of truth for every
					// trigger→agent edge. Always emit the subscription's prompt
					// onto the edge so it survives the single→multi-trigger
					// transition without any fallback to `agentData.inputPrompt`
					// (which used to leak the first trigger's prompt onto every
					// subsequent trigger feeding the same agent).
					edges.push({
						id: `edge-${edgeCount++}`,
						source: triggerId,
						target: agentNode.id,
						mode: 'pass' as EdgeMode,
						prompt: sub.prompt || undefined,
					});

					if (!isReusedAgent) {
						// First incoming trigger — mirror the prompt onto the agent
						// node so AgentConfigPanel's single-trigger textarea shows
						// it. This node-level mirror is cleared below as soon as a
						// second trigger arrives, so it cannot leak.
						if (sub.prompt) {
							(agentNode.data as AgentNodeData).inputPrompt = sub.prompt;
						}
					} else {
						// Transition to multi-trigger: clear the node-level prompt.
						// Every incoming trigger's prompt is already on its edge.
						(agentNode.data as AgentNodeData).inputPrompt = undefined;
					}
				}
			} else {
				// Chain subscription (agent.completed): connect source to target.
				columnIndex++;
				const sourcePositions = resolveChainSourcePositions(sub, sessions);

				// Check whether the target `agent_id` explicitly points at a
				// session that no longer exists. If so, emit a target-side
				// error node below instead of falling through `findTargetSession`'s
				// heuristic chain (which could silently pick the wrong agent
				// and manifest as the "two agents swapped" bug).
				const targetAgentIdMissing =
					typeof sub.agent_id === 'string' &&
					sub.agent_id.length > 0 &&
					!sessions.some((s) => s.id === sub.agent_id);

				const targetSessionName = targetAgentIdMissing
					? null
					: findTargetSession(sub, subs, sessions);

				const targetCol = columnIndex;
				const existingRows = [...sessionColumn.entries()].filter(
					([, col]) => col === targetCol
				).length;

				const pos = {
					x: LAYOUT.firstAgentX + (targetCol - 1) * LAYOUT.stepSpacing,
					y: LAYOUT.baseY + existingRows * LAYOUT.verticalSpacing,
				};

				// Resolve source nodes BEFORE creating the target node (existing
				// ordering contract: source/target may share a name, so target
				// must not overwrite sessionToNode before sources are resolved).
				// For each source position, resolved → reuse/create agent node;
				// unresolved → create a visible error node so the user can see
				// which upstream is missing instead of getting a silent drop.
				const resolvedSources: PipelineNode[] = [];
				for (let i = 0; i < sourcePositions.length; i++) {
					const position = sourcePositions[i];
					if (position.kind === 'resolved' && position.sessionName) {
						const sourceNode =
							sessionToNode.get(position.sessionName) ??
							getOrCreateAgentNode(position.sessionName, sessions, nodeMap, {
								x: LAYOUT.firstAgentX,
								y: LAYOUT.baseY,
							});
						resolvedSources.push(sourceNode);
					} else {
						const errorNodeId = `error-source-${sub.name}-${i}`;
						const errorNode = createErrorNode(
							errorNodeId,
							{
								reason: 'missing-source',
								subscriptionName: sub.name,
								unresolvedId: position.unresolvedId,
								unresolvedName: position.unresolvedName,
								message: position.unresolvedName
									? `Upstream agent "${position.unresolvedName}" no longer exists.`
									: 'An upstream agent referenced by this chain no longer exists.',
							},
							{
								x: LAYOUT.firstAgentX + (targetCol - 2) * LAYOUT.stepSpacing,
								y: LAYOUT.baseY + (existingRows + i) * LAYOUT.verticalSpacing,
							}
						);
						nodeMap.set(errorNodeId, errorNode);
						resolvedSources.push(errorNode);
					}
				}

				// Target is unresolved → emit a target-side error node and continue.
				if (!targetSessionName) {
					const errorNodeId = `error-target-${sub.name}`;
					const errorNode = createErrorNode(
						errorNodeId,
						{
							reason: 'missing-target',
							subscriptionName: sub.name,
							unresolvedId: sub.agent_id,
							message: targetAgentIdMissing
								? `Target agent (id ${sub.agent_id}) no longer exists.`
								: 'Target agent for this chain could not be resolved.',
						},
						pos
					);
					nodeMap.set(errorNodeId, errorNode);
					for (const sourceNode of resolvedSources) {
						edges.push({
							id: `edge-${edgeCount++}`,
							source: sourceNode.id,
							target: errorNodeId,
							mode: 'pass' as EdgeMode,
						});
					}
					continue;
				}

				// Force a new node when this session already appeared earlier in the chain
				// (e.g. A → B → A). Reusing the earlier node would create a back-edge
				// instead of rendering the second occurrence as a distinct node.
				const alreadyInChain = sessionToNode.has(targetSessionName);
				const targetNode = getOrCreateAgentNode(
					targetSessionName,
					sessions,
					nodeMap,
					pos,
					alreadyInChain
				);
				sessionToNode.set(targetSessionName, targetNode);
				sessionColumn.set(targetSessionName, targetCol);
				sessionRow.set(targetSessionName, existingRows);

				if (sub.prompt) {
					// Strip auto-injected {{CUE_SOURCE_OUTPUT}} prefix to prevent accumulation on round-trip
					const AUTO_PREFIX = '{{CUE_SOURCE_OUTPUT}}\n\n';
					const BARE_TOKEN = '{{CUE_SOURCE_OUTPUT}}';
					let strippedPrompt = sub.prompt;
					if (strippedPrompt.startsWith(AUTO_PREFIX)) {
						strippedPrompt = strippedPrompt.slice(AUTO_PREFIX.length);
					} else if (strippedPrompt === BARE_TOKEN) {
						strippedPrompt = '';
					}
					(targetNode.data as AgentNodeData).inputPrompt = strippedPrompt || undefined;
				}
				if (sub.output_prompt) {
					(targetNode.data as AgentNodeData).outputPrompt = sub.output_prompt;
				}
				// Fan-in timeout settings
				if (typeof sub.fan_in_timeout_minutes === 'number') {
					(targetNode.data as AgentNodeData).fanInTimeoutMinutes = sub.fan_in_timeout_minutes;
				}
				if (sub.fan_in_timeout_on_fail === 'break' || sub.fan_in_timeout_on_fail === 'continue') {
					(targetNode.data as AgentNodeData).fanInTimeoutOnFail = sub.fan_in_timeout_on_fail;
				}

				// Create edges from pre-resolved source(s) to target.
				// If include_output_from is specified, mark edges whose source is
				// NOT in the list with includeUpstreamOutput=false.
				// If forward_output_from is specified, mark matching edges with
				// forwardOutput=true.
				const includeSet = sub.include_output_from ? new Set(sub.include_output_from) : null;
				const forwardSet = sub.forward_output_from ? new Set(sub.forward_output_from) : null;
				for (const sourceNode of resolvedSources) {
					const sourceName =
						sourceNode.type === 'agent' ? (sourceNode.data as AgentNodeData).sessionName : '';
					const edge: PipelineEdge = {
						id: `edge-${edgeCount++}`,
						source: sourceNode.id,
						target: targetNode.id,
						mode: 'pass' as EdgeMode,
					};
					// Only set the flag when there's an explicit include list and
					// this source isn't in it — absence of the flag means "include"
					// (backward-compatible default).
					if (includeSet && !includeSet.has(sourceName)) {
						edge.includeUpstreamOutput = false;
					}
					if (forwardSet && forwardSet.has(sourceName)) {
						edge.forwardOutput = true;
					}
					edges.push(edge);
				}
			}
		}

		// After all nodes and edges are created, add cli_output nodes for subscriptions
		// that have a cli_output field. Position them after the last agent in the chain.
		for (const sub of sorted) {
			if (sub.cli_output?.target) {
				// Find the agent node this cli_output belongs to
				const targetSessionName = findTargetSession(sub, subs, sessions);
				const agentNode = targetSessionName ? sessionToNode.get(targetSessionName) : undefined;
				if (agentNode) {
					const cliOutputId = `cli-output-${nodeMap.size}`;
					const cliOutputNode: PipelineNode = {
						id: cliOutputId,
						type: 'cli_output',
						position: {
							x: agentNode.position.x + LAYOUT.stepSpacing,
							y: agentNode.position.y,
						},
						data: {
							target: sub.cli_output.target,
						} as CliOutputNodeData,
					};
					nodeMap.set(cliOutputId, cliOutputNode);
					edges.push({
						id: `edge-${edgeCount++}`,
						source: agentNode.id,
						target: cliOutputId,
						mode: 'pass' as EdgeMode,
					});
				}
			}
		}

		const pipeline: CuePipeline = {
			id: `pipeline-${baseName}`,
			name: baseName,
			// Prefer a color persisted in YAML (pipeline_color on any
			// subscription). Fall back to palette-order derivation only when no
			// valid color is stored, which happens for legacy YAML or files
			// edited by hand.
			color: firstValidPipelineColor(subs) ?? getNextPipelineColor(pipelines),
			nodes: Array.from(nodeMap.values()),
			edges,
		};

		pipelines.push(pipeline);
	}

	return pipelines;
}

/**
 * Infers the target session name for a subscription.
 *
 * For chain subscriptions, looks at which session in the available sessions list
 * is referenced by subsequent chain links as a source_session.
 * Falls back to matching by name pattern or using the first available session.
 */
function findTargetSession(
	sub: CueSubscription,
	allSubs: CueSubscription[],
	sessions: PipelineSessionInfo[]
): string | null {
	// If the subscription has an explicit agent_id, trust it — the editor writes
	// agent_id whenever the user binds a subscription to a specific session, and
	// per-project-root YAML partitioning guarantees it is never a cross-session leak.
	if (sub.agent_id) {
		const session = sessions.find((s) => s.id === sub.agent_id);
		if (session) return session.name;
		// agent_id references a session that no longer exists — fall through
		// to owner / name-based resolution below.
	}

	// If the subscription was tagged with owning sessions from getGraphData(),
	// use that to resolve the target when unambiguous.
	const owners = (sub as CueSubscription & { _ownerSessions?: string[] })._ownerSessions;
	if (owners && owners.length === 1) {
		// Single owner — this is the definitive target session.
		return owners[0];
	}
	if (owners && owners.length > 1) {
		// Multiple owners (shared project root). For chain subs with source_session,
		// the target is the owner that is NOT the source.
		const sources = Array.isArray(sub.source_session)
			? sub.source_session
			: sub.source_session
				? [sub.source_session]
				: [];
		if (sources.length > 0) {
			const nonSource = owners.find((o) => !sources.includes(o));
			if (nonSource) return nonSource;
		}
		// For initial triggers with multiple owners, fall through to chain-based
		// resolution below which checks the next chain link's source_session.
	}

	// For chain subscriptions, the target is the session that the next chain link
	// references as source_session. Use the explicit pipeline_name when present
	// so user-edited subscription names don't break chain resolution.
	const pipelineKey = getPipelineKey(sub);
	const chainIndex = getChainIndex(sub.name);

	// Find the next chain link that has this subscription's target as its source
	for (const other of allSubs) {
		if (other === sub) continue;
		const otherKey = getPipelineKey(other);
		const otherIndex = getChainIndex(other.name);

		if (otherKey === pipelineKey && otherIndex === chainIndex + 1) {
			// Prefer `source_session_ids` when present — it's the stable
			// identity anchor that survives renames, and using the name
			// here would re-introduce the silent-swap failure mode that
			// `resolveChainSourcePositions` already protects against. Look
			// up the live session by id and return its CURRENT name so the
			// caller's "return session name" contract is preserved.
			const sourceIds = Array.isArray(other.source_session_ids)
				? other.source_session_ids
				: other.source_session_ids
					? [other.source_session_ids]
					: [];
			if (sourceIds.length > 0) {
				const matched = sessions.find((s) => s.id === sourceIds[0]);
				if (matched) return matched.name;
				// Stable id didn't resolve — fall through to legacy name
				// resolution rather than silently returning a possibly-
				// stale legacy name as if it matched.
			}

			const sources = Array.isArray(other.source_session)
				? other.source_session
				: other.source_session
					? [other.source_session]
					: [];

			if (sources.length > 0) {
				return sources[0];
			}
		}
	}

	// If this is the last in the chain, try to find a session matching the pattern
	// Look for a session whose name matches or could be the target
	if (sessions.length > 0) {
		// Check if any session name appears only in this subscription context
		const usedSessions = new Set<string>();
		for (const s of allSubs) {
			if (s.fan_out) {
				for (const name of s.fan_out) usedSessions.add(name);
			}
			const sources = Array.isArray(s.source_session)
				? s.source_session
				: s.source_session
					? [s.source_session]
					: [];
			for (const name of sources) usedSessions.add(name);
		}

		// Try matching subscription base name to a session name.
		// Pipeline names often reflect the target agent (e.g., "Pedsidian" → session "Pedsidian").
		const pipelineKey = getPipelineKey(sub);
		const nameMatch = sessions.find((s) => s.name === pipelineKey);
		if (nameMatch) return nameMatch.name;

		// For the initial subscription, try to find a session not already used as a source
		// This is a heuristic: the target session is typically the one the YAML belongs to
		for (const session of sessions) {
			if (!usedSessions.has(session.name)) {
				return session.name;
			}
		}

		// Fallback: use the first session
		return sessions[0].name;
	}

	// Last resort: generate a name from the pipeline key
	return `${getPipelineKey(sub)}-agent`;
}

/**
 * Extracts the chain index from a subscription name.
 * Returns 0 for the base name (no -chain- suffix).
 */
function getChainIndex(name: string): number {
	const match = name.match(/-chain-(\d+)$/);
	return match ? parseInt(match[1], 10) : 0;
}

/**
 * Convenience wrapper that extracts subscriptions from CueGraphSession data
 * and converts them into pipeline structures.
 */
export function graphSessionsToPipelines(
	graphSessions: GraphSessionInput[],
	allSessions: PipelineSessionInfo[]
): CuePipeline[] {
	// Collect all subscriptions across all graph sessions, deduplicating by name.
	// Multiple sessions sharing the same project root load the same cue.yaml,
	// so the same subscription can appear in multiple graph sessions.
	//
	// Build a map from subscription name → all graph session names that own it,
	// so pipeline reconstruction can correctly associate agents.
	const ownerMap = new Map<string, string[]>();
	for (const gs of graphSessions) {
		for (const sub of gs.subscriptions) {
			const owners = ownerMap.get(sub.name);
			if (owners) {
				owners.push(gs.sessionName);
			} else {
				ownerMap.set(sub.name, [gs.sessionName]);
			}
		}
	}

	const seen = new Set<string>();
	const allSubscriptions: CueSubscription[] = [];

	for (const gs of graphSessions) {
		for (const sub of gs.subscriptions) {
			if (seen.has(sub.name)) continue;
			seen.add(sub.name);
			const tagged = { ...sub, _ownerSessions: ownerMap.get(sub.name) ?? [] } as CueSubscription & {
				_ownerSessions: string[];
			};
			allSubscriptions.push(tagged);
		}
	}

	return subscriptionsToPipelines(allSubscriptions, allSessions);
}
