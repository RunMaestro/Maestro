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
	CueEventType,
	EdgeMode,
} from '../../../../shared/cue-pipeline-types';
import { getNextPipelineColor } from '../../../../shared/cue-pipeline-types';
import type { CueSubscription, CueGraphSession } from '../../../../main/cue/cue-types';
import type { SessionInfo } from '../../../../shared/types';

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
 * Groups subscriptions by their base pipeline name.
 * Maintains insertion order within each group.
 */
function groupSubscriptionsByPipeline(
	subscriptions: CueSubscription[]
): Map<string, CueSubscription[]> {
	const groups = new Map<string, CueSubscription[]>();

	for (const sub of subscriptions) {
		const baseName = getBasePipelineName(sub.name);
		const group = groups.get(baseName) ?? [];
		group.push(sub);
		groups.set(baseName, group);
	}

	return groups;
}

/**
 * Determines if a subscription is the initial trigger (not an agent.completed chain link).
 */
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
		case 'time.interval':
			if (sub.interval_minutes != null) config.interval_minutes = sub.interval_minutes;
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
		case 'time.interval':
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
		default:
			return 'Trigger';
	}
}

/**
 * Finds or creates an agent node, deduplicating by session name.
 */
function getOrCreateAgentNode(
	sessionName: string,
	sessions: SessionInfo[],
	nodeMap: Map<string, PipelineNode>,
	position: { x: number; y: number }
): PipelineNode {
	// Check if we already have a node for this session
	for (const [, node] of nodeMap) {
		if (node.type === 'agent' && (node.data as AgentNodeData).sessionName === sessionName) {
			return node;
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
	sessions: SessionInfo[]
): CuePipeline[] {
	const groups = groupSubscriptionsByPipeline(subscriptions);
	const pipelines: CuePipeline[] = [];

	for (const [baseName, subs] of groups) {
		const nodeMap = new Map<string, PipelineNode>();
		const edges: PipelineEdge[] = [];

		// Sort: initial triggers first, then chain subscriptions
		const sorted = [...subs].sort((a, b) => {
			const aIsInitial = isInitialTrigger(a) ? 0 : 1;
			const bIsInitial = isInitialTrigger(b) ? 0 : 1;
			return aIsInitial - bIsInitial;
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
						config: extractTriggerConfig(sub),
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

						// Set prompt on first fan-out target if present
						if (i === 0 && sub.prompt) {
							(agentNode.data as AgentNodeData).prompt = sub.prompt;
						}

						edges.push({
							id: `edge-${edgeCount++}`,
							source: triggerId,
							target: agentNode.id,
							mode: 'pass' as EdgeMode,
						});
					}
				} else {
					// Single target - infer target from subscription context
					// The target agent is the session this YAML config belongs to
					// We'll use the subscription name as a proxy for session name
					const targetSessionName = findTargetSession(sub, subs, sessions);
					if (targetSessionName) {
						const pos = {
							x: LAYOUT.firstAgentX,
							y: LAYOUT.baseY + (triggerCount - 1) * LAYOUT.verticalSpacing,
						};

						const agentNode = getOrCreateAgentNode(targetSessionName, sessions, nodeMap, pos);
						sessionToNode.set(targetSessionName, agentNode);
						sessionColumn.set(targetSessionName, 1);
						sessionRow.set(targetSessionName, triggerCount - 1);

						if (sub.prompt) {
							(agentNode.data as AgentNodeData).prompt = sub.prompt;
						}

						edges.push({
							id: `edge-${edgeCount++}`,
							source: triggerId,
							target: agentNode.id,
							mode: 'pass' as EdgeMode,
						});
					}
				}
			} else {
				// Chain subscription (agent.completed): connect source to target
				columnIndex++;
				const sourceSessions = Array.isArray(sub.source_session)
					? sub.source_session
					: sub.source_session
						? [sub.source_session]
						: [];

				// Find or create target agent node
				// Target is inferred from the next chain subscription or from session matching
				const targetSessionName = findTargetSession(sub, subs, sessions);
				if (!targetSessionName) continue;

				const targetCol = columnIndex;
				const existingRows = [...sessionColumn.entries()].filter(
					([, col]) => col === targetCol
				).length;

				const pos = {
					x: LAYOUT.firstAgentX + (targetCol - 1) * LAYOUT.stepSpacing,
					y: LAYOUT.baseY + existingRows * LAYOUT.verticalSpacing,
				};

				const targetNode = getOrCreateAgentNode(targetSessionName, sessions, nodeMap, pos);
				sessionToNode.set(targetSessionName, targetNode);
				sessionColumn.set(targetSessionName, targetCol);
				sessionRow.set(targetSessionName, existingRows);

				if (sub.prompt) {
					(targetNode.data as AgentNodeData).prompt = sub.prompt;
				}

				// Create edges from source(s) to target
				if (sourceSessions.length > 0) {
					for (const sourceSessionName of sourceSessions) {
						const sourceNode = sessionToNode.get(sourceSessionName);
						if (sourceNode) {
							edges.push({
								id: `edge-${edgeCount++}`,
								source: sourceNode.id,
								target: targetNode.id,
								mode: 'pass' as EdgeMode,
							});
						}
					}
				}
			}
		}

		const pipeline: CuePipeline = {
			id: `pipeline-${baseName}`,
			name: baseName,
			color: getNextPipelineColor(pipelines),
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
	sessions: SessionInfo[]
): string | null {
	// For chain subscriptions, the target is the session that the next chain link
	// references as source_session
	const baseName = getBasePipelineName(sub.name);
	const chainIndex = getChainIndex(sub.name);

	// Find the next chain link that has this subscription's target as its source
	for (const other of allSubs) {
		if (other === sub) continue;
		const otherBase = getBasePipelineName(other.name);
		const otherIndex = getChainIndex(other.name);

		if (otherBase === baseName && otherIndex === chainIndex + 1) {
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

	// Last resort: generate a name from the subscription name
	return `${baseName}-agent`;
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
	graphSessions: CueGraphSession[],
	allSessions: SessionInfo[]
): CuePipeline[] {
	// Collect all subscriptions across all graph sessions
	const allSubscriptions: CueSubscription[] = [];

	for (const gs of graphSessions) {
		for (const sub of gs.subscriptions) {
			allSubscriptions.push(sub);
		}
	}

	return subscriptionsToPipelines(allSubscriptions, allSessions);
}
