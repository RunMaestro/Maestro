import type {
	AgentDispatchAssignmentDecision,
	AgentDispatchFleetEntry,
	WorkItem,
	WorkItemOwner,
} from '../../shared/agent-dispatch-types';
import { WORK_GRAPH_AGENT_READY_TAG } from '../../shared/agent-dispatch-types';
import { isDispatchReady } from './readiness';

export interface AgentDispatchAssignmentPolicyInput {
	workItems: WorkItem[];
	fleet: AgentDispatchFleetEntry[];
	maxAssignments?: number;
}

interface AgentCandidate {
	entry: AgentDispatchFleetEntry;
	remainingCapacity: number;
	projectedLoad: number;
}

export function selectAutoPickupAssignments(
	input: AgentDispatchAssignmentPolicyInput
): AgentDispatchAssignmentDecision[] {
	const maxAssignments = Math.max(0, Math.floor(input.maxAssignments ?? Number.MAX_SAFE_INTEGER));
	if (maxAssignments === 0) {
		return [];
	}

	const candidates = input.fleet
		.filter(isAgentEligibleForPickup)
		.map((entry) => ({
			entry,
			remainingCapacity: getRemainingCapacity(entry),
			projectedLoad: entry.currentLoad,
		}))
		.filter((candidate) => candidate.remainingCapacity > 0)
		.sort(compareAgentCandidates);

	const decisions: AgentDispatchAssignmentDecision[] = [];
	const workItems = [...input.workItems]
		.filter(isWorkItemEligibleForAutoPickup)
		.sort(compareWorkItems);

	for (const workItem of workItems) {
		if (decisions.length >= maxAssignments) {
			break;
		}

		const best = candidates
			.map((candidate) => ({
				candidate,
				overlap: getCapabilityOverlap(candidate.entry, workItem),
			}))
			.filter(
				({ candidate, overlap }) =>
					candidate.remainingCapacity > 0 &&
					overlap.length > 0 &&
					isAgentEligibleForRole(candidate.entry, workItem)
			)
			.sort((left, right) =>
				compareWorkAgentPair(left.candidate, left.overlap, right.candidate, right.overlap)
			)[0];

		if (!best) {
			continue;
		}

		decisions.push({
			agent: best.candidate.entry,
			workItem,
			owner: toWorkItemOwner(best.candidate.entry),
			capabilityOverlap: best.overlap,
			loadBeforeAssignment: best.candidate.projectedLoad,
			capacityBeforeAssignment: best.candidate.remainingCapacity,
		});
		best.candidate.projectedLoad += 1;
		best.candidate.remainingCapacity -= 1;
		candidates.sort(compareAgentCandidates);
	}

	return decisions;
}

export function isAgentEligibleForPickup(entry: AgentDispatchFleetEntry): boolean {
	return (
		entry.pickupEnabled &&
		isDispatchReady(entry.readiness) &&
		getRemainingCapacity(entry) > 0 &&
		entry.dispatchCapabilities.length > 0
	);
}

export function isWorkItemEligibleForAutoPickup(workItem: WorkItem): boolean {
	return (
		workItem.tags.includes(WORK_GRAPH_AGENT_READY_TAG) &&
		workItem.status !== 'archived' &&
		workItem.status !== 'canceled' &&
		workItem.status !== 'done' &&
		workItem.claim?.status !== 'active'
	);
}

function getRemainingCapacity(entry: AgentDispatchFleetEntry): number {
	// TODO #433: simplify under 4-slot model; maxConcurrentClaims is deprecated
	const maxConcurrentClaims = Math.max(1, Math.floor(entry.dispatchProfile.maxConcurrentClaims));
	return Math.max(0, maxConcurrentClaims - entry.currentLoad);
}

function getCapabilityOverlap(entry: AgentDispatchFleetEntry, workItem: WorkItem): string[] {
	const workCapabilities = new Set([
		...normalizeTags(workItem.tags),
		...normalizeTags(workItem.capabilities ?? []),
	]);
	return normalizeTags(entry.dispatchCapabilities).filter((capability) =>
		workCapabilities.has(capability)
	);
}

/**
 * Returns true when the agent satisfies the work item's pipeline role
 * requirement (#426).
 *
 * Rules:
 * - If the work item has no `pipeline` field → no role gate, always passes.
 * - If the agent's `dispatchProfile.roles` is empty / unset → agent opted out
 *   of role-gated items; fails.
 * - Otherwise, the agent must include `pipeline.currentRole` in its roles.
 */
export function isAgentEligibleForRole(
	entry: AgentDispatchFleetEntry,
	workItem: WorkItem
): boolean {
	if (!workItem.pipeline) {
		return true;
	}
	const agentRoles = entry.dispatchProfile.roles ?? [];
	return agentRoles.includes(workItem.pipeline.currentRole);
}

function compareWorkAgentPair(
	left: AgentCandidate,
	leftOverlap: string[],
	right: AgentCandidate,
	rightOverlap: string[]
): number {
	return (
		left.projectedLoad - right.projectedLoad ||
		rightOverlap.length - leftOverlap.length ||
		compareReadiness(left.entry.readiness, right.entry.readiness) ||
		compareTimestamp(left.entry.updatedAt, right.entry.updatedAt) ||
		left.entry.id.localeCompare(right.entry.id)
	);
}

function compareAgentCandidates(left: AgentCandidate, right: AgentCandidate): number {
	return (
		left.projectedLoad - right.projectedLoad ||
		compareReadiness(left.entry.readiness, right.entry.readiness) ||
		compareTimestamp(left.entry.updatedAt, right.entry.updatedAt) ||
		left.entry.id.localeCompare(right.entry.id)
	);
}

function compareWorkItems(left: WorkItem, right: WorkItem): number {
	return (
		(right.priority ?? 0) - (left.priority ?? 0) ||
		compareTimestamp(left.createdAt, right.createdAt) ||
		left.id.localeCompare(right.id)
	);
}

function compareReadiness(
	left: AgentDispatchFleetEntry['readiness'],
	right: AgentDispatchFleetEntry['readiness']
): number {
	const rank = new Map([
		['idle', 0],
		['ready', 1],
	]);
	return (rank.get(left) ?? 99) - (rank.get(right) ?? 99);
}

function compareTimestamp(left: string | undefined, right: string | undefined): number {
	return (
		Date.parse(left ?? '') - Date.parse(right ?? '') || (left ?? '').localeCompare(right ?? '')
	);
}

function toWorkItemOwner(entry: AgentDispatchFleetEntry): WorkItemOwner {
	return {
		type: 'agent',
		id: entry.id,
		name: entry.displayName,
		agentId: entry.agentId,
		providerSessionId: entry.providerSessionId,
		capabilities: entry.dispatchCapabilities,
	};
}

function normalizeTags(tags: string[]): string[] {
	return [
		...new Set(
			tags
				.map((tag) =>
					tag
						.trim()
						.toLowerCase()
						.replace(/[^a-z0-9]+/g, '-')
						.replace(/^-+|-+$/g, '')
				)
				.filter(Boolean)
		),
	].sort();
}
