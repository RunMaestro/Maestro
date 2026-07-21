/**
 * Converts visual pipeline graph state to YAML content consumable by the Cue engine.
 *
 * A pipeline "trigger -> agent1 -> agent2" produces chained subscriptions:
 *   - First subscription uses the trigger's event type
 *   - Subsequent subscriptions use agent.completed with source_session chaining
 *   - Fan-out uses fan_out array, fan-in uses source_session array
 */

import * as yaml from 'js-yaml';
import type {
	CuePipeline,
	PipelineNode,
	PipelineEdge,
	TriggerNodeData,
	AgentNodeData,
	CommandNodeData,
} from '../../../../shared/cue-pipeline-types';
import { commandNodeDataToCueCommand } from '../../../../shared/cue-pipeline-types';
import type { CueSubscription, CueSettings } from '../../../../shared/cue';
import { cuePromptFilePath } from '../../../../shared/maestro-paths';

/**
 * Pad single-digit hours to `HH:MM` so the on-disk YAML is canonical. The
 * scheduled trigger source compares times as zero-padded strings against the
 * wall clock; an unpadded `6:30` would silently never fire.
 */
function padScheduleTime(time: string): string {
	const match = time.match(/^(\d{1,2}):(\d{2})$/);
	if (!match) return time;
	return `${match[1].padStart(2, '0')}:${match[2]}`;
}

/**
 * Returns the chain identity for a node - the value downstream subscriptions
 * will use as `source_session`. For agents that's the agent's session name; for
 * command nodes we use the owning session's name (the engine emits
 * agent.completed against the session that ran the work).
 */
function getChainSessionName(node: PipelineNode): string {
	if (node.type === 'command') return (node.data as CommandNodeData).owningSessionName;
	return (node.data as AgentNodeData).sessionName;
}

/**
 * Returns the owning session ID for a node - used as the `agent_id` field on
 * the YAML subscription, binding it to the session whose project root and
 * cue.yaml own the work.
 */
function getOwningSessionId(node: PipelineNode): string {
	if (node.type === 'command') return (node.data as CommandNodeData).owningSessionId;
	return (node.data as AgentNodeData).sessionId;
}

/**
 * Returns the stable visual-node identifier for a node, or undefined when the
 * node predates the `nodeKey` field (legacy in-memory state). Empty strings
 * are normalized to undefined so the loader's "absent → fall back to legacy
 * dedup-by-sessionName" branch fires consistently.
 */
function getNodeKey(node: PipelineNode): string | undefined {
	const key =
		node.type === 'command'
			? (node.data as CommandNodeData).nodeKey
			: node.type === 'agent'
				? (node.data as AgentNodeData).nodeKey
				: undefined;
	return key && key.length > 0 ? key : undefined;
}

const SOURCE_OUTPUT_VAR = '{{CUE_SOURCE_OUTPUT}}';

/**
 * Ensures the prompt for an agent.completed chain subscription includes the
 * {{CUE_SOURCE_OUTPUT}} template variable so upstream agent output is passed through.
 *
 * - If the prompt already contains the variable (case-insensitive), returns as-is.
 * - If the prompt is empty/whitespace, returns the bare variable.
 * - Otherwise prepends the variable above the user's prompt.
 */
export function ensureSourceOutputVariable(prompt: string): string {
	if (prompt.toUpperCase().includes(SOURCE_OUTPUT_VAR.toUpperCase())) return prompt;
	if (!prompt.trim()) return SOURCE_OUTPUT_VAR;
	return `${SOURCE_OUTPUT_VAR}\n\n${prompt}`;
}

/**
 * Extract the per-root `owner_agent_id` from an existing cue.yaml string, or
 * undefined when absent. Used by the save path to preserve a shared root's
 * ownership across a full-overwrite write (the editor doesn't manage it).
 */
export function readOwnerAgentIdFromYaml(yamlContent: string): string | undefined {
	try {
		const parsed = yaml.load(yamlContent) as { settings?: { owner_agent_id?: unknown } } | null;
		const owner = parsed?.settings?.owner_agent_id;
		return typeof owner === 'string' && owner.trim() !== '' ? owner.trim() : undefined;
	} catch {
		return undefined;
	}
}

/** Result of converting pipelines to YAML, including external prompt files */
export interface PipelineYamlResult {
	yaml: string;
	promptFiles: Map<string, string>;
}

function buildAdjacency(pipeline: CuePipeline): {
	outgoing: Map<string, PipelineEdge[]>;
	incoming: Map<string, PipelineEdge[]>;
} {
	const outgoing = new Map<string, PipelineEdge[]>();
	const incoming = new Map<string, PipelineEdge[]>();

	for (const edge of pipeline.edges) {
		const out = outgoing.get(edge.source) ?? [];
		out.push(edge);
		outgoing.set(edge.source, out);

		const inc = incoming.get(edge.target) ?? [];
		inc.push(edge);
		incoming.set(edge.target, inc);
	}

	return { outgoing, incoming };
}

function findTriggerNodes(pipeline: CuePipeline): PipelineNode[] {
	return pipeline.nodes.filter((n) => n.type === 'trigger');
}

function getEdgeModeComment(edge: PipelineEdge): string | null {
	if (edge.mode === 'debate') {
		const rounds = edge.debateConfig?.maxRounds ?? 3;
		const timeout = edge.debateConfig?.timeoutPerRound ?? 60;
		return `# mode: debate, max_rounds: ${rounds}, timeout_per_round: ${timeout}`;
	}
	if (edge.mode === 'autorun') {
		return '# mode: autorun';
	}
	return null;
}

/**
 * Populates trigger-event-specific fields on a subscription from the trigger's
 * visual config. Extracted so single-target, agent fan-out, and per-branch
 * command fan-out can all emit identical event config without duplicating the
 * switch statement (per-branch emits N subs that must each re-carry the full
 * event config to re-arm independently with the engine).
 */
function applyTriggerEventConfig(sub: CueSubscription, triggerData: TriggerNodeData): void {
	if (triggerData.customLabel) {
		sub.label = triggerData.customLabel;
	}
	switch (triggerData.eventType) {
		case 'time.heartbeat':
			if (triggerData.config.interval_minutes) {
				sub.interval_minutes = triggerData.config.interval_minutes;
			}
			break;
		case 'time.scheduled':
			if (triggerData.config.schedule_times?.length) {
				sub.schedule_times = triggerData.config.schedule_times.map(padScheduleTime);
			}
			if (triggerData.config.schedule_days?.length) {
				sub.schedule_days = triggerData.config.schedule_days as CueSubscription['schedule_days'];
			}
			break;
		case 'file.changed':
			sub.watch = triggerData.config.watch ?? '**/*';
			if (triggerData.config.filter) {
				sub.filter = triggerData.config.filter;
			}
			break;
		case 'github.pull_request':
		case 'github.issue':
			if (triggerData.config.repo) sub.repo = triggerData.config.repo;
			if (triggerData.config.poll_minutes) sub.poll_minutes = triggerData.config.poll_minutes;
			if (triggerData.config.retrigger_on_comments === true) {
				sub.retrigger_on_comments = true;
				// Only emit the cap when it differs from the default (10) so YAML
				// stays minimal. `0` (unlimited) is a valid explicit value and
				// must round-trip - the !== 10 check covers both cases.
				if (
					triggerData.config.max_notifications !== undefined &&
					triggerData.config.max_notifications !== 10
				) {
					sub.max_notifications = triggerData.config.max_notifications;
				}
			}
			break;
		case 'task.pending':
			sub.watch = triggerData.config.watch ?? '**/*.md';
			break;
		case 'agent.completed':
			// source_session comes from node config, not edges
			break;
	}
}

/**
 * Sets the trigger-sub's `prompt` / `action` / `command` / `output_prompt`
 * fields for a direct target. Shared between single-target and per-branch
 * emission paths.
 */
function populateTargetWork(
	sub: CueSubscription,
	target: PipelineNode,
	fallbackName: string,
	triggerOutgoing: PipelineEdge[]
): void {
	if (target.type === 'command') {
		const cmdData = target.data as CommandNodeData;
		const cmd = commandNodeDataToCueCommand(cmdData);
		// User chose this name in the UI; keep it as the subscription name so
		// the YAML is readable instead of using the auto-generated chain index.
		sub.name = cmdData.name || fallbackName;
		// `prompt` is the dispatcher's "has work" sentinel for command actions;
		// the normalizer back-fills it from the command spec on load.
		sub.prompt = cmd?.mode === 'shell' ? cmd.shell : cmd?.mode === 'cli' ? cmd.cli.target : '';
		sub.action = 'command';
		if (cmd) sub.command = cmd;
	} else {
		const agentData = target.data as AgentNodeData;
		const triggerEdge = triggerOutgoing.find((e) => e.target === target.id);
		sub.prompt = triggerEdge?.prompt ?? agentData.inputPrompt ?? '';
		if (agentData.outputPrompt) sub.output_prompt = agentData.outputPrompt;
	}
	const targetKey = getNodeKey(target);
	if (targetKey) sub.target_node_key = targetKey;
}

/**
 * Owning agent for an emitted subscription, captured at emission time keyed by
 * the subscription's object identity (NOT its name). Sub names are not unique -
 * a command node can be named exactly like the `<pipeline>-chain-N` auto-naming
 * scheme - so re-deriving the owner via a second name-keyed traversal silently
 * dropped `agent_id` on a later sub once a collision shifted the chain counter.
 * Stamping the owner here makes that impossible. See {@link pipelineToYamlSubscriptions}.
 */
export interface SubscriptionOwner {
	/** Owning agent session id → the subscription's `agent_id`. */
	id: string;
	/** Owning agent display name → prompt-file paths + name-based resolver fallback. */
	name: string;
}

/**
 * Lower-level helper: converts a single pipeline into CueSubscription objects.
 *
 * When `ownerOut` is supplied, each emitted subscription is recorded against
 * its owning agent (by object identity) so callers don't have to re-walk the
 * graph to recover `agent_id` - a re-walk that drifted out of sync whenever a
 * command node's name collided with the `-chain-N` auto-naming sequence.
 */
export function pipelineToYamlSubscriptions(
	pipeline: CuePipeline,
	ownerOut?: Map<CueSubscription, SubscriptionOwner>
): CueSubscription[] {
	const subscriptions: CueSubscription[] = [];
	const { outgoing, incoming } = buildAdjacency(pipeline);
	const triggers = findTriggerNodes(pipeline);
	const nodeMap = new Map(pipeline.nodes.map((n) => [n.id, n]));

	// Record which agent node owns each emitted subscription, keyed by sub
	// object identity. Collision-proof, unlike a name-keyed map.
	const recordOwner = (sub: CueSubscription, node: PipelineNode): void => {
		if (ownerOut)
			ownerOut.set(sub, { id: getOwningSessionId(node), name: getChainSessionName(node) });
	};

	// Track visited nodes to avoid duplicates.
	const visited = new Set<string>();
	// Track ALL subscription names that run each work node. A Set per node
	// because multiple triggers can target the same agent (e.g. app.startup +
	// scheduled + PR triggers all pointing at Agent A). Each trigger generates
	// its OWN subscription name; the post-pass uses this Set to populate
	// `source_sub` on downstream chain subs with ALL upstream names so the
	// chain fires regardless of which trigger originally kicked off Agent A.
	// Using a Map<string,string> (overwriting) was the pre-existing bug: only
	// the LAST trigger's name survived, so completions from earlier triggers
	// failed the source_sub filter and the pipeline silently stalled.
	const subNamesForNode = new Map<string, Set<string>>();
	const addSubNameForNode = (nodeId: string, name: string): void => {
		const set = subNamesForNode.get(nodeId);
		if (set) {
			set.add(name);
		} else {
			subNamesForNode.set(nodeId, new Set([name]));
		}
	};
	// Subscription names double as STABLE IDENTITIES: the layout store keys each
	// trigger's saved position by its subscription name, and downstream
	// `source_sub` references point at them. Re-deriving names from node-array
	// order (the old `chainIndex++` scheme) renamed every trigger whenever
	// Arrange reordered the nodes, which silently reassigned saved positions to
	// the wrong triggers - the "layout won't stay arranged" bug. Preserve each
	// trigger's existing `subscriptionName` across saves and only mint a fresh
	// `-chain-N` for genuinely new nodes. `usedSubNames` guarantees uniqueness
	// across both preserved and freshly-minted names (including buildChain's).
	const usedSubNames = new Set<string>();
	let freshChainCursor = 0;
	const generateFreshSubName = (): string => {
		let candidate: string;
		do {
			candidate =
				freshChainCursor === 0 ? pipeline.name : `${pipeline.name}-chain-${freshChainCursor}`;
			freshChainCursor++;
		} while (usedSubNames.has(candidate));
		usedSubNames.add(candidate);
		return candidate;
	};
	const claimSubName = (preferred?: string): string => {
		if (typeof preferred === 'string' && preferred.length > 0 && !usedSubNames.has(preferred)) {
			usedSubNames.add(preferred);
			return preferred;
		}
		return generateFreshSubName();
	};

	for (const trigger of triggers) {
		const triggerData = trigger.data as TriggerNodeData;
		const triggerOutgoing = outgoing.get(trigger.id) ?? [];

		if (triggerOutgoing.length === 0) continue;

		// Build the first subscription from trigger. A "work target" is anything
		// that performs work - agent nodes (run a prompt) or command nodes (run
		// shell/cli). cli_output nodes from rc are now folded into command nodes;
		// they no longer exist as a node type.
		const directTargets = triggerOutgoing
			.map((e) => nodeMap.get(e.target))
			.filter(Boolean) as PipelineNode[];
		// Filter out unbound commands (no owning session). They can't be serialized
		// - `agent_id` on the subscription would be empty and the engine rejects
		// the config. Validation catches this at save time; this is defense-in-depth.
		const workTargets = directTargets.filter(
			(n) =>
				n.type === 'agent' ||
				(n.type === 'command' && !!(n.data as CommandNodeData).owningSessionId)
		);

		if (workTargets.length === 0) continue;

		const allAgents = workTargets.every((n) => n.type === 'agent');

		if (workTargets.length === 1) {
			// === Single target: agent or command ===
			const subName = claimSubName(triggerData.subscriptionName);

			const sub: CueSubscription = {
				name: subName,
				event: triggerData.eventType,
				enabled: true,
				prompt: '',
			};
			applyTriggerEventConfig(sub, triggerData);

			const target = workTargets[0];
			populateTargetWork(sub, target, subName, triggerOutgoing);

			subscriptions.push(sub);
			recordOwner(sub, target);
			visited.add(target.id);
			addSubNameForNode(target.id, sub.name);

			buildChain(
				target,
				pipeline.name,
				subscriptions,
				outgoing,
				incoming,
				nodeMap,
				visited,
				subNamesForNode,
				usedSubNames,
				ownerOut
			);
		} else if (allAgents) {
			// === Fan-out to agents only - canonical `fan_out` shape ===
			// The engine's fan_out array addresses sessions by name, which
			// only makes sense for agent targets (commands have no session
			// identity of their own). One sub handles N agents at runtime.
			const subName = claimSubName(triggerData.subscriptionName);

			const sub: CueSubscription = {
				name: subName,
				event: triggerData.eventType,
				enabled: true,
				prompt: '',
			};
			applyTriggerEventConfig(sub, triggerData);

			const fanOutAgents = workTargets;
			sub.fan_out = fanOutAgents.map((a) => (a.data as AgentNodeData).sessionName);
			// Stable-id mirror so the dispatcher can resolve a target after
			// it's been renamed. The dispatcher prefers `fan_out_ids[i]` over
			// `fan_out[i]`; without this, a rename silently drops the target.
			const fanOutIds = fanOutAgents.map((a) => (a.data as AgentNodeData).sessionId);
			if (fanOutIds.every(Boolean) && fanOutIds.length === fanOutAgents.length) {
				sub.fan_out_ids = fanOutIds;
			}
			// Per-position visual-node identifiers. Required so the loader can
			// distinguish "two distinct visual nodes happen to point at the
			// same agent_id" (different keys → separate nodes) from "explicit
			// fan-in onto one shared node" (same key → merged node). Emit only
			// when every position carries a key - partial population is
			// ambiguous and we'd rather fall back to the legacy
			// dedup-by-sessionName behavior than guess.
			const fanOutKeys = fanOutAgents.map((a) => getNodeKey(a));
			if (fanOutKeys.every((k): k is string => !!k) && fanOutKeys.length === fanOutAgents.length) {
				sub.fan_out_node_keys = fanOutKeys;
			}
			// Resolve per-agent prompts from edge prompt → agent inputPrompt fallback.
			const perAgentPrompts = fanOutAgents.map((agent) => {
				const edge = triggerOutgoing.find((e) => e.target === agent.id);
				return edge?.prompt ?? (agent.data as AgentNodeData).inputPrompt ?? '';
			});
			const allSame = perAgentPrompts.every((p) => p === perAgentPrompts[0]);
			if (allSame) {
				// All fan-out targets share the same prompt - keep the single
				// `prompt` path so we externalize it to one file in the record
				// assembly step below.
				sub.prompt = perAgentPrompts[0];
			} else {
				// Per-agent prompts differ. Externalize each to its own `.md`
				// file (written in the record assembly step) and emit
				// `fan_out_prompt_files` pointing at them. This keeps the UI↔YAML
				// mapping symmetric - one file per agent, mirroring what the
				// editor shows - instead of the old inline `fan_out_prompts`
				// array which bloated the YAML and read asymmetrically.
				sub.prompt = perAgentPrompts[0]; // engine fallback if files go missing
				sub.fan_out_prompts = perAgentPrompts; // carries content to assembly
				// Path is keyed by (agentName, subName). `subName` - not
				// `pipeline.name` - is what disambiguates prompt files
				// across subscriptions within the same pipeline. A pipeline
				// may have multiple triggers that each fan-out to the same
				// agents (e.g. a GitHub-PR trigger and a heartbeat trigger
				// both fanning out to [Codex, OpenCode]); both subs would
				// otherwise write to the same `.maestro/prompts/codex-pipeline.md`
				// and the SECOND write would silently overwrite the FIRST.
				// Using the subscription name keeps each sub's prompts
				// isolated on disk, mirroring how single-prompt subs are
				// keyed (see `promptSuffix = sub.name` below).
				//
				// Additional disambiguator: when two fan-out targets within
				// the SAME sub share a sessionName (pathological - user
				// dragged the same agent in twice), append the positional
				// index so each agent still gets its own file.
				const baseNameCounts = new Map<string, number>();
				for (const agent of fanOutAgents) {
					const name = (agent.data as AgentNodeData).sessionName;
					baseNameCounts.set(name, (baseNameCounts.get(name) ?? 0) + 1);
				}
				sub.fan_out_prompt_files = fanOutAgents.map((agent, idx) => {
					const agentName = (agent.data as AgentNodeData).sessionName;
					const collides = (baseNameCounts.get(agentName) ?? 0) > 1;
					return collides
						? cuePromptFilePath(agentName, subName, `${idx}`)
						: cuePromptFilePath(agentName, subName);
				});
			}
			subscriptions.push(sub);
			// The single fan-out sub is owned by the first agent (its id lands on
			// `agent_id`); the others participate via `fan_out` / `fan_out_ids`.
			recordOwner(sub, fanOutAgents[0]);

			for (const agent of fanOutAgents) {
				visited.add(agent.id);
				addSubNameForNode(agent.id, sub.name);
			}

			// Follow chains from each fan-out target
			for (const agent of fanOutAgents) {
				buildChain(
					agent,
					pipeline.name,
					subscriptions,
					outgoing,
					incoming,
					nodeMap,
					visited,
					subNamesForNode,
					usedSubNames,
					ownerOut
				);
			}
		} else {
			// === Per-branch fan-out: any target is a command ===
			// `fan_out` can't carry command targets - the engine addresses
			// fan_out by session name and commands have no session of their
			// own. Instead we emit one fully-independent subscription per
			// direct target, each re-carrying the trigger's event config so
			// they each arm with the engine. On reload, `yamlToPipeline`
			// groups branch subs that share `pipeline_name` + identical
			// trigger event config back onto a single visual trigger node.
			let firstBranch = true;
			for (const target of workTargets) {
				// Only the first branch can inherit the shared trigger node's
				// stored subscription name; the rest are genuinely new subs.
				const branchName = claimSubName(firstBranch ? triggerData.subscriptionName : undefined);
				firstBranch = false;

				const branchSub: CueSubscription = {
					name: branchName,
					event: triggerData.eventType,
					enabled: true,
					prompt: '',
				};
				applyTriggerEventConfig(branchSub, triggerData);
				populateTargetWork(branchSub, target, branchName, triggerOutgoing);

				subscriptions.push(branchSub);
				recordOwner(branchSub, target);
				visited.add(target.id);
				addSubNameForNode(target.id, branchSub.name);

				buildChain(
					target,
					pipeline.name,
					subscriptions,
					outgoing,
					incoming,
					nodeMap,
					visited,
					subNamesForNode,
					usedSubNames,
					ownerOut
				);
			}
		}
	}

	// Post-pass: populate `source_sub` on every chain subscription now that
	// `subNamesForNode` holds entries for every work node in the pipeline.
	// Doing this inline during buildChain's recursion is unsafe - a fan-in
	// target reached through the first branch has upstream work nodes from
	// OTHER branches whose subs haven't been emitted yet. Deferring the
	// lookup guarantees every upstream sub name is known.
	//
	// `source_sub` narrows completion matching: a chain sub fires only on
	// completions produced by the listed upstream subs, not on any run in
	// the source session (which was the pre-existing self-loop / cross-fire
	// failure mode - see `CueSubscription.source_sub` docs for the full
	// rationale).
	const targetNodeBySubName = new Map<string, string>();
	for (const [nodeId, names] of subNamesForNode) {
		for (const name of names) {
			// A second node owning the same sub name silently overwrites the
			// first entry here, which would drop the first sub's `source_sub`
			// population. Sub names are expected to be unique within a pipeline,
			// but pathological YAML or a future refactor could break that - log
			// loudly so the failure mode is visible instead of silent.
			if (targetNodeBySubName.has(name)) {
				console.warn(
					`[CUE] Duplicate sub name "${name}" while building source_sub map - earlier owner may not get its source_sub populated`
				);
			}
			targetNodeBySubName.set(name, nodeId);
		}
	}
	for (const sub of subscriptions) {
		if (sub.event !== 'agent.completed') continue;
		const targetNodeId = targetNodeBySubName.get(sub.name);
		if (!targetNodeId) continue;
		const targetIncoming = incoming.get(targetNodeId) ?? [];
		const incomingWorkEdges = targetIncoming.filter((e) => {
			const src = nodeMap.get(e.source);
			return src?.type === 'agent' || src?.type === 'command';
		});
		const sourceSubNames = incomingWorkEdges
			.flatMap((e) => Array.from(subNamesForNode.get(e.source) ?? []))
			.filter((name): name is string => !!name);
		if (sourceSubNames.length > 0) {
			// Dedupe and preserve insertion order so YAML round-trips stably
			// when two incoming edges originate from the same upstream sub
			// (pathological but possible).
			const unique = Array.from(new Set(sourceSubNames));
			sub.source_sub = unique.length === 1 ? unique[0] : unique;
		}
	}

	return subscriptions;
}

function buildChain(
	fromNode: PipelineNode,
	pipelineName: string,
	subscriptions: CueSubscription[],
	outgoing: Map<string, PipelineEdge[]>,
	incoming: Map<string, PipelineEdge[]>,
	nodeMap: Map<string, PipelineNode>,
	visited: Set<string>,
	subNamesForNode: Map<string, Set<string>>,
	usedSubNames: Set<string>,
	ownerOut?: Map<CueSubscription, SubscriptionOwner>
): void {
	const fromOutgoing = outgoing.get(fromNode.id) ?? [];
	if (fromOutgoing.length === 0) return;

	// Mint a unique chain-sub name, preferring a stable identity (a command
	// node's own name) and falling back to the next free `-chain-N`. Shares
	// `usedSubNames` with the trigger loop so a freshly-minted chain name can
	// never collide with a preserved trigger name (or vice versa).
	const claimChainName = (preferred?: string): string => {
		if (typeof preferred === 'string' && preferred.length > 0 && !usedSubNames.has(preferred)) {
			usedSubNames.add(preferred);
			return preferred;
		}
		let i = subscriptions.length;
		let candidate: string;
		do {
			candidate = `${pipelineName}-chain-${i}`;
			i++;
		} while (usedSubNames.has(candidate));
		usedSubNames.add(candidate);
		return candidate;
	};

	const targets = fromOutgoing
		.map((e) => nodeMap.get(e.target))
		.filter(
			(n): n is PipelineNode =>
				n != null &&
				(n.type === 'agent' ||
					(n.type === 'command' && !!(n.data as CommandNodeData).owningSessionId))
		);

	if (targets.length === 0) return;

	const fromChainName = getChainSessionName(fromNode);

	for (const target of targets) {
		if (visited.has(target.id)) continue;
		visited.add(target.id);

		// Incoming work edges (agent-or-command sources). Used for fan-in
		// detection and source_session emission.
		const targetIncoming = incoming.get(target.id) ?? [];
		const incomingWorkEdges = targetIncoming.filter((e) => {
			const sourceNode = nodeMap.get(e.source);
			return sourceNode?.type === 'agent' || sourceNode?.type === 'command';
		});

		let sub: CueSubscription;

		if (target.type === 'command') {
			const cmdData = target.data as CommandNodeData;
			const cmd = commandNodeDataToCueCommand(cmdData);
			sub = {
				name: claimChainName(cmdData.name),
				event: 'agent.completed',
				enabled: true,
				prompt: cmd?.mode === 'shell' ? cmd.shell : cmd?.mode === 'cli' ? cmd.cli.target : '',
				action: 'command',
				...(cmd ? { command: cmd } : {}),
			};
		} else {
			const targetData = target.data as AgentNodeData;
			// Determine per-edge upstream-output inclusion. Each incoming work edge
			// can independently opt out of contributing its output to the target's
			// {{CUE_SOURCE_OUTPUT}} ("passthrough": the source must still complete
			// before the target fires, but its output is not injected).
			//
			// Resolution priority: edge.includeUpstreamOutput → node.includeUpstreamOutput → true.
			const resolveInclude = (edge: PipelineEdge): boolean => {
				if (edge.includeUpstreamOutput !== undefined) return edge.includeUpstreamOutput;
				return targetData.includeUpstreamOutput !== false;
			};
			const includedEdges = incomingWorkEdges.filter(resolveInclude);
			const shouldInjectSource = includedEdges.length > 0;

			sub = {
				name: claimChainName(),
				event: 'agent.completed',
				enabled: true,
				prompt: shouldInjectSource
					? ensureSourceOutputVariable(targetData.inputPrompt ?? '')
					: (targetData.inputPrompt ?? ''),
				output_prompt: targetData.outputPrompt || undefined,
			};

			if (incomingWorkEdges.length > 1) {
				// Fan-in include_output_from / forward_output_from only emit for agent
				// targets - command nodes don't aggregate per-source outputs.
				if (includedEdges.length < incomingWorkEdges.length && includedEdges.length > 0) {
					sub.include_output_from = includedEdges
						.map((e) => {
							const src = nodeMap.get(e.source);
							return src ? getChainSessionName(src) : '';
						})
						.filter(Boolean);
				}
				const forwardedEdges = incomingWorkEdges.filter((e) => e.forwardOutput === true);
				if (forwardedEdges.length > 0) {
					sub.forward_output_from = forwardedEdges
						.map((e) => {
							const src = nodeMap.get(e.source);
							return src ? getChainSessionName(src) : '';
						})
						.filter(Boolean);
				}
				if (targetData.fanInTimeoutMinutes != null) {
					sub.fan_in_timeout_minutes = targetData.fanInTimeoutMinutes;
				}
				if (targetData.fanInTimeoutOnFail != null) {
					sub.fan_in_timeout_on_fail = targetData.fanInTimeoutOnFail;
				}
			}
		}

		// source_session: fan-in emits the full source list, single-source emits one name.
		// Emit names (legacy) AND ids (new). IDs are authoritative on load;
		// names remain for human readability and for downgrading to older
		// versions of Maestro that don't know the new field.
		if (incomingWorkEdges.length > 1) {
			const sourceNames = incomingWorkEdges
				.map((e) => {
					const src = nodeMap.get(e.source);
					return src ? getChainSessionName(src) : '';
				})
				.filter(Boolean);
			const sourceIds = incomingWorkEdges
				.map((e) => {
					const src = nodeMap.get(e.source);
					return src ? getOwningSessionId(src) : '';
				})
				.filter(Boolean);
			sub.source_session = sourceNames;
			if (sourceIds.length === sourceNames.length && sourceIds.length > 0) {
				sub.source_session_ids = sourceIds;
			}
		} else {
			sub.source_session = fromChainName;
			const fromId = getOwningSessionId(fromNode);
			if (fromId) {
				sub.source_session_ids = fromId;
			}
		}

		// `source_sub` is intentionally NOT set here. It's populated in a
		// post-pass at the end of `pipelineToYamlSubscriptions` because a
		// fan-in chain sub reached through the first branch can't see the
		// second branch's upstream sub names yet - those subs haven't been
		// pushed when `buildChain` recurses into the fan-in target from
		// branch 1. Deferring the lookup until every sub has been emitted
		// guarantees all upstream names are known before we resolve
		// `source_sub` list membership.

		const targetKey = getNodeKey(target);
		if (targetKey) sub.target_node_key = targetKey;

		subscriptions.push(sub);
		if (ownerOut)
			ownerOut.set(sub, { id: getOwningSessionId(target), name: getChainSessionName(target) });
		// Merge instead of overwrite - a chain agent can be reached from
		// multiple upstream paths (e.g. TriggerA → Agent1 and TriggerB →
		// Agent1 → Agent2). If we replace the set, the post-pass that fills
		// `source_sub` for downstream chain subs loses the earlier-recorded
		// names and the chain silently stalls on completions from those
		// missing upstreams.
		const existingNames = subNamesForNode.get(target.id);
		if (existingNames) {
			existingNames.add(sub.name);
		} else {
			subNamesForNode.set(target.id, new Set([sub.name]));
		}

		// Continue the chain
		buildChain(
			target,
			pipelineName,
			subscriptions,
			outgoing,
			incoming,
			nodeMap,
			visited,
			subNamesForNode,
			usedSubNames,
			ownerOut
		);
	}
}

/**
 * Intermediate representation of `pipelinesToYaml`: the raw subscription
 * records (pre-yaml.dump) plus the prompt files they reference and any
 * edge-mode comments. Used as the join point for both whole-yaml emit and
 * per-owner-cwd emit (see {@link pipelinesToYamlByOwnerCwd}). Each record
 * carries an `agent_id` field that uniquely identifies the owning agent -
 * grouping by `agent_id`'s cwd is what enables per-agent-yaml splitting.
 */
export interface PipelineSubscriptionRecords {
	records: Array<Record<string, unknown>>;
	promptFiles: Map<string, string>;
	comments: string[];
}

/**
 * Resolves a node's owning agent to a live session id, mirroring the id→name
 * fallback in `resolveNodeWriteRoot` (see pipelineRoots.ts). Given the node's
 * own `(sessionId, sessionName)`, return the id the YAML should bind to.
 *
 * The default behavior (no resolver) emits the raw `sessionId`. handleSave
 * passes a resolver backed by the live session maps so that a node bound by
 * NAME only - empty/stale `sessionId` but a `sessionName` that still matches a
 * live agent - emits the live agent's id instead of an empty `agent_id`. That
 * asymmetry (validation resolves by name, emission did not) was the
 * "Unresolvable agent_id ... (agent_id=<missing>)" save failure on legacy
 * pipelines whose nodes predate stable session ids.
 */
export type OwnerIdResolver = (
	sessionId: string | undefined,
	sessionName: string | undefined
) => string | undefined;

/**
 * Build the intermediate subscription records for a list of pipelines without
 * serializing to YAML. Exposed so the per-owner-cwd emitter can split records
 * by `record.agent_id` → cwd before calling the YAML serializer.
 */
export function pipelinesToSubscriptionRecords(
	pipelines: CuePipeline[],
	resolveOwnerId?: OwnerIdResolver
): PipelineSubscriptionRecords {
	const allSubscriptions: Array<Record<string, unknown>> = [];
	const comments: string[] = [];
	const promptFiles = new Map<string, string>();

	for (const pipeline of pipelines) {
		// Owner (agent_id + display name) is stamped per-subscription during
		// emission, keyed by object identity. This replaces the previous pair of
		// name-keyed re-traversals (`buildSubAgentMap` / `buildSubAgentIdMap`),
		// which drifted out of sync with the emitter whenever a command node's
		// name collided with the `-chain-N` auto-naming scheme - dropping
		// `agent_id` on a later sub and failing the save with
		// "Unresolvable agent_id ... (agent_id=<missing>)".
		const owners = new Map<CueSubscription, SubscriptionOwner>();
		const subs = pipelineToYamlSubscriptions(pipeline, owners);

		for (const sub of subs) {
			const owner = owners.get(sub);
			const record: Record<string, unknown> = {
				name: sub.name,
				event: sub.event,
			};

			// Bind subscription to its owning agent by session ID. When a
			// resolver is supplied, normalize the raw node id through it (with
			// the node's session name as the fallback key) so a node bound by
			// name only still emits a live `agent_id` instead of <missing>.
			const rawAgentId = owner?.id || undefined;
			const agentId = resolveOwnerId ? resolveOwnerId(rawAgentId, owner?.name) : rawAgentId;
			if (agentId) record.agent_id = agentId;

			// Persist the owning pipeline's name and color so they round-trip
			// through YAML. `pipeline_name` is authoritative for grouping -
			// editing a subscription's `name` no longer breaks pipeline
			// membership. `pipeline_color` keeps colors stable across reloads.
			if (pipeline.name) record.pipeline_name = pipeline.name;
			if (pipeline.color) record.pipeline_color = pipeline.color;

			if (sub.label) record.label = sub.label;
			if (sub.interval_minutes != null) record.interval_minutes = sub.interval_minutes;
			if (sub.schedule_times != null) record.schedule_times = sub.schedule_times;
			if (sub.schedule_days != null) record.schedule_days = sub.schedule_days;
			if (sub.watch != null) record.watch = sub.watch;
			if (sub.repo != null) record.repo = sub.repo;
			if (sub.poll_minutes != null) record.poll_minutes = sub.poll_minutes;
			if (sub.retrigger_on_comments === true) record.retrigger_on_comments = true;
			if (sub.max_notifications != null) record.max_notifications = sub.max_notifications;
			if (sub.source_session != null) record.source_session = sub.source_session;
			if (sub.source_session_ids != null) record.source_session_ids = sub.source_session_ids;
			if (sub.source_sub != null) record.source_sub = sub.source_sub;
			if (sub.fan_out != null) record.fan_out = sub.fan_out;
			if (sub.fan_out_ids != null) record.fan_out_ids = sub.fan_out_ids;
			// Per-agent fan-out prompts: prefer externalized files over the
			// legacy inline array. Emitting both would be redundant - the
			// normalizer resolves files into the same runtime slots as
			// inline prompts, so only one needs to reach the YAML.
			if (sub.fan_out_prompt_files != null) {
				record.fan_out_prompt_files = sub.fan_out_prompt_files;
			} else if (sub.fan_out_prompts != null) {
				record.fan_out_prompts = sub.fan_out_prompts;
			}
			if (sub.filter != null) record.filter = sub.filter;
			if (sub.fan_in_timeout_minutes != null)
				record.fan_in_timeout_minutes = sub.fan_in_timeout_minutes;
			if (sub.fan_in_timeout_on_fail != null)
				record.fan_in_timeout_on_fail = sub.fan_in_timeout_on_fail;
			if (sub.include_output_from != null) record.include_output_from = sub.include_output_from;
			if (sub.forward_output_from != null) record.forward_output_from = sub.forward_output_from;
			if (sub.target_node_key != null) record.target_node_key = sub.target_node_key;
			if (sub.fan_out_node_keys != null) record.fan_out_node_keys = sub.fan_out_node_keys;

			// Command action: emit `action: command` + the structured `command`
			// object inline. Skip prompt_file emission - the dispatcher uses
			// `prompt` only as a sentinel that the normalizer back-fills from
			// the command spec on load.
			if (sub.action === 'command') {
				record.action = 'command';
				if (sub.command != null) record.command = sub.command;
				allSubscriptions.push(record);
				continue;
			}

			// Save prompts as external files.
			// Use sub.name as the suffix key so multiple triggers targeting the same agent
			// get unique file paths (e.g. agent-pipeline.md vs agent-pipeline-chain-1.md).
			const agentName = owner?.name ?? 'agent';
			const promptSuffix = sub.name === pipeline.name ? pipeline.name : sub.name;

			// When fan-out targets carry different prompts, each agent's prompt
			// lives in its own file (`fan_out_prompt_files`). In that case we
			// skip the single `prompt_file` emission entirely - `sub.prompt` is
			// kept only as an engine fallback, not as a canonical source of
			// truth on disk.
			if (sub.prompt && !sub.fan_out_prompt_files) {
				const filePath = cuePromptFilePath(agentName, promptSuffix);
				record.prompt_file = filePath;
				promptFiles.set(filePath, sub.prompt);
			} else {
				// Defensive: the loader-side validator rejects subscriptions with
				// neither `prompt` nor `prompt_file`. A pipeline whose prompts
				// haven't been filled in yet (or where a debounce race wiped the
				// value before save) would otherwise yield YAML that loads
				// cleanly on the editor but is rejected on the engine side -
				// producing the "pipeline vanished after save" symptom. Emit an
				// empty inline prompt so the subscription round-trips and the
				// editor can still surface a "missing prompt" validation error
				// to the user on the next save attempt.
				record.prompt = '';
			}

			// Write one `.md` file per fan-out agent when we've chosen the
			// externalized shape. Empty strings are written through too so
			// the file-path → prompt positional mapping in `fan_out` stays
			// intact (normalizer reads back `""` from missing/empty files).
			if (sub.fan_out_prompt_files && sub.fan_out_prompts) {
				for (let i = 0; i < sub.fan_out_prompt_files.length; i++) {
					const filePath = sub.fan_out_prompt_files[i];
					const content = sub.fan_out_prompts[i] ?? '';
					promptFiles.set(filePath, content);
				}
			}

			if (sub.output_prompt) {
				const filePath = cuePromptFilePath(agentName, promptSuffix, 'output');
				record.output_prompt_file = filePath;
				promptFiles.set(filePath, sub.output_prompt);
			}

			allSubscriptions.push(record);
		}

		// Add edge mode annotations as comments
		for (const edge of pipeline.edges) {
			const comment = getEdgeModeComment(edge);
			if (comment) {
				const sourceNode = pipeline.nodes.find((n) => n.id === edge.source);
				const targetNode = pipeline.nodes.find((n) => n.id === edge.target);
				if (sourceNode && targetNode) {
					const labelOf = (n: PipelineNode): string => {
						if (n.type === 'trigger') return (n.data as TriggerNodeData).label;
						if (n.type === 'command') return (n.data as CommandNodeData).name || 'command';
						return (n.data as AgentNodeData).sessionName;
					};
					comments.push(
						`# Edge ${labelOf(sourceNode)} -> ${labelOf(targetNode)}: ${comment.replace('# ', '')}`
					);
				}
			}
		}
	}

	return { records: allSubscriptions, promptFiles, comments };
}

/**
 * Serialize a subscription record list (with optional settings + comments) to
 * a YAML string. Pure formatting - no graph traversal - so callers that have
 * already split records (e.g. {@link pipelinesToYamlByOwnerCwd}) can re-emit
 * per-cwd YAMLs without re-running the pipeline-to-records conversion.
 */
export function recordsToYaml(
	records: Array<Record<string, unknown>>,
	settings?: Partial<CueSettings>,
	comments: string[] = []
): string {
	const config: Record<string, unknown> = {
		subscriptions: records,
	};

	if (settings) {
		config.settings = settings;
	}

	const yamlStr = yaml.dump(config, {
		indent: 2,
		lineWidth: 120,
		noRefs: true,
		quotingType: "'",
		forceQuotes: false,
	});

	const header = comments.length > 0 ? comments.join('\n') + '\n\n' : '';
	return header + yamlStr;
}

/**
 * Converts pipeline graph state to YAML string with external prompt files.
 * Prompts are saved as external .md files referenced by prompt_file in the YAML.
 *
 * For the per-agent-cwd save path (current architecture), prefer
 * {@link pipelinesToYamlByOwnerCwd} which splits records by their owning
 * agent's project root. This whole-yaml emitter is retained for tests and
 * for callers that need a single round-trippable yaml string.
 */
export function pipelinesToYaml(
	pipelines: CuePipeline[],
	settings?: Partial<CueSettings>
): PipelineYamlResult {
	const { records, promptFiles, comments } = pipelinesToSubscriptionRecords(pipelines);
	return { yaml: recordsToYaml(records, settings, comments), promptFiles };
}

/**
 * Subset of session info this module needs to map agent_id → project root
 * for per-agent-cwd YAML emission.
 */
interface SessionRootRef {
	projectRoot?: string;
}

/**
 * Result entry for {@link pipelinesToYamlByOwnerCwd}: the YAML string and
 * the prompt files that should be written under that cwd's `.maestro/`.
 */
export interface CwdYamlEntry extends PipelineYamlResult {
	/**
	 * Subscriptions whose `agent_id` did not resolve to a known session.
	 * Caller (handleSave) should treat these as validation errors -
	 * unresolvable refs cannot be safely written anywhere.
	 */
}

/**
 * Per-agent-cwd YAML emit. For each subscription record, look up the owner
 * via `agent_id` → session → projectRoot, group records by cwd, and emit one
 * YAML per cwd containing only that cwd's subs.
 *
 * This is the writer counterpart to the loader's per-cwd read model: each
 * agent's `.maestro/cue.yaml` is the sole source of truth for that agent's
 * subscriptions. A pipeline that spans N agents writes to N yaml files;
 * cross-agent chains are stitched at runtime via `agent_id` references in
 * `source_session_ids` / `fan_out_ids`.
 *
 * Returns a `Map<cwd, { yaml, promptFiles }>`. Records with an `agent_id`
 * that cannot be resolved are surfaced via `unresolved` so the caller can
 * abort the save with a precise error rather than silently dropping subs.
 */
export function pipelinesToYamlByOwnerCwd(
	pipelines: CuePipeline[],
	settings: Partial<CueSettings> | undefined,
	sessionsById: ReadonlyMap<string, SessionRootRef>,
	resolveOwnerId?: OwnerIdResolver,
	/**
	 * Per-cwd `owner_agent_id` to preserve. The editor does NOT manage
	 * ownership (it's a per-root field, set via Edit YAML for shared roots), but
	 * the save fully overwrites each cue.yaml - so the existing owner must be
	 * re-injected into that root's settings here, or it would be silently
	 * dropped, reverting a shared root to fragile "first agent wins" ownership.
	 */
	ownerAgentIdByCwd?: ReadonlyMap<string, string>
): { byCwd: Map<string, CwdYamlEntry>; unresolved: Array<{ subName: string; agentId: string }> } {
	const { records, promptFiles } = pipelinesToSubscriptionRecords(pipelines, resolveOwnerId);

	const recordsByCwd = new Map<string, Array<Record<string, unknown>>>();
	const unresolved: Array<{ subName: string; agentId: string }> = [];

	for (const record of records) {
		const agentId = typeof record.agent_id === 'string' ? record.agent_id : undefined;
		if (!agentId) {
			// Unowned subs (no agent_id) cannot be placed under a per-agent
			// cwd. The current emitter always sets agent_id, so reaching this
			// branch means a hand-edited yaml or a future bug - surface it as
			// unresolved so the save fails loudly rather than dropping the sub.
			unresolved.push({ subName: String(record.name ?? '<unnamed>'), agentId: '' });
			continue;
		}
		const cwd = sessionsById.get(agentId)?.projectRoot;
		if (!cwd) {
			unresolved.push({ subName: String(record.name ?? '<unnamed>'), agentId });
			continue;
		}
		const list = recordsByCwd.get(cwd) ?? [];
		list.push(record);
		recordsByCwd.set(cwd, list);
	}

	const byCwd = new Map<string, CwdYamlEntry>();
	for (const [cwd, cwdRecords] of recordsByCwd) {
		// Collect prompt files referenced by THIS cwd's records only. The
		// global promptFiles map carries every file across every pipeline;
		// each cwd should only receive the files its own subs point at,
		// otherwise unrelated prompts would leak into every workspace and
		// the IPC handler's keep-set pruning would mis-classify them as
		// orphaned on the next save.
		const cwdPromptPaths = new Set<string>();
		for (const r of cwdRecords) {
			if (typeof r.prompt_file === 'string') cwdPromptPaths.add(r.prompt_file);
			if (typeof r.output_prompt_file === 'string') cwdPromptPaths.add(r.output_prompt_file);
			if (Array.isArray(r.fan_out_prompt_files)) {
				for (const p of r.fan_out_prompt_files) {
					if (typeof p === 'string') cwdPromptPaths.add(p);
				}
			}
		}
		const cwdPromptFiles = new Map<string, string>();
		for (const p of cwdPromptPaths) {
			const content = promptFiles.get(p);
			if (content !== undefined) cwdPromptFiles.set(p, content);
		}

		// Edge-mode comments describe inter-node relationships and may
		// reference nodes that live in other cwds. They're cosmetic (the
		// engine ignores them) and including the full set in every cwd's
		// yaml would be misleading. Drop them in per-cwd output; the editor
		// is the canonical view for cross-agent topology.
		// Re-attach this root's preserved owner_agent_id (per-root field the
		// editor doesn't manage) so a full-overwrite save doesn't drop it.
		const ownerForCwd = ownerAgentIdByCwd?.get(cwd);
		const cwdSettings =
			ownerForCwd && settings ? { ...settings, owner_agent_id: ownerForCwd } : settings;

		byCwd.set(cwd, {
			yaml: recordsToYaml(cwdRecords, cwdSettings, []),
			promptFiles: cwdPromptFiles,
		});
	}

	return { byCwd, unresolved };
}
