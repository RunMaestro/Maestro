import type { AgentDispatchFleetEventType } from '../../shared/agent-dispatch-types';
import type { WorkGraphBroadcastEnvelope } from '../../shared/work-graph-types';

export type AgentDispatchAutoPickupTrigger =
	| 'fleet-ready'
	| 'fleet-pickup-enabled'
	| 'fleet-claims-changed'
	| 'work-graph-ready-work-changed'
	| 'manual';

export const AUTO_PICKUP_FLEET_EVENTS: AgentDispatchFleetEventType[] = [
	'agentDispatch.agent.readinessChanged',
	'agentDispatch.agent.pickupChanged',
	'agentDispatch.agent.claimsChanged',
	'agentDispatch.fleet.changed',
];

const READY_WORK_GRAPH_OPERATIONS = new Set([
	'workGraph.item.created',
	'workGraph.item.updated',
	'workGraph.item.released',
	'workGraph.item.statusChanged',
	'workGraph.tags.updated',
]);

export function getAutoPickupTriggerForFleetEvent(
	type: AgentDispatchFleetEventType
): AgentDispatchAutoPickupTrigger | undefined {
	if (type === 'agentDispatch.agent.readinessChanged') {
		return 'fleet-ready';
	}
	if (type === 'agentDispatch.agent.pickupChanged') {
		return 'fleet-pickup-enabled';
	}
	if (type === 'agentDispatch.agent.claimsChanged') {
		return 'fleet-claims-changed';
	}
	if (type === 'agentDispatch.fleet.changed') {
		return 'fleet-ready';
	}
	return undefined;
}

export function isAutoPickupRelevantWorkGraphEvent(
	event: WorkGraphBroadcastEnvelope | undefined
): boolean {
	return !!event && READY_WORK_GRAPH_OPERATIONS.has(event.operation);
}
