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
} from '../../../../shared/cue-pipeline-types';
import type { CueSubscription, CueSettings } from '../../../../main/cue/cue-types';

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

		// Map trigger config fields
		switch (triggerData.eventType) {
			case 'time.interval':
				if (triggerData.config.interval_minutes) {
					sub.interval_minutes = triggerData.config.interval_minutes;
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
			sub.prompt = agentData.inputPrompt ?? '';
			if (agentData.outputPrompt) sub.output_prompt = agentData.outputPrompt;
			// The target session is implicit (the session this YAML belongs to)
			// but we can note it for clarity
			subscriptions.push(sub);
			visited.add(agent.id);

			// Follow the chain from this agent
			buildChain(agent, pipeline.name, subscriptions, outgoing, incoming, nodeMap, visited);
			chainIndex = subscriptions.length;
		} else {
			// Fan-out: multiple targets from trigger
			sub.fan_out = agentTargets.map((a) => (a.data as AgentNodeData).sessionName);
			sub.prompt = (agentTargets[0].data as AgentNodeData).inputPrompt ?? '';
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

		const sub: CueSubscription = {
			name: subName,
			event: 'agent.completed',
			enabled: true,
			prompt: targetData.inputPrompt ?? '',
			output_prompt: targetData.outputPrompt || undefined,
		};

		if (incomingAgentEdges.length > 1) {
			// Fan-in: multiple source sessions
			sub.source_session = incomingAgentEdges
				.map((e) => {
					const src = nodeMap.get(e.source);
					return src ? (src.data as AgentNodeData).sessionName : '';
				})
				.filter(Boolean);
		} else {
			sub.source_session = fromAgentData.sessionName;
		}

		subscriptions.push(sub);

		// Continue the chain
		buildChain(target, pipelineName, subscriptions, outgoing, incoming, nodeMap, visited);
	}
}

/**
 * Converts pipeline graph state to YAML string.
 */
export function pipelinesToYaml(pipelines: CuePipeline[], settings?: Partial<CueSettings>): string {
	const allSubscriptions: Array<Record<string, unknown>> = [];
	const comments: string[] = [];

	for (const pipeline of pipelines) {
		// Pipeline metadata comment
		comments.push(`# Pipeline: ${pipeline.name} (color: ${pipeline.color})`);

		const subs = pipelineToYamlSubscriptions(pipeline);

		// Build edge mode map for annotation
		const edgeModeMap = new Map<string, PipelineEdge>();
		for (const edge of pipeline.edges) {
			// Key by source->target for lookup
			edgeModeMap.set(`${edge.source}->${edge.target}`, edge);
		}

		for (const sub of subs) {
			const record: Record<string, unknown> = {
				name: sub.name,
				event: sub.event,
			};

			if (sub.interval_minutes != null) record.interval_minutes = sub.interval_minutes;
			if (sub.watch != null) record.watch = sub.watch;
			if (sub.repo != null) record.repo = sub.repo;
			if (sub.poll_minutes != null) record.poll_minutes = sub.poll_minutes;
			if (sub.source_session != null) record.source_session = sub.source_session;
			if (sub.fan_out != null) record.fan_out = sub.fan_out;
			if (sub.filter != null) record.filter = sub.filter;

			// Handle prompt: inline if short, note file path if long
			if (sub.prompt) {
				if (sub.prompt.length < 500) {
					record.prompt = sub.prompt;
				} else {
					record.prompt = sub.prompt;
					comments.push(
						`# NOTE: Prompt for "${sub.name}" is ${sub.prompt.length} chars - consider saving to .maestro/prompts/${sub.name}.md`
					);
				}
			}

			if (sub.output_prompt) {
				record.output_prompt = sub.output_prompt;
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
	return header + yamlStr;
}
