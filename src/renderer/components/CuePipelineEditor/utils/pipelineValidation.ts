/**
 * pipelineValidation — Pure pipeline graph validation.
 *
 * Owns per-trigger config validation and graph-wide validation (disconnected agents,
 * missing prompts, cycle detection). No React state, no IPC — safe to use from
 * any context. Extracted from usePipelineState so the validation rules are
 * testable in isolation and reusable outside the hook.
 */

import type {
	CuePipeline,
	PipelineNode,
	TriggerNodeData,
	AgentNodeData,
	CommandNodeData,
	CueEventType,
} from '../../../../shared/cue-pipeline-types';

export const DEFAULT_TRIGGER_LABELS: Record<CueEventType, string> = {
	'app.startup': 'Startup',
	'time.heartbeat': 'Heartbeat',
	'time.scheduled': 'Scheduled',
	'file.changed': 'File Change',
	'agent.completed': 'Agent Done',
	'github.pull_request': 'Pull Request',
	'github.issue': 'Issue',
	'task.pending': 'Pending Task',
	'cli.trigger': 'CLI Trigger',
};

/**
 * Validate trigger node config against the YAML schema's per-event
 * requirements. Catches misconfigured triggers (e.g. a `time.scheduled`
 * trigger with no `schedule_times`) at SAVE time so they never hit disk —
 * otherwise the YAML loader rejects the whole file on next launch and
 * blocks valid pipelines belonging to other agents in the same project.
 */
function validateTriggerConfig(
	pipelineName: string,
	trigger: PipelineNode,
	errors: string[]
): void {
	const data = trigger.data as TriggerNodeData;
	const cfg = data.config ?? {};
	const label = data.customLabel ? `"${data.customLabel}"` : `${data.eventType}`;
	switch (data.eventType) {
		case 'time.heartbeat':
			if (
				typeof cfg.interval_minutes !== 'number' ||
				!Number.isFinite(cfg.interval_minutes) ||
				cfg.interval_minutes <= 0
			) {
				errors.push(`"${pipelineName}": ${label} trigger needs a positive interval (minutes)`);
			}
			break;
		case 'time.scheduled':
			if (!Array.isArray(cfg.schedule_times) || cfg.schedule_times.length === 0) {
				errors.push(
					`"${pipelineName}": ${label} trigger needs at least one schedule time (e.g. 09:00)`
				);
			}
			break;
		case 'file.changed':
			if (!cfg.watch || (typeof cfg.watch === 'string' && cfg.watch.trim().length === 0)) {
				errors.push(`"${pipelineName}": ${label} trigger needs a "watch" glob pattern`);
			}
			break;
		case 'task.pending':
			if (!cfg.watch || (typeof cfg.watch === 'string' && cfg.watch.trim().length === 0)) {
				errors.push(`"${pipelineName}": ${label} trigger needs a "watch" glob pattern`);
			}
			break;
		case 'github.pull_request':
		case 'github.issue':
			// repo is optional in the YAML schema (defaults to current repo via gh CLI)
			// but if provided it must be non-empty.
			if (
				cfg.repo !== undefined &&
				(typeof cfg.repo !== 'string' || cfg.repo.trim().length === 0)
			) {
				errors.push(
					`"${pipelineName}": ${label} trigger has an empty "repo" — leave blank or set "owner/repo"`
				);
			}
			break;
	}
}

/** Validates pipeline graph before save. Returns array of error messages. */
export function validatePipelines(pipelines: CuePipeline[]): string[] {
	const errors: string[] = [];

	for (const pipeline of pipelines) {
		const triggers = pipeline.nodes.filter((n) => n.type === 'trigger');
		const agents = pipeline.nodes.filter((n) => n.type === 'agent');
		const commands = pipeline.nodes.filter((n) => n.type === 'command');

		// Completely empty pipelines cannot be persisted (no subscriptions in YAML).
		// Silent-skipping them here led to saves that appeared to succeed but
		// wrote nothing to disk — flag them so the user gets clear feedback.
		if (triggers.length === 0 && agents.length === 0 && commands.length === 0) {
			errors.push(`"${pipeline.name}": add a trigger and an agent or command before saving`);
			continue;
		}

		if (triggers.length === 0) {
			errors.push(`"${pipeline.name}": needs at least one trigger`);
		}
		if (agents.length === 0 && commands.length === 0) {
			errors.push(`"${pipeline.name}": needs at least one agent or command`);
		}

		// Command-node configuration: each command must have an owning agent (the
		// "cwd/PATH" provider) and a non-empty body (shell or cli target). The
		// owning-agent requirement comes from the engine's subscription model —
		// `agent_id` binds the sub to a session, and commands without one can't
		// be dispatched. Surface this at save time so unbound nodes don't silently
		// disappear from YAML output.
		for (const command of commands) {
			const cmdData = command.data as CommandNodeData;
			const label = cmdData.name || 'command';
			if (!cmdData.owningSessionId) {
				errors.push(
					`"${pipeline.name}": command "${label}" needs an owning agent — pick one in the config panel`
				);
			}
			if (cmdData.mode === 'shell' && !cmdData.shell?.trim()) {
				errors.push(`"${pipeline.name}": command "${label}" is missing a shell command`);
			}
			if (cmdData.mode === 'cli' && !cmdData.cliTarget?.trim()) {
				errors.push(`"${pipeline.name}": command "${label}" is missing a target session`);
			}
		}

		for (const trigger of triggers) {
			validateTriggerConfig(pipeline.name, trigger, errors);
		}

		// Check for disconnected agents (no incoming edge)
		const targetsWithIncoming = new Set(pipeline.edges.map((e) => e.target));
		for (const agent of agents) {
			if (!targetsWithIncoming.has(agent.id)) {
				const name = (agent.data as AgentNodeData).sessionName;
				errors.push(`"${pipeline.name}": agent "${name}" has no incoming connection`);
			}
		}

		// Check agents have prompts configured.
		// An agent's prompt can live on the node (single trigger) or on incoming edges (multi-trigger).
		for (const agent of agents) {
			const agentData = agent.data as AgentNodeData;
			const incomingEdges = pipeline.edges.filter((e) => e.target === agent.id);
			const hasTriggerEdges = incomingEdges.some((e) => {
				const src = pipeline.nodes.find((n) => n.id === e.source);
				return src?.type === 'trigger';
			});

			if (hasTriggerEdges) {
				// Check: either the agent has a node-level prompt, or ALL incoming trigger edges have prompts
				const triggerEdges = incomingEdges.filter((e) => {
					const src = pipeline.nodes.find((n) => n.id === e.source);
					return src?.type === 'trigger';
				});
				const hasNodePrompt = !!agentData.inputPrompt?.trim();
				const allEdgesHavePrompts = triggerEdges.every((e) => e.prompt?.trim());
				if (!hasNodePrompt && !allEdgesHavePrompts) {
					const name = agentData.sessionName;
					errors.push(`"${pipeline.name}": agent "${name}" is missing a prompt`);
				}
			} else if (!agentData.inputPrompt?.trim() && agentData.includeUpstreamOutput === false) {
				// Chain agent with upstream output disabled — must have node-level prompt
				const name = agentData.sessionName;
				errors.push(`"${pipeline.name}": agent "${name}" is missing a prompt`);
			}
		}

		// Check for cycles via topological sort
		const adjList = new Map<string, string[]>();
		const inDegree = new Map<string, number>();
		for (const node of pipeline.nodes) {
			adjList.set(node.id, []);
			inDegree.set(node.id, 0);
		}
		for (const edge of pipeline.edges) {
			adjList.get(edge.source)?.push(edge.target);
			inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
		}
		const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
		let visited = 0;
		while (queue.length > 0) {
			const id = queue.shift()!;
			visited++;
			for (const neighbor of adjList.get(id) ?? []) {
				const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
				inDegree.set(neighbor, newDeg);
				if (newDeg === 0) queue.push(neighbor);
			}
		}
		if (visited < pipeline.nodes.length) {
			errors.push(`"${pipeline.name}": contains a cycle`);
		}
	}

	return errors;
}
