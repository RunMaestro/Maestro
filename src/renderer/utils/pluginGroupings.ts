import {
	groupingRuleMatches,
	type GroupingContribution,
	type GroupingSessionMetadata,
} from '../../shared/plugins/contributions';

export interface VirtualGrouping {
	id: string;
	pluginId: string;
	pluginName?: string;
	localId: string;
	label?: string;
	rules?: GroupingContribution['rules'];
	groups?: Array<{ id: string; label: string; parentId?: string }>;
	assignments?: Record<string, string>;
}

export interface VirtualGroupingModel {
	groups: Array<{ id: string; name: string; parentGroupId?: string }>;
	assignments: Record<string, string>;
}

const virtualId = (groupingId: string, groupId: string): string =>
	`virtual:${groupingId}:${groupId}`;

/** Builds an ephemeral view model only; it deliberately has no access to session/group stores. */
export function buildVirtualGrouping(
	grouping: VirtualGrouping,
	sessions: readonly GroupingSessionMetadata[]
): VirtualGroupingModel {
	if (grouping.groups && grouping.assignments) {
		const groups = grouping.groups.map((group) => ({
			id: virtualId(grouping.id, group.id),
			name: group.label,
			...(group.parentId ? { parentGroupId: virtualId(grouping.id, group.parentId) } : {}),
		}));
		const validIds = new Set(groups.map((group) => group.id));
		return {
			groups,
			assignments: Object.fromEntries(
				Object.entries(grouping.assignments).flatMap(([sessionId, groupId]) => {
					const id = virtualId(grouping.id, groupId);
					return validIds.has(id) ? [[sessionId, id]] : [];
				})
			),
		};
	}

	const groups = new Map<string, { id: string; name: string; parentGroupId?: string }>();
	const assignments: Record<string, string> = {};
	for (const session of sessions) {
		const rule = grouping.rules?.find((candidate) => groupingRuleMatches(session, candidate));
		const label = rule?.group ?? 'Other';
		const id = virtualId(grouping.id, label);
		if (!groups.has(id)) {
			groups.set(id, {
				id,
				name: label,
				...(rule?.parentGroup ? { parentGroupId: virtualId(grouping.id, rule.parentGroup) } : {}),
			});
			if (rule?.parentGroup) {
				const parentId = virtualId(grouping.id, rule.parentGroup);
				if (!groups.has(parentId)) groups.set(parentId, { id: parentId, name: rule.parentGroup });
			}
		}
		assignments[session.id] = id;
	}
	return { groups: Array.from(groups.values()), assignments };
}
