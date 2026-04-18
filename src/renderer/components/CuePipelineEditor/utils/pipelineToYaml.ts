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
	CliOutputNodeData,
} from '../../../../shared/cue-pipeline-types';
import type { CueSubscription, CueSettings } from '../../../../shared/cue';
import { cuePromptFilePath } from '../../../../shared/maestro-paths';

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

/**
 * Finds a cli_output node connected to the given agent node via an outgoing edge.
 * Returns the CliOutputNodeData if found, otherwise undefined.
 */
function findCliOutputForAgent(
	agentId: string,
	outgoing: Map<string, PipelineEdge[]>,
	nodeMap: Map<string, PipelineNode>
): CliOutputNodeData | undefined {
	const edges = outgoing.get(agentId) ?? [];
	for (const edge of edges) {
		const target = nodeMap.get(edge.target);
		if (target?.type === 'cli_output') {
			return target.data as CliOutputNodeData;
		}
	}
	return undefined;
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
 * Lower-level helper: converts a single pipeline into CueSubscription objects.
 */
export function pipelineToYamlSubscriptions(pipeline: CuePipeline): CueSubscription[] {
	const subscriptions: CueSubscription[] = [];
	const { outgoing, incoming } = buildAdjacency(pipeline);
	const triggers = findTriggerNodes(pipeline);
	const nodeMap = new Map(pipeline.nodes.map((n) => [n.id, n]));

	// Track visited nodes to avoid duplicates
	const visited = new Set<string>();
	let chainIndex = 0;

	for (const trigger of triggers) {
		const triggerData = trigger.data as TriggerNodeData;
		const triggerOutgoing = outgoing.get(trigger.id) ?? [];

		if (triggerOutgoing.length === 0) continue;

		// Build the first subscription from trigger
		const directTargets = triggerOutgoing
			.map((e) => nodeMap.get(e.target))
			.filter(Boolean) as PipelineNode[];
		const agentTargets = directTargets.filter((n) => n.type === 'agent');

		if (agentTargets.length === 0) continue;

		const subName = chainIndex === 0 ? pipeline.name : `${pipeline.name}-chain-${chainIndex}`;
		chainIndex++;

		const sub: CueSubscription = {
			name: subName,
			event: triggerData.eventType,
			enabled: true,
			prompt: '',
		};

		// Persist trigger's custom label
		if (triggerData.customLabel) {
			sub.label = triggerData.customLabel;
		}

		// Map trigger config fields
		switch (triggerData.eventType) {
			case 'time.heartbeat':
				if (triggerData.config.interval_minutes) {
					sub.interval_minutes = triggerData.config.interval_minutes;
				}
				break;
			case 'time.scheduled':
				if (triggerData.config.schedule_times?.length) {
					sub.schedule_times = triggerData.config.schedule_times;
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
				break;
			case 'task.pending':
				sub.watch = triggerData.config.watch ?? '**/*.md';
				break;
			case 'agent.completed':
				// source_session comes from node config, not edges
				break;
		}

		if (agentTargets.length === 1) {
			// Single target
			const agent = agentTargets[0];
			const agentData = agent.data as AgentNodeData;
			// Use edge prompt if available (per-trigger prompt), fallback to agent node prompt
			const triggerEdge = triggerOutgoing.find((e) => e.target === agent.id);
			sub.prompt = triggerEdge?.prompt ?? agentData.inputPrompt ?? '';
			if (agentData.outputPrompt) sub.output_prompt = agentData.outputPrompt;

			// Check for cli_output node connected to this agent
			const cliOutput = findCliOutputForAgent(agent.id, outgoing, nodeMap);
			if (cliOutput) {
				sub.cli_output = { target: cliOutput.target };
			}

			subscriptions.push(sub);
			visited.add(agent.id);

			// Follow the chain from this agent
			buildChain(agent, pipeline.name, subscriptions, outgoing, incoming, nodeMap, visited);
			chainIndex = subscriptions.length;
		} else {
			// Fan-out: multiple targets from trigger.
			sub.fan_out = agentTargets.map((a) => (a.data as AgentNodeData).sessionName);
			// Resolve per-agent prompts from edge prompt → agent inputPrompt fallback.
			const perAgentPrompts = agentTargets.map((agent) => {
				const edge = triggerOutgoing.find((e) => e.target === agent.id);
				return edge?.prompt ?? (agent.data as AgentNodeData).inputPrompt ?? '';
			});
			const allSame = perAgentPrompts.every((p) => p === perAgentPrompts[0]);
			if (allSame) {
				// All fan-out targets share the same prompt — keep the single
				// `prompt` path so we externalize it to one file in the record
				// assembly step below.
				sub.prompt = perAgentPrompts[0];
			} else {
				// Per-agent prompts differ. Externalize each to its own `.md`
				// file (written in the record assembly step) and emit
				// `fan_out_prompt_files` pointing at them. This keeps the UI↔YAML
				// mapping symmetric — one file per agent, mirroring what the
				// editor shows — instead of the old inline `fan_out_prompts`
				// array which bloated the YAML and read asymmetrically.
				sub.prompt = perAgentPrompts[0]; // engine fallback if files go missing
				sub.fan_out_prompts = perAgentPrompts; // carries content to assembly
				// Path is keyed by (agentName, subName). `subName` — not
				// `pipeline.name` — is what disambiguates prompt files
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
				// the SAME sub share a sessionName (pathological — user
				// dragged the same agent in twice), append the positional
				// index so each agent still gets its own file.
				const baseNameCounts = new Map<string, number>();
				for (const agent of agentTargets) {
					const name = (agent.data as AgentNodeData).sessionName;
					baseNameCounts.set(name, (baseNameCounts.get(name) ?? 0) + 1);
				}
				sub.fan_out_prompt_files = agentTargets.map((agent, idx) => {
					const agentName = (agent.data as AgentNodeData).sessionName;
					const collides = (baseNameCounts.get(agentName) ?? 0) > 1;
					return collides
						? cuePromptFilePath(agentName, subName, `${idx}`)
						: cuePromptFilePath(agentName, subName);
				});
			}
			subscriptions.push(sub);

			for (const agent of agentTargets) {
				visited.add(agent.id);
			}

			// Follow chains from each fan-out target
			for (const agent of agentTargets) {
				buildChain(agent, pipeline.name, subscriptions, outgoing, incoming, nodeMap, visited);
			}
			chainIndex = subscriptions.length;
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
	visited: Set<string>
): void {
	const fromOutgoing = outgoing.get(fromNode.id) ?? [];
	if (fromOutgoing.length === 0) return;

	const targets = fromOutgoing
		.map((e) => nodeMap.get(e.target))
		.filter((n): n is PipelineNode => n != null && n.type === 'agent');

	if (targets.length === 0) return;

	const fromAgentData = fromNode.data as AgentNodeData;

	for (const target of targets) {
		if (visited.has(target.id)) continue;
		visited.add(target.id);

		const targetData = target.data as AgentNodeData;

		// Check for fan-in: does this target have multiple incoming agent edges?
		const targetIncoming = incoming.get(target.id) ?? [];
		const incomingAgentEdges = targetIncoming.filter((e) => {
			const sourceNode = nodeMap.get(e.source);
			return sourceNode?.type === 'agent';
		});

		const subName = `${pipelineName}-chain-${subscriptions.length}`;

		// Determine per-edge upstream-output inclusion. Each incoming agent edge
		// can independently opt out of contributing its output to the target's
		// {{CUE_SOURCE_OUTPUT}} ("passthrough" semantics: the source must still
		// complete before the target fires, but its output is not injected).
		//
		// Resolution priority: edge.includeUpstreamOutput → node.includeUpstreamOutput → true.
		const resolveInclude = (edge: PipelineEdge): boolean => {
			if (edge.includeUpstreamOutput !== undefined) return edge.includeUpstreamOutput;
			return targetData.includeUpstreamOutput !== false;
		};

		// How many incoming agent edges actually contribute output?
		const includedEdges = incomingAgentEdges.filter(resolveInclude);
		const shouldInjectSource = includedEdges.length > 0;

		const sub: CueSubscription = {
			name: subName,
			event: 'agent.completed',
			enabled: true,
			prompt: shouldInjectSource
				? ensureSourceOutputVariable(targetData.inputPrompt ?? '')
				: (targetData.inputPrompt ?? ''),
			output_prompt: targetData.outputPrompt || undefined,
		};

		// Check for cli_output node connected to this agent
		const cliOutput = findCliOutputForAgent(target.id, outgoing, nodeMap);
		if (cliOutput) {
			sub.cli_output = { target: cliOutput.target };
		}

		if (incomingAgentEdges.length > 1) {
			// Fan-in: multiple source sessions.
			// Emit names (legacy) AND ids (new). IDs are authoritative on load;
			// names remain for human readability and for downgrading to older
			// versions of Maestro that don't know the new field.
			const sourceData = incomingAgentEdges.map((e) => {
				const src = nodeMap.get(e.source);
				return src ? (src.data as AgentNodeData) : null;
			});
			const allSources = sourceData.map((d) => d?.sessionName ?? '').filter(Boolean);
			const allSourceIds = sourceData.map((d) => d?.sessionId ?? '').filter(Boolean);
			sub.source_session = allSources;
			if (allSourceIds.length === allSources.length && allSourceIds.length > 0) {
				sub.source_session_ids = allSourceIds;
			}

			// Emit include_output_from when only a subset of sources contribute
			// output. This lets passthrough edges trigger the fan-in without
			// injecting their output into the prompt.
			if (includedEdges.length < incomingAgentEdges.length && includedEdges.length > 0) {
				sub.include_output_from = includedEdges
					.map((e) => {
						const src = nodeMap.get(e.source);
						return src ? (src.data as AgentNodeData).sessionName : '';
					})
					.filter(Boolean);
			}

			// Emit forward_output_from when at least one edge has forwardOutput=true.
			// Forwarded outputs are carried through this agent's completion event so
			// agents further downstream can access them via per-source variables.
			const forwardedEdges = incomingAgentEdges.filter((e) => e.forwardOutput === true);
			if (forwardedEdges.length > 0) {
				sub.forward_output_from = forwardedEdges
					.map((e) => {
						const src = nodeMap.get(e.source);
						return src ? (src.data as AgentNodeData).sessionName : '';
					})
					.filter(Boolean);
			}

			// Per-subscription fan-in timeout overrides
			if (targetData.fanInTimeoutMinutes != null) {
				sub.fan_in_timeout_minutes = targetData.fanInTimeoutMinutes;
			}
			if (targetData.fanInTimeoutOnFail != null) {
				sub.fan_in_timeout_on_fail = targetData.fanInTimeoutOnFail;
			}
		} else {
			sub.source_session = fromAgentData.sessionName;
			if (fromAgentData.sessionId) {
				sub.source_session_ids = fromAgentData.sessionId;
			}
		}

		subscriptions.push(sub);

		// Continue the chain
		buildChain(target, pipelineName, subscriptions, outgoing, incoming, nodeMap, visited);
	}
}

/**
 * Converts pipeline graph state to YAML string with external prompt files.
 * Prompts are saved as external .md files referenced by prompt_file in the YAML.
 */
export function pipelinesToYaml(
	pipelines: CuePipeline[],
	settings?: Partial<CueSettings>
): PipelineYamlResult {
	const allSubscriptions: Array<Record<string, unknown>> = [];
	const comments: string[] = [];
	const promptFiles = new Map<string, string>();

	for (const pipeline of pipelines) {
		const subs = pipelineToYamlSubscriptions(pipeline);

		// Build maps from subscription name to the agent node that owns it
		const subAgentMap = buildSubAgentMap(pipeline);
		const subAgentIdMap = buildSubAgentIdMap(pipeline);

		for (const sub of subs) {
			const record: Record<string, unknown> = {
				name: sub.name,
				event: sub.event,
			};

			// Bind subscription to its owning agent by session ID
			const agentId = subAgentIdMap.get(sub.name);
			if (agentId) record.agent_id = agentId;

			// Persist the owning pipeline's name and color so they round-trip
			// through YAML. `pipeline_name` is authoritative for grouping —
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
			if (sub.source_session != null) record.source_session = sub.source_session;
			if (sub.source_session_ids != null) record.source_session_ids = sub.source_session_ids;
			if (sub.fan_out != null) record.fan_out = sub.fan_out;
			// Per-agent fan-out prompts: prefer externalized files over the
			// legacy inline array. Emitting both would be redundant — the
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
			if (sub.cli_output != null) record.cli_output = sub.cli_output;

			// Save prompts as external files.
			// Use sub.name as the suffix key so multiple triggers targeting the same agent
			// get unique file paths (e.g. agent-pipeline.md vs agent-pipeline-chain-1.md).
			const agentName = subAgentMap.get(sub.name) ?? 'agent';
			const promptSuffix = sub.name === pipeline.name ? pipeline.name : sub.name;

			// When fan-out targets carry different prompts, each agent's prompt
			// lives in its own file (`fan_out_prompt_files`). In that case we
			// skip the single `prompt_file` emission entirely — `sub.prompt` is
			// kept only as an engine fallback, not as a canonical source of
			// truth on disk.
			if (sub.prompt && !sub.fan_out_prompt_files) {
				const filePath = cuePromptFilePath(agentName, promptSuffix);
				record.prompt_file = filePath;
				promptFiles.set(filePath, sub.prompt);
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
					const sourceName =
						sourceNode.type === 'trigger'
							? (sourceNode.data as TriggerNodeData).label
							: (sourceNode.data as AgentNodeData).sessionName;
					const targetName = (targetNode.data as AgentNodeData).sessionName;
					comments.push(`# Edge ${sourceName} -> ${targetName}: ${comment.replace('# ', '')}`);
				}
			}
		}
	}

	const config: Record<string, unknown> = {
		subscriptions: allSubscriptions,
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

	// Prepend pipeline metadata comments
	const header = comments.length > 0 ? comments.join('\n') + '\n\n' : '';
	return { yaml: header + yamlStr, promptFiles };
}

/**
 * Builds a map from subscription name to the agent session name that owns it.
 * Used for generating prompt file paths with the agent name.
 */
function buildSubAgentMap(pipeline: CuePipeline): Map<string, string> {
	const result = new Map<string, string>();
	const { outgoing } = buildAdjacency(pipeline);
	const triggers = findTriggerNodes(pipeline);
	const nodeMap = new Map(pipeline.nodes.map((n) => [n.id, n]));

	const visited = new Set<string>();
	let chainIndex = 0;

	for (const trigger of triggers) {
		const triggerOutgoing = outgoing.get(trigger.id) ?? [];
		if (triggerOutgoing.length === 0) continue;

		const directTargets = triggerOutgoing
			.map((e) => nodeMap.get(e.target))
			.filter(Boolean) as PipelineNode[];
		const agentTargets = directTargets.filter((n) => n.type === 'agent');
		if (agentTargets.length === 0) continue;

		const subName = chainIndex === 0 ? pipeline.name : `${pipeline.name}-chain-${chainIndex}`;
		chainIndex++;

		if (agentTargets.length === 1) {
			result.set(subName, (agentTargets[0].data as AgentNodeData).sessionName);
			visited.add(agentTargets[0].id);
			buildSubAgentMapChain(agentTargets[0], pipeline.name, result, outgoing, nodeMap, visited);
			chainIndex = result.size;
		} else {
			// Fan-out: use first agent name for the subscription
			result.set(subName, (agentTargets[0].data as AgentNodeData).sessionName);
			for (const agent of agentTargets) visited.add(agent.id);
			for (const agent of agentTargets) {
				buildSubAgentMapChain(agent, pipeline.name, result, outgoing, nodeMap, visited);
			}
			chainIndex = result.size;
		}
	}

	return result;
}

/**
 * Builds a map from subscription name to the agent session ID that owns it.
 * Used for setting the agent_id field in YAML so subscriptions are bound to specific agents.
 */
function buildSubAgentIdMap(pipeline: CuePipeline): Map<string, string> {
	const result = new Map<string, string>();
	const { outgoing } = buildAdjacency(pipeline);
	const triggers = findTriggerNodes(pipeline);
	const nodeMap = new Map(pipeline.nodes.map((n) => [n.id, n]));

	const visited = new Set<string>();
	let chainIndex = 0;

	for (const trigger of triggers) {
		const triggerOutgoing = outgoing.get(trigger.id) ?? [];
		if (triggerOutgoing.length === 0) continue;

		const directTargets = triggerOutgoing
			.map((e) => nodeMap.get(e.target))
			.filter(Boolean) as PipelineNode[];
		const agentTargets = directTargets.filter((n) => n.type === 'agent');
		if (agentTargets.length === 0) continue;

		const subName = chainIndex === 0 ? pipeline.name : `${pipeline.name}-chain-${chainIndex}`;
		chainIndex++;

		if (agentTargets.length === 1) {
			result.set(subName, (agentTargets[0].data as AgentNodeData).sessionId);
			visited.add(agentTargets[0].id);
			buildSubAgentIdMapChain(agentTargets[0], pipeline.name, result, outgoing, nodeMap, visited);
			chainIndex = result.size;
		} else {
			// Fan-out: use first agent's ID for the subscription
			result.set(subName, (agentTargets[0].data as AgentNodeData).sessionId);
			for (const agent of agentTargets) visited.add(agent.id);
			for (const agent of agentTargets) {
				buildSubAgentIdMapChain(agent, pipeline.name, result, outgoing, nodeMap, visited);
			}
			chainIndex = result.size;
		}
	}

	return result;
}

function buildSubAgentIdMapChain(
	fromNode: PipelineNode,
	pipelineName: string,
	result: Map<string, string>,
	outgoing: Map<string, PipelineEdge[]>,
	nodeMap: Map<string, PipelineNode>,
	visited: Set<string>
): void {
	const fromOutgoing = outgoing.get(fromNode.id) ?? [];
	const targets = fromOutgoing
		.map((e) => nodeMap.get(e.target))
		.filter((n): n is PipelineNode => n != null && n.type === 'agent');

	for (const target of targets) {
		if (visited.has(target.id)) continue;
		visited.add(target.id);

		const subName = `${pipelineName}-chain-${result.size}`;
		result.set(subName, (target.data as AgentNodeData).sessionId);
		buildSubAgentIdMapChain(target, pipelineName, result, outgoing, nodeMap, visited);
	}
}

function buildSubAgentMapChain(
	fromNode: PipelineNode,
	pipelineName: string,
	result: Map<string, string>,
	outgoing: Map<string, PipelineEdge[]>,
	nodeMap: Map<string, PipelineNode>,
	visited: Set<string>
): void {
	const fromOutgoing = outgoing.get(fromNode.id) ?? [];
	const targets = fromOutgoing
		.map((e) => nodeMap.get(e.target))
		.filter((n): n is PipelineNode => n != null && n.type === 'agent');

	for (const target of targets) {
		if (visited.has(target.id)) continue;
		visited.add(target.id);

		const subName = `${pipelineName}-chain-${result.size}`;
		result.set(subName, (target.data as AgentNodeData).sessionName);
		buildSubAgentMapChain(target, pipelineName, result, outgoing, nodeMap, visited);
	}
}
